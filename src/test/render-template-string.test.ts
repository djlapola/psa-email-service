import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTemplateString } from '../lib/render-template-string';
import { escapeHtml } from '../lib/html-escape';
import { injectAttachmentIndicator } from '../services/template.service';
import { firstCrlfAddressField, addressFieldHasCrlf } from '../routes/email.routes';

// --- {{var}} substitution, per mode -----------------------------------------

test('html mode escapes the five HTML-significant characters', () => {
  const out = renderTemplateString('{{x}}', { x: `<b onclick="a">&'</b>` }, 'html');
  assert.equal(out, '&lt;b onclick=&quot;a&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

test('escapeHtml directly produces the expected entities', () => {
  assert.equal(escapeHtml(`<b onclick="a">&'</b>`), '&lt;b onclick=&quot;a&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

test('text mode leaves the value raw (no escaping)', () => {
  const raw = `<b onclick="a">&'</b>`;
  assert.equal(renderTemplateString('{{x}}', { x: raw }, 'text'), raw);
});

test('subject mode collapses CR/LF to a single space', () => {
  assert.equal(renderTemplateString('{{x}}', { x: 'a\r\nBcc: x' }, 'subject'), 'a Bcc: x');
});

test('null renders empty string; undefined keeps the literal {{var}}', () => {
  assert.equal(renderTemplateString('[{{x}}]', { x: null }, 'html'), '[]');
  assert.equal(renderTemplateString('[{{x}}]', {}, 'html'), '[{{x}}]');
  // null in subject/text too
  assert.equal(renderTemplateString('[{{x}}]', { x: null }, 'text'), '[]');
  assert.equal(renderTemplateString('[{{x}}]', { x: null }, 'subject'), '[]');
});

test('an ordinary value with no special chars is unchanged in all modes', () => {
  for (const mode of ['html', 'subject', 'text'] as const) {
    assert.equal(renderTemplateString('{{x}}', { x: 'Monday=1' }, mode), 'Monday=1');
  }
});

test('a substituted value containing {{y}} is NOT re-expanded (single pass)', () => {
  const out = renderTemplateString('{{x}}', { x: '{{y}}', y: 'SECRET' }, 'text');
  assert.equal(out, '{{y}}');
  assert.ok(!out.includes('SECRET'));
});

// --- *Url variable validation in html mode ----------------------------------

test('html mode: a *Url variable with a javascript: scheme renders empty', () => {
  assert.equal(renderTemplateString('[{{setPasswordUrl}}]', { setPasswordUrl: 'javascript:alert(1)' }, 'html'), '[]');
});

test('html mode: a *Url variable with a data: scheme renders empty', () => {
  assert.equal(renderTemplateString('[{{setPasswordUrl}}]', { setPasswordUrl: 'data:text/html,<script>alert(1)</script>' }, 'html'), '[]');
});

test('html mode: a *Url variable with a relative path renders empty', () => {
  assert.equal(renderTemplateString('[{{setPasswordUrl}}]', { setPasswordUrl: '/relative/path' }, 'html'), '[]');
});

test('html mode: a *Url variable with http:// or https:// is kept', () => {
  assert.equal(renderTemplateString('{{setPasswordUrl}}', { setPasswordUrl: 'http://host/set' }, 'html'), 'http://host/set');
  assert.equal(renderTemplateString('{{setPasswordUrl}}', { setPasswordUrl: 'https://host/set' }, 'html'), 'https://host/set');
});

test('html mode: an https *Url with a #token= fragment survives unchanged', () => {
  const url = 'https://host/set-password#token=abc123';
  assert.equal(renderTemplateString('<a href="{{setPasswordUrl}}">x</a>', { setPasswordUrl: url }, 'html'), `<a href="${url}">x</a>`);
});

test('html mode: a non-Url key containing "javascript:" is escaped as normal, not blanked', () => {
  // `note` does not end in "Url", so the URL gate does not apply; it is escaped like any value.
  assert.equal(renderTemplateString('{{note}}', { note: 'javascript:alert(1)' }, 'html'), 'javascript:alert(1)');
});

// --- {{#if}} conditionals (unchanged behaviour) -----------------------------

test('{{#if}} includes content when the flag is truthy', () => {
  assert.equal(renderTemplateString('{{#if show}}yes {{name}}{{/if}}', { show: true, name: 'A' }, 'text'), 'yes A');
});

test('{{#if}} drops content when the flag is falsy/absent', () => {
  assert.equal(renderTemplateString('a{{#if show}}yes{{/if}}b', { show: false }, 'text'), 'ab');
  assert.equal(renderTemplateString('a{{#if show}}yes{{/if}}b', {}, 'text'), 'ab');
});

// --- injectAttachmentIndicator URL hardening --------------------------------

test('injectAttachmentIndicator emits no href for a javascript: URL', () => {
  const out = injectAttachmentIndicator(
    { html: '<body></body>', text: '' },
    { attachmentCount: 1, portalTicketUrl: 'javascript:alert(1)' },
  );
  assert.ok(out.html.includes('1 attachment(s)'));
  assert.ok(!out.html.includes('href'));
  assert.ok(!out.html.includes('javascript:'));
  // text part has no URL line either
  assert.ok(!out.text.includes('View in portal'));
});

test('injectAttachmentIndicator returns input unchanged when no portalTicketUrl is supplied', () => {
  const input = { html: '<body></body>', text: '' };
  const out = injectAttachmentIndicator(input, { attachmentCount: 2 });
  assert.deepEqual(out, input);
  assert.ok(!out.html.includes('attachment(s)'));
});

test('injectAttachmentIndicator escapes & in a valid https href', () => {
  const out = injectAttachmentIndicator(
    { html: '<body></body>', text: '' },
    { attachmentCount: 2, portalTicketUrl: 'https://x/?a=1&b=2' },
  );
  assert.ok(out.html.includes('href="https://x/?a=1&amp;b=2"'));
  assert.ok(out.html.includes('2 attachment(s)'));
});

// --- CR/LF address-field rejection (pure predicate used by the routes) ------
// There is no HTTP/supertest harness in this repo, so the full 400 response is not
// exercised here; the exported predicate that /api/send and /api/send/bulk use to
// decide the 400 is tested directly instead.

test('addressFieldHasCrlf detects CR/LF in a string and in array elements', () => {
  assert.equal(addressFieldHasCrlf('ok@x.com'), false);
  assert.equal(addressFieldHasCrlf('a@x.com\r\nBcc: e@evil.com'), true);
  assert.equal(addressFieldHasCrlf(['a@x.com', 'b@x.com']), false);
  assert.equal(addressFieldHasCrlf(['a@x.com', 'b@x.com\nX: y']), true);
  assert.equal(addressFieldHasCrlf(undefined), false);
});

test('firstCrlfAddressField names the first offending field or null', () => {
  assert.equal(firstCrlfAddressField({ to: 'a@x.com', from: 'b@x.com' }), null);
  assert.equal(firstCrlfAddressField({ to: 'a@x.com', cc: 'c@x.com\r\nX: y' }), 'cc');
  assert.equal(firstCrlfAddressField({ replyTo: 'r@x.com\n' }), 'replyTo');
});
