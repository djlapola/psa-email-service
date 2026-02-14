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

const MAX_WEBHOOK_RETRIES = 3;
const WEBHOOK_TIMEOUT = 10000; // 10 seconds

export class WebhookService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Send webhook notifications to CP and PSA
   */
  async notifyEmailEvent(event: EmailEvent): Promise<void> {
    const webhookUrls: string[] = [];

    // Control Plane webhook
    if (process.env.CONTROL_PLANE_WEBHOOK_URL) {
      webhookUrls.push(process.env.CONTROL_PLANE_WEBHOOK_URL);
    }

    // PSA webhook
    if (process.env.PSA_WEBHOOK_URL) {
      webhookUrls.push(process.env.PSA_WEBHOOK_URL);
    }

    // Only send webhooks for important events
    const notifyableEvents = ['email.bounced', 'email.complained', 'email.failed'];
    if (!notifyableEvents.includes(event.event)) {
      return;
    }

    for (const url of webhookUrls) {
      await this.sendWebhook(url, event);
    }
  }

  /**
   * Send a webhook to a specific URL with retry logic
   */
  private async sendWebhook(url: string, event: EmailEvent): Promise<void> {
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

    await this.attemptWebhookDelivery(delivery.id, url, event);
  }

  /**
   * Attempt to deliver a webhook with retries
   */
  private async attemptWebhookDelivery(
    deliveryId: string,
    url: string,
    event: EmailEvent,
    attempt = 1
  ): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Email-Service-Event': event.event,
          'X-Email-Service-Signature': this.generateSignature(event),
        },
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
          this.attemptWebhookDelivery(deliveryId, url, event, attempt + 1);
        }, delay);
      } else {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'failed' },
        });
        console.error(`Webhook permanently failed for ${url}: ${event.event}`);
      }
    }
  }

  /**
   * Generate a simple signature for webhook verification
   */
  private generateSignature(event: EmailEvent): string {
    const crypto = require('crypto');
    const secret = process.env.EMAIL_SERVICE_API_KEY || 'default-secret';
    return crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(event))
      .digest('hex');
  }
}

export function createWebhookService(prisma: PrismaClient): WebhookService {
  return new WebhookService(prisma);
}
