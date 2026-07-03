import sgClient from '@sendgrid/client';
import { PrismaClient } from '@prisma/client';
import { createDomainService } from './domain.service';
import { createWebhookService, DomainHealthFailingRecord } from './webhook.service';

sgClient.setApiKey(process.env.SENDGRID_API_KEY || '');

// A domain is only considered "stuck" (and re-alertable) once it has been in its
// current state for this long — also the minimum gap between repeat alerts.
const STALE_MS = 24 * 60 * 60 * 1000; // 24h

type DomainService = ReturnType<typeof createDomainService>;
type WebhookService = ReturnType<typeof createWebhookService>;

interface ValidationState {
  valid: boolean;
  failingRecords: DomainHealthFailingRecord[];
}

/**
 * Background domain-health job.
 *
 * Two sweeps, both best-effort and per-tenant isolated (one tenant's error never
 * aborts the sweep, and the sweep never crashes the service):
 *
 *   A. PENDING — unverified domains: re-run verifyDomain(); if it flips to verified,
 *      log recovery; if still unverified for >24h and not recently alerted, emit
 *      domain.health {status:'unverified'} to CP.
 *
 *   B. DRIFT — verified domains: re-validate against SendGrid; if any authenticated
 *      record now reports valid=false, flip domainVerified=false (so it becomes a
 *      Sweep-A candidate next time → drift emits exactly once) and emit
 *      domain.health {status:'drift'} to CP with the expected records to recreate.
 */
export class DomainHealthService {
  private prisma: PrismaClient;
  private domainService: DomainService;
  private webhookService: WebhookService;

  constructor(prisma: PrismaClient, domainService: DomainService, webhookService: WebhookService) {
    this.prisma = prisma;
    this.domainService = domainService;
    this.webhookService = webhookService;
  }

  async runDomainHealthSweep(): Promise<void> {
    console.log('[DomainHealth] Starting domain health sweep');
    try {
      await this.sweepPending();
    } catch (err: any) {
      console.error('[DomainHealth] Pending sweep aborted:', err?.message || err);
    }
    try {
      await this.sweepDrift();
    } catch (err: any) {
      console.error('[DomainHealth] Drift sweep aborted:', err?.message || err);
    }
    console.log('[DomainHealth] Domain health sweep complete');
  }

