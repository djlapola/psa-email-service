import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPsaInboundPayload,
  buildRecipients,
  extractAddresses,
  classifyPsaStatus,
} from './inbound.service';

// A representative SendGrid-parsed inbound email (headers already lowercased by
// the route's parseEmailHeaders).
function sampleEmail() {
  return {
    from: '"Jane Doe" <jane@customer.com>',
    to: 'Support <support@deskside.skyrack.com>, cc-ignored@x.com',
    cc: 'Boss <boss@customer.com>, peer@customer.com',
    subject: 'Re: [TKT-000123] printer down',
    text: 'It is still broken.\n\nOn Mon wrote:\n> old quoted text',
    html: '<p>It is still broken.</p>',
    headers: {
      'message-id': '<abc123@customer.com>',
      'in-reply-to': '<prev@deskside.skyrack.com>',
      references: '<root@deskside.skyrack.com> <prev@deskside.skyrack.com>',
      'auto-submitted': 'auto-replied',
      precedence: 'bulk',
      'x-autoreply': 'yes',
    },
    attachments: [
      { filename: 'log.txt', content: 'YmFzZTY0', contentType: 'text/plain', contentId: 'cid1', size: 42 },
    ],
    envelope: { to: ['support@deskside.skyrack.com'], from: 'jane@customer.com' },
    receivedAt: '2026-10-07T12:00:00.000Z',
  };
}

test('extractAddresses parses display-name and bare forms, lowercased', () => {
  assert.deepEqual(
    extractAddresses('Jane <JANE@X.com>, bob@Y.com'),
    ['jane@x.com', 'bob@y.com'],
  );
  assert.deepEqual(extractAddresses(''), []);
  assert.deepEqual(extractAddresses(undefined), []);
});

test('buildRecipients unions To + envelope.to, dedupes, keeps support@, parses cc', () => {
  const r = buildRecipients(sampleEmail());
  assert.deepEqual(r.to, ['support@deskside.skyrack.com', 'cc-ignored@x.com']);
  assert.deepEqual(r.cc, ['boss@customer.com', 'peer@customer.com']);
  // support@ tenant address is present (NOT stripped) — PSA needs the real recipient set.
  assert.ok(r.to.includes('support@deskside.skyrack.com'));
});

test('buildPsaInboundPayload produces the exact PSA forwarding shape', () => {
  const p = buildPsaInboundPayload(sampleEmail(), 'tenant-1', 'deskside');

  assert.equal(p.tenantId, 'tenant-1');
  assert.equal(p.tenantSubdomain, 'deskside');
  assert.equal(p.fromEmail, 'jane@customer.com');
  assert.equal(p.fromName, 'Jane Doe');
  assert.equal(p.subject, 'Re: [TKT-000123] printer down');

  // Bodies forwarded verbatim — no quoted-reply stripping (PSA owns that now).
  assert.ok(p.bodyText.includes('old quoted text'));
  assert.equal(p.bodyHtml, '<p>It is still broken.</p>');

  assert.equal(p.messageId, '<abc123@customer.com>');
  assert.equal(p.inReplyTo, '<prev@deskside.skyrack.com>');
  assert.deepEqual(p.references, ['<root@deskside.skyrack.com>', '<prev@deskside.skyrack.com>']);
  assert.equal(p.autoSubmitted, 'auto-replied');
  assert.equal(p.precedence, 'bulk');
  assert.equal(p.xAutoreply, 'yes');
  assert.equal(p.receivedAt, '2026-10-07T12:00:00.000Z');

  assert.deepEqual(p.recipients, {
    to: ['support@deskside.skyrack.com', 'cc-ignored@x.com'],
    cc: ['boss@customer.com', 'peer@customer.com'],
  });

  // Attachment mapping: contentType -> mimeType, size -> fileSize, content/contentId preserved.
  assert.deepEqual(p.attachments, [
    { filename: 'log.txt', content: 'YmFzZTY0', mimeType: 'text/plain', contentId: 'cid1', fileSize: 42 },
  ]);
});

test('buildPsaInboundPayload tolerates missing headers/attachments', () => {
  const p = buildPsaInboundPayload(
    { from: 'solo@customer.com', to: 'support@deskside.skyrack.com', subject: 'hi' },
    't',
    'deskside',
  );
  assert.equal(p.fromEmail, 'solo@customer.com');
  assert.equal(p.fromName, 'solo@customer.com'); // falls back to the address
  assert.equal(p.messageId, '');
  assert.equal(p.inReplyTo, null);
  assert.deepEqual(p.references, []);
  assert.equal(p.autoSubmitted, null);
  assert.equal(p.precedence, null);
  assert.equal(p.xAutoreply, null);
  assert.deepEqual(p.attachments, []);
  assert.equal(typeof p.receivedAt, 'string'); // stamped when absent
});

test('classifyPsaStatus maps status -> forward outcome', () => {
  assert.equal(classifyPsaStatus(200).kind, 'psa-success');
  assert.equal(classifyPsaStatus(201).kind, 'psa-success');

  // Deterministic rejections -> ack (200 to SendGrid). 401 is NOT here.
  for (const s of [400, 403, 404]) {
    assert.equal(classifyPsaStatus(s).kind, 'psa-client-error', `status ${s}`);
  }

  // Transient -> retry (5xx to SendGrid). 401 (auth/config problem) is retryable.
  for (const s of [401, 500, 502, 503, 408, 429]) {
    assert.equal(classifyPsaStatus(s).kind, 'psa-server-error', `status ${s}`);
  }

  // 401 carries its status through so the route can emit the auth-specific log.
  assert.deepEqual(classifyPsaStatus(401), { kind: 'psa-server-error', status: 401 });
});
