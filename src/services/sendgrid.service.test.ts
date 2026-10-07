import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSendGridMessage, SendEmailOptions } from './sendgrid.service';

test('buildSendGridMessage passes a PSA-supplied Message-ID header through verbatim', () => {
  const options: SendEmailOptions = {
    to: 'customer@acme.com',
    subject: '[TKT-000123] update',
    html: '<p>hi</p>',
    headers: {
      'Message-ID': '<ticket-123.c45@deskside.skyrack.com>',
      References: '<ticket-123@deskside.skyrack.com>',
    },
  };

  const msg = buildSendGridMessage(options, 'Deskside <support@deskside.skyrack.com>');

  // The custom headers reach SendGrid untouched so the delivered Message-ID is PSA's.
  assert.deepEqual(msg.headers, {
    'Message-ID': '<ticket-123.c45@deskside.skyrack.com>',
    References: '<ticket-123@deskside.skyrack.com>',
  });
  assert.equal(msg.from, 'Deskside <support@deskside.skyrack.com>');
  assert.deepEqual(msg.to, ['customer@acme.com']);
});

test('buildSendGridMessage leaves headers undefined when none supplied', () => {
  const msg = buildSendGridMessage(
    { to: 'x@y.com', subject: 's', html: '<p>h</p>' },
    'from@z.com',
  );
  assert.equal(msg.headers, undefined);
});

test('buildSendGridMessage maps tags to categories and attachments', () => {
  const msg = buildSendGridMessage(
    {
      to: ['a@b.com'],
      subject: 's',
      html: '<p>h</p>',
      tags: [{ name: 'tenant_id', value: 't1' }],
      attachments: [{ content: 'Zm9v', filename: 'f.pdf', type: 'application/pdf' }],
    },
    'from@z.com',
    'reply@z.com',
  );
  assert.deepEqual(msg.categories, ['tenant_id:t1']);
  assert.equal(msg.replyTo, 'reply@z.com');
  assert.equal(msg.attachments?.[0].disposition, 'attachment');
});
