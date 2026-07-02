import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import emailRoutes from './routes/email.routes';
import domainAuthRoutes from './routes/domain-auth.routes';
import domainRoutes from './routes/domain.routes';
import inboundRoutes from './routes/inbound.routes';
import { QueueService } from './services/queue.service';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 4001;

// Initialize queue service
const queueService = new QueueService(prisma);

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

// Health check (no auth required)
app.get('/health', async (req, res) => {
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
app.use('/api/domains', domainAuthRoutes);  // BYOD custom domain auth (must be before domainRoutes for /authenticate, /verify)
app.use('/api/domains', domainRoutes);
app.use('/api/inbound', inboundRoutes);

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
  // empty for now — real ALTER/CREATE statements added in the next task
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
  try {
    await waitForDatabase();
    await runMigrationsIfNeeded();
  } catch (err: any) {
    console.error('[Migrations] Skipped — DB not ready or migration failed:', err?.message);
  }
  await queueService.loadPendingEmails();
  queueService.start();
});

export { app, prisma };