  /**
   * SWEEP A — try to push unverified domains to verified; alert on the stuck ones.
   */
  private async sweepPending(): Promise<void> {
    const configs = await this.prisma.tenantEmailConfig.findMany({
      where: { domainVerified: false, sendgridDomainId: { not: null } },
    });
    console.log(`[DomainHealth] Sweep A (pending): ${configs.length} unverified domain(s)`);

    const now = Date.now();

    for (const config of configs) {
      try {
        const result = await this.domainService.verifyDomain(config.tenantId);
        if (result.status === 'verified') {
          console.log(`[DomainHealth] Recovered: ${config.domain} (${config.tenantId}) is now verified`);
          continue;
        }

        // Still unverified. Gate on createdAt (stable provisioning time) — NOT updatedAt,
        // which verifyDomain() bumps every sweep and would keep the row perpetually "fresh".
        // Fire only if it has failed to verify for >24h AND wasn't alerted within the last 24h.
        const stuckLongEnough = now - config.createdAt.getTime() >= STALE_MS;
        const alertedRecently =
          config.lastHealthAlertAt != null &&
          now - config.lastHealthAlertAt.getTime() < STALE_MS;

        if (!stuckLongEnough || alertedRecently) continue;

        const state = await this.fetchValidationState(config.sendgridDomainId!);
        const failingRecords = state?.failingRecords ?? [];

        await this.emit(config, 'unverified', failingRecords);
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId: config.tenantId },
          data: { lastHealthAlertAt: new Date() },
        });
      } catch (err: any) {
        console.error(`[DomainHealth] Pending check failed for ${config.tenantId} (${config.domain}):`, err?.message || err);
      }
    }
  }

  /**
   * SWEEP B — detect DNS drift on domains that were previously verified.
   */
  private async sweepDrift(): Promise<void> {
    const configs = await this.prisma.tenantEmailConfig.findMany({
      where: { domainVerified: true, sendgridDomainId: { not: null } },
    });
    console.log(`[DomainHealth] Sweep B (drift): ${configs.length} verified domain(s)`);

    for (const config of configs) {
      try {
        const state = await this.fetchValidationState(config.sendgridDomainId!);
        if (!state) continue;                      // SendGrid error — stay verified, best-effort
        if (state.failingRecords.length === 0) continue; // still healthy

        // DRIFT. Flip to unverified FIRST so the alert fires exactly once: on the next
        // sweep this row is a Sweep-A candidate, gated by the fresh updatedAt + lastHealthAlertAt.
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId: config.tenantId },
          data: { domainVerified: false, lastHealthAlertAt: new Date() },
        });

        await this.emit(config, 'drift', state.failingRecords);
        console.warn(`[DomainHealth] DRIFT: ${config.domain} (${config.tenantId}) — ${state.failingRecords.length} record(s) invalid`);
      } catch (err: any) {
        console.error(`[DomainHealth] Drift check failed for ${config.tenantId} (${config.domain}):`, err?.message || err);
      }
    }
  }

  /**
   * Re-validate a SendGrid whitelabel domain and build the list of failing records.
   *
   * Uses the SAME validate endpoint verifyDomain() uses for per-record valid + reason,
   * then GETs the whitelabel domain for the EXPECTED host/value of each record.
   * SendGrid is the durable source of truth: its `dns` object still holds what the
   * records SHOULD be even after they were deleted/changed in Cloudflare.
   */
  private async fetchValidationState(sendgridDomainId: string): Promise<ValidationState | null> {
    try {
      // 1. validation_results → per-record { valid, reason }
      const [, validateBody] = await sgClient.request({
        method: 'POST',
        url: `/v3/whitelabel/domains/${sendgridDomainId}/validate`,
      });
      const validation = validateBody as any;
      const validationResults = validation.validation_results || {};

      // 2. dns → per-record expected { type, host, data }
      const [, domainBody] = await sgClient.request({
        method: 'GET',
        url: `/v3/whitelabel/domains/${sendgridDomainId}`,
      });
      const dns = (domainBody as any).dns || {};

      const failingRecords: DomainHealthFailingRecord[] = [];
      for (const key of Object.keys(validationResults)) {
        const vr = validationResults[key] || {};
        if (vr.valid === false) {
          const expected = dns[key] || {};
          failingRecords.push({
            recordType: (expected.type || 'cname').toUpperCase(),
            host: expected.host || vr.host || key,
            value: expected.data || '',
            reason: vr.reason || 'DNS record missing or does not match the expected value',
          });
        }
      }

      return { valid: validation.valid === true, failingRecords };
    } catch (err: any) {
      console.error(`[DomainHealth] SendGrid validation failed for domain ${sendgridDomainId}:`, err?.response?.body || err?.message || err);
      return null;
    }
  }

  /**
   * Emit a domain.health event to CP via the existing signed webhook emitter.
   * tenantId is the PSA tenant id (tenant_email_configs.tenantId), which CP resolves
   * via `where: { psaTenantId }`.
   */
  private async emit(
    config: { tenantId: string; domain: string | null },
    status: 'unverified' | 'drift',
    failingRecords: DomainHealthFailingRecord[],
  ): Promise<void> {
    const domain = config.domain || '';
    const subdomain = domain.split('.')[0] || domain;

    const message =
      status === 'drift'
        ? `DNS drift detected for ${domain}: ${failingRecords.length} authenticated record(s) no longer match SendGrid's expected values. Outbound email for this tenant is broken until they are recreated.`
        : `Domain ${domain} has been stuck unverified for over 24h with ${failingRecords.length} failing DNS record(s).`;

    await this.webhookService.notifyDomainHealth({
      type: 'domain.health',
      tenantId: config.tenantId,
      subdomain,
      domain,
      status,
      failingRecords,
      message,
    });
  }
}

export function createDomainHealthService(
  prisma: PrismaClient,
  domainService: DomainService,
  webhookService: WebhookService,
): DomainHealthService {
  return new DomainHealthService(prisma, domainService, webhookService);
}
