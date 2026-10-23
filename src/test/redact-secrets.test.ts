import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripSecrets } from '../lib/redact-secrets';

// --- nested keys ------------------------------------------------------------

test('removes secret-named keys at every depth, keeps the rest', () => {
  const input = {
    user: {
      name: 'Jane',
      credentials: { password: 'p', apiKey: 'k', note: 'keep' },
    },
    list: [{ token: 't', ok: 1 }],
  };
  assert.deepEqual(stripSecrets(input), {
    user: {
      name: 'Jane',
      credentials: { note: 'keep' },
    },
    list: [{ ok: 1 }],
  });
});

// --- __headers preserved ----------------------------------------------------

test('__headers key and its contents are preserved', () => {
  const input = {
    attachmentCount: 2,
    __headers: { 'Message-ID': '<abc@x>', References: '<def@x>' },
  };
  assert.deepEqual(stripSecrets(input), {
    attachmentCount: 2,
    __headers: { 'Message-ID': '<abc@x>', References: '<def@x>' },
  });
});

test('a header whose NAME is a secret is dropped; others in __headers stay', () => {
  const input = {
    __headers: { 'X-Auth-Token': 'sekret', 'Message-ID': '<abc@x>' },
  };
  assert.deepEqual(stripSecrets(input), {
    __headers: { 'Message-ID': '<abc@x>' },
  });
});

// --- input unchanged --------------------------------------------------------

test('does not mutate its input and returns a new object', () => {
  const input = { tempPassword: 'p', keep: { token: 't', ok: 1 } };
  const snapshot = { tempPassword: 'p', keep: { token: 't', ok: 1 } };
  const out = stripSecrets(input);
  assert.deepEqual(input, snapshot); // original untouched
  assert.notEqual(out, input); // fresh clone, not the same reference
  assert.notEqual((out as any).keep, input.keep); // nested clone too
});

// --- welcome data maps ------------------------------------------------------

test('tenant-welcome data loses tempPassword, keeps everything else', () => {
  const data = {
    companyName: 'Acme Corp',
    loginUrl: 'https://acme.skyrack.com',
    adminEmail: 'admin@acme.com',
    tempPassword: 'Xk9#mP2$vL5nQ8',
    adminFirstName: 'John',
  };
  assert.deepEqual(stripSecrets(data), {
    companyName: 'Acme Corp',
    loginUrl: 'https://acme.skyrack.com',
    adminEmail: 'admin@acme.com',
    adminFirstName: 'John',
  });
});

test('operator-welcome data loses tempPassword, keeps everything else', () => {
  const data = {
    cpUrl: 'https://control.skyrack.com',
    operatorEmail: 'jane@skyrack.com',
    tempPassword: 'Xk9#mP2$vL5nQ8',
    firstName: 'Jane',
  };
  assert.deepEqual(stripSecrets(data), {
    cpUrl: 'https://control.skyrack.com',
    operatorEmail: 'jane@skyrack.com',
    firstName: 'Jane',
  });
});

// `welcome` uses the optional `temporaryPassword` variable — same removal.
test('welcome data loses temporaryPassword, keeps everything else', () => {
  const data = {
    userName: 'John Smith',
    userEmail: 'john@example.com',
    temporaryPassword: 'TempPass123!',
    loginUrl: 'https://app.example.com/login',
    companyName: 'Acme IT Support',
  };
  assert.deepEqual(stripSecrets(data), {
    userName: 'John Smith',
    userEmail: 'john@example.com',
    loginUrl: 'https://app.example.com/login',
    companyName: 'Acme IT Support',
  });
});

// --- single-use link tokens -------------------------------------------------

test('setPasswordUrl, resetUrl and inviteUrl are removed; loginUrl is kept', () => {
  const data = {
    setPasswordUrl: 'https://cp/set?token=abc',
    resetUrl: 'https://cp/reset?token=def',
    inviteUrl: 'https://cp/invite?token=ghi',
    loginUrl: 'https://cp/login',
  };
  assert.deepEqual(stripSecrets(data), {
    loginUrl: 'https://cp/login',
  });
});
