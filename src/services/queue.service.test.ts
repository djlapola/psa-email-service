import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QueueService, QueuedEmail } from './queue.service';
import type { SendEmailOptions } from './sendgrid.service';

/**
 * Pure tests (no DB, no network): header pass-through on the template/queue path.
 *
 * The queue's live payload is the in-memory QueuedEmail[]; it is also persisted to the
 * EmailLog row (metadata JSON column) so jobs survive a restart. These tests stub the
 * internal prisma/template/sendgrid collaborators and assert that caller headers:
 *   - reach SendGridService.sendEmail from the worker (template send),
 *   - are stashed in the persisted metadata and recovered on reload,
 *   - and are absent / behaviour unchanged when the caller supplies none.
 *
 * The /api/send template branch and the /api/send/bulk (batch) branch both funnel into
 * QueueService.enqueue with `headers`, so exercising enqueue covers both call sites.
 */

/** Minimal in-memory prisma double capturing emailLog writes. */
function fakePrisma() {
  const created: any[] = [];
  const rows: any[] = [];
  return {
    created,
    rows,
    emailLog: {
      create: async ({ data }: any) => {
        const row = { id: `log-${created.length + 1}`, ...data };
        created.push(row);
        rows.push(row);
        return row;
      },
      update: async () => ({}),
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
      findMany: async () => rows,
    },
  };
}

function makeQueue() {
  const prisma = fakePrisma();
  const queue = new QueueService(prisma as any);
  // Stub the template lookup/render so enqueue/sendEmail need no DB template.
  (queue as any).templateService = {
    getAndRender: async () => ({ subject: 'Re: [TKT-1]', html: '<p>hi</p>', text: 'hi' }),
  };
  return { queue, prisma };
}

const HEADERS = {
  'Auto-Submitted': 'auto-generated',
  'X-Auto-Response-Suppress': 'All',
  'Message-ID': '<ticket-1.c2@deskside.skyrack.com>',
};

test('enqueue carries headers into the in-memory job and persists them in metadata', async () => {
  const { queue, prisma } = makeQueue();

  await queue.enqueue({
    to: 'customer@acme.com',
    template: 'ticket-comment',
    data: { ticketNumber: 'TKT-1' },
    tenantId: 't1',
    headers: HEADERS,
  });

  const job: QueuedEmail = (queue as any).queue[0];
  assert.deepEqual(job.headers, HEADERS);

  // Headers stashed under the reserved key; template data preserved alongside.
  const meta = prisma.created[0].metadata;
  assert.deepEqual(meta.__headers, HEADERS);
  assert.equal(meta.ticketNumber, 'TKT-1');
});

test('enqueue without headers leaves the job and metadata unchanged', async () => {
  const { queue, prisma } = makeQueue();

  await queue.enqueue({
    to: 'customer@acme.com',
    template: 'ticket-comment',
    data: { ticketNumber: 'TKT-1' },
    tenantId: 't1',
  });

  const job: QueuedEmail = (queue as any).queue[0];
  assert.equal(job.headers, undefined);

  // Metadata is exactly the template data — no reserved key injected.
  assert.deepEqual(prisma.created[0].metadata, { ticketNumber: 'TKT-1' });
});

test('batch-style enqueue (bulk path) carries headers the same way', async () => {
  const { queue, prisma } = makeQueue();

  // Mirrors the per-item call the /api/send/bulk handler makes.
  const email = { to: 'a@b.com', template: 'ticket-comment', data: {}, tenantId: 't1', headers: HEADERS };
  await queue.enqueue({
    to: email.to,
    template: email.template,
    data: email.data || {},
    tenantId: email.tenantId,
    headers: email.headers,
  });

  assert.deepEqual((queue as any).queue[0].headers, HEADERS);
  assert.deepEqual(prisma.created[0].metadata.__headers, HEADERS);
});

test('worker send passes caller headers to SendGridService.sendEmail', async () => {
  const { queue } = makeQueue();
  let captured: SendEmailOptions | undefined;
  (queue as any).sendgridService = {
    sendEmail: async (opts: SendEmailOptions) => {
      captured = opts;
      return { success: true, messageId: 'sg-1' };
    },
  };

  await (queue as any).sendEmail({
    id: 'log-1',
    to: 'customer@acme.com',
    template: 'ticket-comment',
    data: { ticketNumber: 'TKT-1' },
    tenantId: 't1',
    headers: HEADERS,
  } as QueuedEmail);

  assert.deepEqual(captured?.headers, HEADERS);
});

test('worker send without headers sends undefined headers (unchanged behaviour)', async () => {
  const { queue } = makeQueue();
  let captured: SendEmailOptions | undefined;
  (queue as any).sendgridService = {
    sendEmail: async (opts: SendEmailOptions) => {
      captured = opts;
      return { success: true, messageId: 'sg-1' };
    },
  };

  await (queue as any).sendEmail({
    id: 'log-1',
    to: 'customer@acme.com',
    template: 'ticket-comment',
    data: {},
    tenantId: 't1',
  } as QueuedEmail);

  assert.equal(captured?.headers, undefined);
});

test('loadPendingEmails recovers stashed headers and strips the reserved key from data', async () => {
  const { queue, prisma } = makeQueue();

  // Row persisted with headers stashed in metadata (as enqueue writes it).
  prisma.rows.push({
    id: 'log-9',
    to: 'customer@acme.com',
    template: 'ticket-comment',
    tenantId: 't1',
    from: 'pending-resolution',
    status: 'queued',
    attempts: 0,
    metadata: { ticketNumber: 'TKT-1', __headers: HEADERS },
  });
  // Legacy row persisted before headers existed — must still load cleanly.
  prisma.rows.push({
    id: 'log-10',
    to: 'other@acme.com',
    template: 'ticket-comment',
    tenantId: 't1',
    from: 'pending-resolution',
    status: 'queued',
    attempts: 0,
    metadata: { ticketNumber: 'TKT-2' },
  });

  await queue.loadPendingEmails();

  const jobs: QueuedEmail[] = (queue as any).queue;
  const withHeaders = jobs.find((j) => j.id === 'log-9')!;
  assert.deepEqual(withHeaders.headers, HEADERS);
  assert.deepEqual(withHeaders.data, { ticketNumber: 'TKT-1' }); // reserved key stripped

  const legacy = jobs.find((j) => j.id === 'log-10')!;
  assert.equal(legacy.headers, undefined);
  assert.deepEqual(legacy.data, { ticketNumber: 'TKT-2' });
});
