import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import sgClient from '@sendgrid/client'; // API key set at module load by domain-auth.routes / domain-health.service
import { PrismaClient } from '@prisma/client';
import emailRoutes from './routes/email.routes';
import domainAuthRoutes from './routes/domain-auth.routes';
import domainRoutes from './routes/domain.routes';
import inboundRoutes from './routes/inbound.routes';
import configRoutes from './routes/config.routes';
import { QueueService } from './services/queue.service';
import { createDomainService } from './services/domain.service';
import { createWebhookService } from './services/webhook.service';
import { createDomainHealthService } from './services/domain-health.service';
import { cloudflareService } from './services/cloudflare.service';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 4001;

// Initialize queue service
const queueService = new QueueService(prisma);

// Domain-health background job (unverified-stuck + DNS-drift detection → CP)
const domainHealthService = createDomainHealthService(
  prisma,
  createDomainService(prisma),
  createWebhookService(prisma),
);
let sweepInProgress = false;

// Set true once waitForDatabase() confirms the DB is reachable. Before that the
// container is still warming its connection pool, and a /health DB ping would throw
// transiently — which must NOT be reported as 'unhealthy' to CP's monitor.
let dbReady = false;

// Guarded, fire-and-forget wrapper around the domain-health sweep so boot and
// the scheduler endpoint share a single in-flight sweep. Caller never awaits
// the sweep itself (a full sweep is slow: SendGrid /validate per domain).
async function runSweepGuarded(trigger: string): Promise<{ started: boolean }> {
  if (sweepInProgress) {
    console.log(`[DomainHealth] Sweep already in progress — ${trigger} skipped`);
    return { started: false };
  }
  sweepInProgress = true;
  // fire-and-forget; caller does not await the sweep itself
  domainHealthService
    .runDomainHealthSweep()
    .catch(err => console.error(`[DomainHealth] Sweep (${trigger}) failed:`, err?.message || err))
    .finally(() => { sweepInProgress = false; });
  return { started: true };
}

// Middleware
app.use(cors());

// Raw body parser for SendGrid Event Webhook (MUST be before express.json())
// This route needs the raw request body for ECDSA signature verification.
app.use('/api/webhooks/sendgrid', express.raw({ type: 'application/json' }));

// JSON body for all other routes
app.use(express.json());

// Make prisma and queue available to routes
app.locals.prisma = prisma;
app.locals.queueService = queueService;
app.locals.domainHealthService = domainHealthService;

// Health check (no auth required)
app.get('/health', async (req, res) => {
  // Still warming up: the DB pool isn't established yet, so a live ping would throw
  // transiently. Report 'starting' (200) — expected, not a real failure. Monitors must
  // not alert on this.
  if (!dbReady) {
    return res.status(200).json({
      status: 'starting',
      service: 'email-service',
      timestamp: new Date().toISOString(),
    });
  }

  // DB was reachable at startup. A failed ping here is a REAL failure (was ready, now
  // the DB is down) and is correctly alert-worthy.
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'healthy',
      service: 'email-service',
      timestamp: new Date().toISOString(),
      queue: {
        size: queueService.getQueueSize(),
        processing: queueService.isProcessing(),
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'email-service',
      error: 'Database connection failed',
    });
  }
});

// API routes
app.use('/api', emailRoutes);
app.use('/api/config', configRoutes);
app.use('/api/domains', domainAuthRoutes);  // BYOD custom domain auth (must be before domainRoutes for /authenticate, /verify)
app.use('/api/domains', domainRoutes);
app.use('/api/inbound', inboundRoutes);

// Internal: trigger a domain-health sweep (called by Cloud Scheduler).
// Returns immediately (202) — the sweep runs fire-and-forget in the background.
app.post('/api/internal/sweep', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] as string | undefined)?.replace('Bearer ', '');
  if (!apiKey || apiKey !== process.env.EMAIL_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { started } = await runSweepGuarded('scheduler');
  // 202 whether or not we started one (idempotent from the scheduler's view)
  return res.status(202).json({ started, message: started ? 'Sweep started' : 'Sweep already in progress' });
});

