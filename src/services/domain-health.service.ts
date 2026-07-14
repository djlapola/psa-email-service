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
 * Four sweeps, all best-effort and per-tenant isolated (one tenant's error never
 * aborts the sweep, and the sweep never crashes the service):
 *
 *   A. PENDING — unverified skyrack subdomains (tenant_email_configs): re-run
 *      verifyDomain(); if it flips to verified, log recovery; if still unverified for
 *      >24h and not recently alerted, emit domain.health {status:'unverified'} to CP.
 *
 *   B. DRIFT — verified skyrack subdomains (tenant_email_configs): re-validate against
 *      SendGrid; if any authenticated record now reports valid=false, flip
 *      domainVerified=false (so it becomes a Sweep-A candidate next time → drift emits
 *      exactly once) and emit domain.health {status:'drift', owner:'skyrack'} to CP.
 *
 *   C. BYOD DRIFT — verified custom domains (tenant_email_domains): re-validate against
 *      SendGrid; if any record drifted, flip status='failed' (removing it from BYOD
 *      send selection), write per-record valid/reason flags so the tenant UI can show
 *      which records failed without a manual verify, and emit domain.health
 *      {status:'drift', owner:'byod'} to CP.
 *
 *   D. BYOD RECOVERY — failed custom domains (tenant_email_domains): re-validate against
 *      SendGrid; if fully valid again, flip status back to 'verified', clear the alert
 *      timestamp, and mark every record valid. Runs AFTER Sweep C (disjoint status
 *      queries) so a same-cycle drift-then-fix cannot flip a row twice.
 *
 * lastHealthAlertAt is written only when the emit is confirmed delivered, so a failed
 * webhook never suppresses the next sweep's alert.
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
    try {
      await this.sweepByodDrift();
    } catch (err: any) {
      console.error('[DomainHealth] BYOD drift sweep aborted:', err?.message || err);
    }
    try {
      await this.sweepByodRecovery();
    } catch (err: any) {
      console.error('[DomainHealth] BYOD recovery sweep aborted:', err?.message || err);
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
          // Only act if this row was actually alerted (drift/unverified) earlier.
          if (config.lastHealthAlertAt != null) {
            const ok = await this.emit(
              {
                tenantId: config.tenantId,
                domain: config.domain || '',
                subdomain: (config.domain || '').split('.')[0],
                owner: 'skyrack',
              },
              'recovered',
              [],
            );
            if (!ok) {
              console.warn(`[DomainHealth] Recovery emit failed for ${config.tenantId} (${config.domain}); clearing local alert anyway`);
            }
            // Clear regardless of emit success: the recovery is real locally, and this
            // prevents re-emitting recovered every sweep / suppressing a future drift.
            await this.prisma.tenantEmailConfig.update({
              where: { tenantId: config.tenantId },
              data: { lastHealthAlertAt: null },
            });
          }
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

        const ok = await this.emit(
          {
            tenantId: config.tenantId,
            domain: config.domain || '',
            subdomain: (config.domain || '').split('.')[0],
            owner: 'skyrack',
          },
          'unverified',
          failingRecords,
        );
        if (ok) {
          await this.prisma.tenantEmailConfig.update({
            where: { tenantId: config.tenantId },
            data: { lastHealthAlertAt: new Date() },
          });
        }
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
          data: { domainVerified: false },
        });

        const ok = await this.emit(
          {
            tenantId: config.tenantId,
            domain: config.domain || '',
            subdomain: (config.domain || '').split('.')[0],
            owner: 'skyrack',
          },
          'drift',
          state.failingRecords,
        );
        // Only mark as alerted if the emit actually landed. A failed emit must NOT set
        // lastHealthAlertAt, or Sweep A suppresses it for 24h and the operator never sees it.
        if (ok) {
          await this.prisma.tenantEmailConfig.update({
            where: { tenantId: config.tenantId },
            data: { lastHealthAlertAt: new Date() },
          });
        }
        console.warn(`[DomainHealth] DRIFT: ${config.domain} (${config.tenantId}) — ${state.failingRecords.length} record(s) invalid`);
      } catch (err: any) {
        console.error(`[DomainHealth] Drift check failed for ${config.tenantId} (${config.domain}):`, err?.message || err);
      }
    }
  }

  /**
   * SWEEP C — detect DNS drift on BYOD custom domains (tenant_email_domains) that were
   * previously verified. Unlike Sweep B these records live at the tenant's own registrar,
   * so on drift we flip status to 'failed' (which removes them from getTenantEmailConfig's
   * BYOD selection, falling sending back to the subdomain) and alert once.
   */
  private async sweepByodDrift(): Promise<void> {
    const rows = await this.prisma.tenantEmailDomain.findMany({
      where: { status: 'verified', sendgridDomainId: { not: null } },
    });
    console.log(`[DomainHealth] Sweep C (byod): ${rows.length} verified custom domain(s)`);

    for (const row of rows) {
      try {
        const state = await this.fetchValidationState(row.sendgridDomainId!);
        if (!state) continue;                       // SendGrid error — best-effort, stay verified
        if (state.failingRecords.length === 0) continue;

        // Build per-record flags so the tenant UI shows WHICH records failed and why,
        // without the tenant having to run a manual verify. Match on host.
        const existingRecords = Array.isArray(row.dnsRecords) ? (row.dnsRecords as any[]) : [];
        const updatedRecords = existingRecords.map(record => {
          const failing = state.failingRecords.find(f => f.host === record.host);
          if (failing) {
            return { ...record, valid: false, reason: failing.reason };
          }
          const { reason, ...rest } = record;
          return { ...rest, valid: true };
        });

        // DRIFT. Flip status first so it stops being used for sending; write the
        // per-record flags in the same update.
        await this.prisma.tenantEmailDomain.update({
          where: { id: row.id },
          data: { status: 'failed', dnsRecords: updatedRecords },
        });

        const ok = await this.emit(
          { tenantId: row.tenantId, domain: row.domain, subdomain: row.domain, owner: 'byod' },
          'drift',
          state.failingRecords,
        );
        // Second, additive notification to PSA (tenant admins) — rides the same drift
        // trigger as the CP emit. Best-effort; never blocks the CP emit or the sweep.
        await this.notifyPsaDomainEvent(
          row.tenantId,
          row.domain,
          'failed',
          state.failingRecords.map(r => r.host),
        );
        if (ok) {
          await this.prisma.tenantEmailDomain.update({
            where: { id: row.id },
            data: { lastHealthAlertAt: new Date() },
          });
          console.warn(`[DomainHealth] BYOD DRIFT: ${row.domain} (${row.tenantId}) — ${state.failingRecords.length} record(s) invalid`);
        } else {
          console.warn(`[DomainHealth] BYOD DRIFT: ${row.domain} (${row.tenantId}) — ${state.failingRecords.length} record(s) invalid, but CP emit failed`);
        }
      } catch (err: any) {
        console.error(`[DomainHealth] BYOD drift check failed for ${row.tenantId} (${row.domain}):`, err?.message || err);
      }
    }
  }

  /**
   * SWEEP D — recover BYOD custom domains that previously drifted to 'failed'. Re-validate
   * against SendGrid; if fully valid again, flip status back to 'verified', clear the alert
   * timestamp, and mark every record valid so the tenant UI shows an all-green table.
   *
   * Runs AFTER Sweep C: Sweep C queries status='verified' and Sweep D queries
   * status='failed', so a domain that drifts and is fixed within the same cycle cannot be
   * acted on by both passes.
   */
  private async sweepByodRecovery(): Promise<void> {
    const rows = await this.prisma.tenantEmailDomain.findMany({
      where: { status: 'failed', sendgridDomainId: { not: null } },
    });
    console.log(`[DomainHealth] Sweep D (byod recovery): ${rows.length} failed custom domain(s)`);

    for (const row of rows) {
      try {
        const state = await this.fetchValidationState(row.sendgridDomainId!);
        if (!state) continue;                       // SendGrid error — stay failed
        if (!state.valid) continue;                 // still broken

        // RECOVERED — every record is valid again; clear any per-record reason.
        const existingRecords = Array.isArray(row.dnsRecords) ? (row.dnsRecords as any[]) : [];
        const updatedRecords = existingRecords.map(record => {
          const { reason, ...rest } = record;
          return { ...rest, valid: true };
        });

        await this.prisma.tenantEmailDomain.update({
          where: { id: row.id },
          data: {
            status: 'verified',
            verifiedAt: new Date(),
            lastVerifiedAt: new Date(),
            lastHealthAlertAt: null,
            dnsRecords: updatedRecords,
          },
        });
        console.log(`[DomainHealth] BYOD RECOVERED: ${row.domain} (${row.tenantId})`);

        // Notify CP so it can auto-resolve the open alert. Recovery has already
        // persisted above; a failed emit must not undo it.
        const ok = await this.emit(
          { tenantId: row.tenantId, domain: row.domain, subdomain: row.domain, owner: 'byod' },
          'recovered',
          [],
        );
        // Second, additive notification to PSA (tenant admins) — rides the same recovery
        // trigger as the CP emit. Best-effort; never blocks the CP emit or the sweep.
        await this.notifyPsaDomainEvent(row.tenantId, row.domain, 'recovered');
        if (!ok) {
          console.warn(`[DomainHealth] BYOD RECOVERED: ${row.domain} (${row.tenantId}) — but CP emit failed`);
        }
      } catch (err: any) {
        console.error(`[DomainHealth] BYOD recovery check failed for ${row.tenantId} (${row.domain}):`, err?.message || err);
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
    args: { tenantId: string; domain: string; subdomain: string; owner: 'skyrack' | 'byod' },
    status: 'unverified' | 'drift' | 'recovered',
    failingRecords: DomainHealthFailingRecord[],
  ): Promise<boolean> {
    const { tenantId, domain, subdomain, owner } = args;

    let message: string;
    if (status === 'recovered') {
      message = `DNS records for ${domain} are valid again.`;
    } else if (status === 'drift') {
      message =
        owner === 'byod'
          ? `DNS drift detected for ${domain}: ${failingRecords.length} authenticated record(s) no longer match SendGrid's expected values. These records must be corrected at the tenant's own DNS provider (not Cloudflare); until they are, mail from this domain may be marked as spam.`
          : `DNS drift detected for ${domain}: ${failingRecords.length} authenticated record(s) no longer match SendGrid's expected values. Outbound email for this tenant is broken until they are recreated.`;
    } else {
      message = `Domain ${domain} has been stuck unverified for over 24h with ${failingRecords.length} failing DNS record(s).`;
    }

    return this.webhookService.notifyDomainHealth({
      type: 'domain.health',
      tenantId,
      subdomain,
      domain,
      owner,
      status,
      failingRecords,
      message,
    });
  }

  /**
   * Notify PSA of a BYOD custom-domain transition so PSA can email the tenant's admins.
   * This is a SECOND, additive notification alongside the CP emit — it rides the same
   * once-per-transition trigger (BYOD status flip) and adds no separate dedup.
   *
   * Best-effort: a failed POST is logged and swallowed. It must never block the CP emit
   * or the sweep. Only called for owner==='byod' rows (subdomain DNS is ours, not the
   * tenant's, so there is no tenant admin to email for it).
   */
  private async notifyPsaDomainEvent(
    tenantId: string,
    domain: string,
    status: 'failed' | 'recovered',
    failingRecords?: string[],
  ): Promise<void> {
    const baseUrl = process.env.PSA_BACKEND_URL;
    if (!baseUrl) {
      console.warn(`[DomainHealth] PSA_BACKEND_URL not set — skipping PSA notify for ${domain} (${tenantId})`);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/internal/domain-drift`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.EMAIL_SERVICE_API_KEY || '',
        },
        body: JSON.stringify({ tenantId, domain, status, failingRecords }),
      });
      if (!res.ok) {
        console.warn(`[DomainHealth] PSA notify (${status}) for ${domain} (${tenantId}) returned ${res.status}`);
      }
    } catch (err: any) {
      console.error(`[DomainHealth] PSA notify (${status}) failed for ${domain} (${tenantId}):`, err?.message || err);
    }
  }
}

export function createDomainHealthService(
  prisma: PrismaClient,
  domainService: DomainService,
  webhookService: WebhookService,
): DomainHealthService {
  return new DomainHealthService(prisma, domainService, webhookService);
}
