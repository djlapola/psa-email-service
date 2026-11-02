import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPsaInboundPayload,
  buildRecipients,
  buildAuthObject,
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

// ---------------------------------------------------------------------------
// Sender-authentication relay (the `auth` object forwarded to PSA).
//
// Authentication-Results headers are intentionally NOT forwarded: SendGrid does
// not stamp its own, so any such header is sender-controllable and PSA ignores it.
// ---------------------------------------------------------------------------

test('buildAuthObject: all fields present', () => {
  const auth = buildAuthObject({
    from: 'tech@acme.com',
    to: 'support@deskside.skyrack.com',
    subject: 'hi',
    spf: 'pass',
    dkim: '{@acme.com : pass}',
    envelope: { to: ['support@deskside.skyrack.com'], from: 'tech@acme.com' },
  });
  assert.deepEqual(auth, {
    spf: 'pass',
    dkim: '{@acme.com : pass}',
    envelopeFrom: 'tech@acme.com',
    source: 'sendgrid',
  });
});

test('buildAuthObject: envelope missing -> envelopeFrom omitted, source still present', () => {
  const auth = buildAuthObject({
    from: 'tech@acme.com',
    to: 'support@deskside.skyrack.com',
    subject: 'hi',
    spf: 'pass',
    // no envelope
  });
  assert.equal('envelopeFrom' in auth, false);
  assert.equal(auth.spf, 'pass');
  assert.equal('dkim' in auth, false);
  assert.equal(auth.source, 'sendgrid');
});

test('buildAuthObject: malformed-envelope case (route yields envelope={}) -> envelopeFrom omitted', () => {
  // The route sets envelope = {} when JSON.parse fails; the service sees no `from`.
  const auth = buildAuthObject({
    from: 'tech@acme.com',
    to: 'support@deskside.skyrack.com',
    subject: 'hi',
    envelope: {},
  });
  assert.equal('envelopeFrom' in auth, false);
  assert.equal(auth.source, 'sendgrid');
});

test('buildAuthObject: no auth data at all -> only source', () => {
  const auth = buildAuthObject({ from: 'a@b.com', to: 'support@deskside.skyrack.com', subject: 'hi' });
  assert.deepEqual(auth, { source: 'sendgrid' });
});

test('buildPsaInboundPayload embeds the auth object (no authenticationResults)', () => {
  const p = buildPsaInboundPayload(
    {
      ...sampleEmail(),
      spf: 'pass',
      dkim: '{@customer.com : pass}',
    },
    'tenant-1',
    'deskside',
  );
  assert.deepEqual(p.auth, {
    spf: 'pass',
    dkim: '{@customer.com : pass}',
    envelopeFrom: 'jane@customer.com', // from sampleEmail().envelope.from
    source: 'sendgrid',
  });
});

test('buildPsaInboundPayload: raw-MIME mode is OFF in this handler (no email field consumed)', () => {
  // The handler reads parsed text/html/headers, not a full-MIME `email` field, so
  // in parsed mode SPF/dkim/envelope are forwarded as-is and bodies come through.
  // This asserts the parsed-mode contract the service is built against.
  const p = buildPsaInboundPayload(
    { ...sampleEmail(), spf: 'pass', dkim: 'pass' },
    't',
    'deskside',
  );
  assert.equal(p.bodyHtml, '<p>It is still broken.</p>');
  assert.equal(p.auth.spf, 'pass');
  assert.equal(p.auth.source, 'sendgrid');
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