// Internal: purge ALL of a tenant's email-service data (called by CP's tenant-delete
// flow). :tenantId is the PSA tenant id (cuid) — the key on every tenant-scoped model.
// Idempotent: a tenant with no rows returns all-zero counts + 200. On failure returns
// non-200 (unswallowed) so CP treats it as abort-and-retry, mirroring the PSA-purge pattern.
// BYOD whitelabel domains are de-authenticated at SendGrid first (best-effort, per-domain).
app.post('/api/internal/tenant/:tenantId/purge', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] as string | undefined)?.replace('Bearer ', '');
  if (!apiKey || apiKey !== process.env.EMAIL_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { tenantId } = req.params;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  try {
    // De-authenticate BYOD whitelabel domains at SendGrid BEFORE deleting the DB rows,
    // so a deleted tenant leaves no lingering authentication behind. Per-domain best-effort:
    // a SendGrid failure is warned (logging the orphaned id for manual cleanup) and skipped —
    // SendGrid being down must not block deleting the tenant's data. Matches the manual-delete
    // handler pattern in domain-auth.routes.ts.
    // Collect external-cleanup failures (in addition to the per-point warns) so the response
    // hands CP the exact ids/domains that need manual cleanup. This does NOT change behavior:
    // cleanup stays best-effort and the endpoint still returns 200 unless the DB transaction fails.
    const failures: {
      sendgridDomainIds: string[];    // whitelabel domain ids that failed to de-auth (BYOD + subdomain)
      inboundParseDomains: string[];  // domains whose inbound-parse removal failed
      cloudflareRecordIds: string[];  // Cloudflare record ids that failed to delete
    } = { sendgridDomainIds: [], inboundParseDomains: [], cloudflareRecordIds: [] };

    const domains = await prisma.tenantEmailDomain.findMany({
      where: { tenantId },
      select: { domain: true, sendgridDomainId: true },
    });
    let sendgridDeauthed = 0;
    for (const d of domains) {
      if (!d.sendgridDomainId) continue; // never authenticated → nothing to de-auth
      try {
        await sgClient.request({
          method: 'DELETE',
          url: `/v3/whitelabel/domains/${d.sendgridDomainId}`,
        });
        sendgridDeauthed++;
      } catch (e: any) {
        console.warn(`[TenantPurge] Could not de-auth SendGrid domain ${d.domain} (${d.sendgridDomainId}): ${e.message}`);
        failures.sendgridDomainIds.push(d.sendgridDomainId);
      }
    }

    // Tear down each subdomain config's external footprint BEFORE deleting the DB rows:
    // SendGrid inbound-parse setting + Cloudflare DNS records (em/DKIM CNAMEs under the base
    // domain), using the record ids stored at provisioning. Mirrors deprovisionTenantDomain.
    // All best-effort: a failure is warned (logging what orphaned) and skipped — an external
    // outage must not block deleting the tenant's data.
    const configs = await prisma.tenantEmailConfig.findMany({
      where: { tenantId },
      select: { domain: true, receivingEnabled: true, cloudflareDnsRecordIds: true, sendgridDomainId: true },
    });
    let inboundParseRemoved = 0;
    let cloudflareDnsRemoved = 0;
    for (const config of configs) {
      // a0. De-auth the SUBDOMAIN SendGrid whitelabel registration (separate from the BYOD
      //     tenant_email_domains ids handled above). Same best-effort pattern; shares the
      //     sendgridDeauthed counter so the total covers both subdomain + BYOD.
      if (config.sendgridDomainId) {
        try {
          await sgClient.request({
            method: 'DELETE',
            url: `/v3/whitelabel/domains/${config.sendgridDomainId}`,
          });
          sendgridDeauthed++;
        } catch (e: any) {
          console.warn(`[TenantPurge] Could not de-auth SendGrid subdomain ${config.domain} (${config.sendgridDomainId}): ${e.message}`);
          failures.sendgridDomainIds.push(config.sendgridDomainId);
        }
      }
      // a. Remove SendGrid inbound-parse setting (only if receiving was enabled).
      if (config.receivingEnabled && config.domain) {
        try {
          await sgClient.request({
            method: 'DELETE',
            url: `/v3/user/webhooks/parse/settings/${config.domain}`,
          });
          inboundParseRemoved++;
        } catch (e: any) {
          console.warn(`[TenantPurge] Could not remove inbound parse for ${config.domain}: ${e.message}`);
          failures.inboundParseDomains.push(config.domain);
        }
      }
      // b. Remove Cloudflare DNS records by the ids stored at provisioning.
      if (Array.isArray(config.cloudflareDnsRecordIds) && config.cloudflareDnsRecordIds.length > 0) {
        const ids = config.cloudflareDnsRecordIds as string[];
        try {
          const result = await cloudflareService.removeTenantDnsRecords(ids);
          // removeTenantDnsRecords is per-record best-effort; count what actually deleted.
          cloudflareDnsRemoved += ids.length - result.errors.length;
          if (result.errors.length > 0) {
            console.warn(`[TenantPurge] Some Cloudflare DNS records for ${config.domain} (ids: ${ids.join(', ')}) failed to delete: ${result.errors.join('; ')}`);
            // errors[] gives no clean id-per-error mapping; hand the operator this config's
            // candidate ids to verify at Cloudflare (over-listing already-deleted ids is harmless).
            failures.cloudflareRecordIds.push(...ids);
          }
        } catch (e: any) {
          console.warn(`[TenantPurge] Could not remove Cloudflare DNS records for ${config.domain} (ids: ${ids.join(', ')}): ${e.message}`);
          failures.cloudflareRecordIds.push(...ids);
        }
      }
    }

    // All deletes are scoped by the specific tenantId. This inherently protects the
    // null-tenantId system rows (EmailTemplate system defaults, platform EmailLog rows):
    // null never equals a concrete id, so those rows are never matched. No unfiltered delete.
    const [tenantEmailConfig, tenantEmailDomain, emailMessageId, emailLog, emailTemplate] =
      await prisma.$transaction([
        prisma.tenantEmailConfig.deleteMany({ where: { tenantId } }),
        prisma.tenantEmailDomain.deleteMany({ where: { tenantId } }),
        prisma.emailMessageId.deleteMany({ where: { tenantId } }),
        prisma.emailLog.deleteMany({ where: { tenantId } }),
        prisma.emailTemplate.deleteMany({ where: { tenantId } }),
      ]);

    const counts = {
      tenantEmailConfig: tenantEmailConfig.count,
      tenantEmailDomain: tenantEmailDomain.count,
      emailMessageId: emailMessageId.count,
      emailLog: emailLog.count,
      emailTemplate: emailTemplate.count,
    };
    console.log(`[TenantPurge] Purged tenant ${tenantId} (sendgridDeauthed=${sendgridDeauthed}, inboundParseRemoved=${inboundParseRemoved}, cloudflareDnsRemoved=${cloudflareDnsRemoved}, failures=${JSON.stringify(failures)}):`, JSON.stringify(counts));
    return res.status(200).json({ tenantId, deleted: counts, sendgridDeauthed, inboundParseRemoved, cloudflareDnsRemoved, failures });
  } catch (error: any) {
    // Do NOT swallow — a non-200 tells CP to abort-and-retry its deletion.
    console.error(`[TenantPurge] Failed to purge tenant ${tenantId}:`, error?.message || error);
    return res.status(500).json({ error: error?.message || 'Purge failed' });
  }
});

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  queueService.stop();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  queueService.stop();
  await prisma.$disconnect();
  process.exit(0);
});

