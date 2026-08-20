import { PrismaClient } from '@prisma/client';

export interface EmailEvent {
  event: 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.failed';
  emailId: string;
  to: string;
  tenantId?: string;
  template?: string;
  reason?: string;
  error?: string;
  messageId?: string;
}

export interface DomainHealthFailingRecord {
  recordType: string;  // e.g. CNAME / TXT / MX
  host: string;        // expected DNS host (from SendGrid whitelabel dns object)
  value: string;       // expected DNS value (from SendGrid whitelabel dns object)
  reason: string;      // why the record is failing (from SendGrid validation_results)
}

/**
 * Emitted to Control Plane when the domain-health sweep detects a domain that is
 * stuck unverified ('unverified') or whose authenticated DNS records drifted ('drift').
 * CP resolves the alert tenant by `psaTenantId`, so `tenantId` MUST be the PSA tenant id.
 */
export interface DomainHealthEvent {
  type: 'domain.health';
  tenantId: string;    // PSA tenant id (tenant_email_configs.tenantId)
  subdomain: string;
  domain: string;
  owner: 'skyrack' | 'byod';   // 'skyrack' = {sub}.skyrack.com (we own the DNS in Cloudflare); 'byod' = tenant's own domain at their registrar
  status: 'unverified' | 'drift' | 'recovered';
  failingRecords: DomainHealthFailingRecord[];
  message: string;
}

/**
 * Emitted to Control Plane when a webhook delivery to a target (CP or PSA) exhausts all
 * MAX_WEBHOOK_RETRIES and is permanently marked status='failed'. Without this, a dead
 * target silently accumulates 'failed' rows and nobody is told — exactly how a month-long
 * PSA outage (every bounce webhook rejected `400 events array is required`) went unnoticed.
 *
 * Carries precisely what CP's AlertsService.createWebhookFailureAlert(webhookUrl, error,
 * eventType, tenantInfo?) needs to raise a `webhook_failed` operator alert. CP resolves the
 * tenant by psaTenantId (same as domain.health), so `tenantId` (when known) MUST be the PSA
 * tenant id carried on the original EmailEvent.
 */
export interface WebhookFailureEvent {
  type: 'webhook.delivery_failed';
  targetUrl: string;   // the unreachable webhook target        (→ createWebhookFailureAlert webhookUrl)
  eventType: string;   // the email event that failed to deliver (→ createWebhookFailureAlert eventType), e.g. 'email.bounced'
  error: string;       // last error recorded on the delivery   (→ createWebhookFailureAlert error)
  tenantId?: string;   // PSA tenant id, if the failed event carried one (CP resolves tenantInfo from this)
}

const MAX_WEBHOOK_RETRIES = 3;
const WEBHOOK_TIMEOUT = 30000; // 30 seconds (CP scales to zero; this webhook is nearly its only traffic, so it reliably hits a cold container)

