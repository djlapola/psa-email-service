/**
 * Test entry point. Imports every unit-test module so Node's built-in test
 * runner (node:test) collects and runs them, printing TAP and setting a non-zero
 * exit code on failure. Run via `npm test` (ts-node).
 *
 * Tests here are pure (no DB, no network): forwarding payload shape, recipient/
 * header extraction, PSA status mapping, and outbound Message-ID pass-through.
 */
import '../services/inbound.service.test';
import '../services/sendgrid.service.test';
import '../services/queue.service.test';
import '../routes/email.routes.test';
import './render-template-string.test';
import './redact-secrets.test';