// Idempotent schema migrations applied at startup.
// Mirrors the PSA backend pattern: a hash of the statements is stored in
// "_migration_state" so warm instances skip re-running when nothing changed.
// Every statement MUST be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
// because failures are logged and skipped rather than aborting startup.
const MIGRATION_STATEMENTS: string[] = [
  `ALTER TABLE "tenant_email_configs" ADD COLUMN IF NOT EXISTS "lastHealthAlertAt" TIMESTAMP(3)`,
  `ALTER TABLE "tenant_email_domains" ADD COLUMN IF NOT EXISTS "byodFromEmail" TEXT`,
  `ALTER TABLE "tenant_email_domains" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "tenant_email_domains" ADD COLUMN IF NOT EXISTS "lastHealthAlertAt" TIMESTAMP(3)`,
];

// Warm the Prisma connection pool before the first migration DDL runs.
// On cold start against the private-IP prod DB, the initial connection can
// exceed the 10s pool-acquire timeout (connection_limit=5); a bounded retry
// gives the pool time to establish a live connection first.
async function waitForDatabase(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log(`[Startup] Database connection established (attempt ${attempt})`);
      return;
    } catch (err: any) {
      console.warn(`[Startup] DB not ready (attempt ${attempt}/${maxAttempts}): ${err?.message || err}`);
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt)); // backoff 2s,4s,6s,8s
    }
  }
}

