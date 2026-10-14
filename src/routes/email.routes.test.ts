import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifySendGridEvent } from './email.routes';

/**
 * Pure tests for the SendGrid Event Webhook → PSA mapping (classifySendGridEvent).
 * Verifies that raw bounce detail is preserved for PSA and that transient 'deferred'
 * events are not forwarded as bounces.
 */

test('bounce/bounce forwards as email.bounced with sgType, SMTP status, and reason', () => {
  const c = classifySendGridEvent({
    event: 'bounce',
    type: 'bounce',
    status: '5.1.1',
    reason: '550 5.1.1 The email account that you tried to reach does not exist',
    timestamp: 1700000000,
    sg_message_id: 'abc123.filter001',
  });

  assert.equal(c.newStatus, 'bounced');
  assert.equal(c.webhookEvent, 'email.bounced'); // forwarded
  assert.equal(c.detail.sgEvent, 'bounce');
  assert.equal(c.detail.sgType, 'bounce'); // hard bounce
  assert.equal(c.detail.status, '5.1.1');
  assert.equal(
    c.detail.reason,
    '550 5.1.1 The email account that you tried to reach does not exist',
  );
  assert.equal(c.detail.sgTimestamp, 1700000000);
  assert.equal(c.detail.sgMessageId, 'abc123'); // filter suffix stripped
});

test('bounce/blocked forwards as email.bounced with sgType "blocked"', () => {
  const c = classifySendGridEvent({
    event: 'bounce',
    type: 'blocked',
    status: '4.0.0',
    reason: '421 4.7.0 Temporary block — try later',
    sg_message_id: 'blk999',
  });

  assert.equal(c.newStatus, 'bounced');
  assert.equal(c.webhookEvent, 'email.bounced'); // forwarded
  assert.equal(c.detail.sgType, 'blocked'); // block, not a hard bounce
  assert.equal(c.detail.status, '4.0.0');
  assert.equal(c.detail.reason, '421 4.7.0 Temporary block — try later');
});

test('deferred is NOT forwarded to PSA (no webhook event, status unchanged)', () => {
  const c = classifySendGridEvent({
    event: 'deferred',
    reason: 'greylisted, will retry',
    sg_message_id: 'def555',
  });

  assert.equal(c.newStatus, null); // status unchanged
  assert.equal(c.webhookEvent, null); // not forwarded
  assert.equal(c.eventType, 'deferred');
});

test('dropped forwards as email.bounced carrying its drop reason', () => {
  const c = classifySendGridEvent({
    event: 'dropped',
    reason: 'Bounced Address',
    sg_message_id: 'drp777.filter',
  });

  assert.equal(c.newStatus, 'bounced');
  assert.equal(c.webhookEvent, 'email.bounced'); // forwarded
  assert.equal(c.detail.sgEvent, 'dropped');
  assert.equal(c.detail.reason, 'Bounced Address');
  assert.equal(c.detail.sgMessageId, 'drp777');
  // dropped has no SendGrid "type" field — must be absent, not empty string.
  assert.equal(c.detail.sgType, undefined);
});

test('spamreport forwards as email.complained', () => {
  const c = classifySendGridEvent({ event: 'spamreport', sg_message_id: 'spm1' });
  assert.equal(c.newStatus, 'complained');
  assert.equal(c.webhookEvent, 'email.complained');
});

test('delivered updates status but is NOT forwarded', () => {
  const c = classifySendGridEvent({ event: 'delivered', sg_message_id: 'dlv1' });
  assert.equal(c.newStatus, 'delivered');
  assert.equal(c.webhookEvent, null);
});

test('reason falls back to response text and is truncated to 500 chars', () => {
  const long = 'x'.repeat(600);
  const c = classifySendGridEvent({
    event: 'bounce',
    type: 'bounce',
    response: long,
    sg_message_id: 'trunc1',
  });
  assert.equal(c.detail.reason?.length, 500);
});

test('unknown/non-bounce events (unsubscribe) are not forwarded', () => {
  const c = classifySendGridEvent({ event: 'unsubscribe', sg_message_id: 'uns1' });
  assert.equal(c.newStatus, null);
  assert.equal(c.webhookEvent, null);
});