export class WebhookService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Send webhook notifications to CP and PSA
   */
  async notifyEmailEvent(event: EmailEvent): Promise<void> {
    const webhookTargets: Array<{ url: string; isPsa: boolean }> = [];

    // Control Plane webhook
    if (process.env.CONTROL_PLANE_WEBHOOK_URL) {
      webhookTargets.push({ url: process.env.CONTROL_PLANE_WEBHOOK_URL, isPsa: false });
    }

    // PSA webhook — construct from PSA_INTERNAL_API_URL to target the correct endpoint
    const psaBaseUrl = process.env.PSA_INTERNAL_API_URL;
    if (psaBaseUrl) {
      webhookTargets.push({ url: `${psaBaseUrl}/email-events`, isPsa: true });
    }

    // Only send webhooks for important events
    const notifyableEvents = ['email.bounced', 'email.complained', 'email.failed'];
    if (!notifyableEvents.includes(event.event)) {
      return;
    }

    for (const target of webhookTargets) {
      await this.sendWebhook(target.url, event, target.isPsa);
    }
  }

  /**
   * Send a webhook to a specific URL with retry logic
   */
  private async sendWebhook(url: string, event: EmailEvent, isPsa = false): Promise<void> {
    // Create delivery record
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        emailLogId: event.emailId,
        targetUrl: url,
        event: event.event,
        payload: event as object,
        status: 'pending',
      },
    });

    await this.attemptWebhookDelivery(delivery.id, url, event, 1, isPsa);
  }

  /**
   * Attempt to deliver a webhook with retries
   */
  private async attemptWebhookDelivery(
    deliveryId: string,
    url: string,
    event: EmailEvent,
    attempt = 1,
    isPsa = false,
  ): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Email-Service-Event': event.event,
        'X-Email-Service-Signature': this.generateSignature(event),
      };

      // Include auth header for PSA-bound webhooks
      if (isPsa && process.env.PSA_INTERNAL_API_KEY) {
        headers['X-Internal-API-Key'] = process.env.PSA_INTERNAL_API_KEY;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'sent',
            attempts: attempt,
            sentAt: new Date(),
          },
        });
        console.log(`Webhook delivered to ${url}: ${event.event}`);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Webhook delivery failed (attempt ${attempt}/${MAX_WEBHOOK_RETRIES}):`, errorMessage);

      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          attempts: attempt,
          lastError: errorMessage,
        },
      });

      // Retry if attempts remaining
      if (attempt < MAX_WEBHOOK_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        setTimeout(() => {
          this.attemptWebhookDelivery(deliveryId, url, event, attempt + 1, isPsa);
        }, delay);
      } else {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'failed' },
        });
        console.error(`Webhook permanently failed for ${url}: ${event.event}`);

        // Tell Control Plane a delivery is permanently dead so it doesn't hide the way the
        // PSA bounce-webhook outage did. Fire-and-forget and fully isolated: notifyWebhookFailure
        // catches internally and never rejects; the trailing .catch() is belt-and-suspenders so a
        // failure to REPORT a failure only logs — it can never cascade back into the delivery path
        // or block notifyEmailEvent's send loop while a dead target burns through its own retries.
        void this.notifyWebhookFailure({
          type: 'webhook.delivery_failed',
          targetUrl: url,
          eventType: event.event,
          error: errorMessage,
          tenantId: event.tenantId,
        }).catch((emitErr) => {
          const m = emitErr instanceof Error ? emitErr.message : String(emitErr);
          console.error(`[Webhook] Failed to report permanent webhook failure for ${url}: ${m}`);
        });
      }
    }
  }

  /**
   * Emit a domain.health anomaly to Control Plane, reusing the existing signed-POST
   * pattern (HMAC-SHA256 signature + X-Email-Service-* headers). Best-effort with the
   * same retry/backoff as email events; never throws.
   */
  async notifyDomainHealth(event: DomainHealthEvent): Promise<boolean> {
    const url = process.env.CONTROL_PLANE_WEBHOOK_URL;
    if (!url) {
      console.warn('[Webhook] CONTROL_PLANE_WEBHOOK_URL not set; skipping domain.health emit');
      return false;
    }

    for (let attempt = 1; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Email-Service-Event': event.type,
            'X-Email-Service-Signature': this.generateSignature(event),
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`[Webhook] domain.health (${event.status}) delivered to CP for ${event.domain}`);
          return true;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        const kind = isAbort ? `TIMEOUT after ${WEBHOOK_TIMEOUT}ms` : 'HTTP_ERROR';
        console.error(`[Webhook] domain.health delivery failed [${kind}] (attempt ${attempt}/${MAX_WEBHOOK_RETRIES}) for ${event.domain}: ${errorMessage}`);
        if (attempt < MAX_WEBHOOK_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[Webhook] domain.health permanently failed for ${event.domain}`);
        }
      }
    }
    return false;
  }

  /**
   * Report a permanently-failed webhook delivery to Control Plane. Deliberate mirror of
   * notifyDomainHealth: same signed-POST channel (CONTROL_PLANE_WEBHOOK_URL), same HMAC-SHA256
   * signature + X-Email-Service-* headers, same MAX_WEBHOOK_RETRIES / exponential backoff /
   * timeout, same best-effort contract (never throws; returns whether CP acknowledged).
   *
   * Intentionally does NOT dedupe here. The mirrored domain.health emitter emits every sweep and
   * lets CP collapse duplicates, and this emitter is a stateless sensor with no view of what alerts
   * already exist in CP (and its in-memory state would be lost on restart / uncoordinated across
   * instances anyway). Dedup belongs on the CP receiver, exactly like the domain.health handler,
   * which skips when an unresolved same-type alert already exists before calling createAlert.
   */
  async notifyWebhookFailure(event: WebhookFailureEvent): Promise<boolean> {
    const url = process.env.CONTROL_PLANE_WEBHOOK_URL;
    if (!url) {
      console.warn('[Webhook] CONTROL_PLANE_WEBHOOK_URL not set; skipping webhook-failure emit');
      return false;
    }

    for (let attempt = 1; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Email-Service-Event': event.type,
            'X-Email-Service-Signature': this.generateSignature(event),
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`[Webhook] webhook-failure (${event.eventType} → ${event.targetUrl}) reported to CP`);
          return true;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const isAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        const kind = isAbort ? `TIMEOUT after ${WEBHOOK_TIMEOUT}ms` : 'HTTP_ERROR';
        console.error(`[Webhook] webhook-failure report failed [${kind}] (attempt ${attempt}/${MAX_WEBHOOK_RETRIES}) to CP for ${event.targetUrl}: ${errorMessage}`);
        if (attempt < MAX_WEBHOOK_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[Webhook] webhook-failure report permanently failed for target ${event.targetUrl}`);
        }
      }
    }
    return false;
  }

  /**
   * Generate a simple signature for webhook verification
   */
  private generateSignature(event: EmailEvent | DomainHealthEvent | WebhookFailureEvent): string {
    const crypto = require('crypto');
    const secret = process.env.EMAIL_SERVICE_WEBHOOK_SECRET || 'default-secret';
    return crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(event))
      .digest('hex');
  }
}

export function createWebhookService(prisma: PrismaClient): WebhookService {
  return new WebhookService(prisma);
}