async function runMigrationsIfNeeded() {
  console.log('[Migrations] prismaVersion:', require('@prisma/client').Prisma.prismaVersion);

  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_migration_state" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "hash" TEXT NOT NULL,
      "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (err: any) {
    console.error(`[Migrations] FAILED at: create _migration_state`, '| message:', err?.message || '(empty)', '| code:', err?.code, '| meta:', JSON.stringify(err?.meta), '| clientVersion:', err?.clientVersion);
    console.error('[Migrations] full:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    throw err;
  }

  const migrationHash = crypto
    .createHash('sha256')
    .update(MIGRATION_STATEMENTS.join('\n'))
    .digest('hex');

  let existing: { hash: string }[];
  try {
    existing = await prisma.$queryRawUnsafe(
      `SELECT "hash" FROM "_migration_state" WHERE "key" = 'main'`
    );
  } catch (err: any) {
    console.error(`[Migrations] FAILED at: read hash`, '| message:', err?.message || '(empty)', '| code:', err?.code, '| meta:', JSON.stringify(err?.meta), '| clientVersion:', err?.clientVersion);
    console.error('[Migrations] full:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    throw err;
  }

  if (existing.length > 0 && existing[0].hash === migrationHash) {
    console.log(`[Migrations] Already up to date (${MIGRATION_STATEMENTS.length} statements, hash ${migrationHash.slice(0, 8)}), skipping`);
    return;
  }

  console.log(`[Migrations] Running ${MIGRATION_STATEMENTS.length} statements...`);
  const start = Date.now();
  for (const sql of MIGRATION_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err: any) {
      console.error(`[Migrations] Statement failed (continuing): ${err.message}`);
    }
  }
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_migration_state" ("key", "hash", "appliedAt") VALUES ('main', $1, NOW()) ON CONFLICT ("key") DO UPDATE SET "hash" = $1, "appliedAt" = NOW()`,
      migrationHash
    );
  } catch (err: any) {
    console.error(`[Migrations] FAILED at: write hash`, '| message:', err?.message || '(empty)', '| code:', err?.code, '| meta:', JSON.stringify(err?.meta), '| clientVersion:', err?.clientVersion);
    console.error('[Migrations] full:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    throw err;
  }
  console.log(`[Migrations] Completed in ${Date.now() - start}ms`);
}

// Start server
app.listen(port, async () => {
  console.log(`Email service running on port ${port}`);
  if (!process.env.EMAIL_FROM) {
    console.error('[Startup] EMAIL_FROM is not configured — platform-rail emails will fall back to psa@skyrack.com');
  }
  try {
    await waitForDatabase();
    dbReady = true; // DB is reachable now; /health may live-ping. Set before migrations
                    // so a migration failure (which is tolerated) doesn't hold readiness back.
    await runMigrationsIfNeeded();
  } catch (err: any) {
    console.error('[Migrations] Skipped — DB not ready or migration failed:', err?.message);
  }
  await queueService.loadPendingEmails();
  queueService.start();

  // Domain-health sweep: run once at startup (non-blocking, best-effort).
  // Recurring sweeps are now driven by Cloud Scheduler via /api/internal/sweep.
  runSweepGuarded('boot');
});

export { app, prisma };
