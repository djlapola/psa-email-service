/**
 * Scrub secret-bearing values out of an EmailLog.metadata map before it is persisted
 * at a TERMINAL status (sent / failed-after-final-retry / bounced / complained).
 *
 * EmailLog.metadata stores the caller `data` map verbatim (queue.service.ts enqueue,
 * email.routes.ts raw path), so welcome emails would otherwise persist a cleartext
 * `tempPassword` forever. This removes those values once the row can no longer be
 * (re)sent — the queue reloads only non-terminal rows (status queued/sending) and
 * re-renders from metadata, so scrubbing MUST NOT happen before a terminal state.
 *
 * Secrets are REMOVED (the key is dropped), never masked — a masked placeholder is
 * still a record that a secret existed and invites someone to try to recover it.
 */

/**
 * Case-insensitive match for key names whose value is a credential/secret. Applied at
 * every depth. No `g` flag, so `.test()` is stateless and safe to reuse.
 */
const SECRET_KEY_PATTERN =
  /pass(word|wd)?$|password|secret|token|apikey|api_key|privatekey|private_key|twoFactorCode|totp|otp$|mfaCode/i;

/**
 * Exact key names that are not caught by the pattern but still carry a single-use
 * secret: the set-password / reset / invite links embed a one-time token in the URL.
 */
const EXACT_SECRET_KEYS: ReadonlySet<string> = new Set([
  'setPasswordUrl',
  'resetUrl',
  'inviteUrl',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || EXACT_SECRET_KEYS.has(key);
}

/**
 * Return a deep clone of `value` with every secret-named key removed at any depth.
 *
 * The input is never mutated. Arrays are cloned element-wise; plain objects are rebuilt
 * without the secret keys; primitives/null/undefined are returned as-is.
 *
 * The queue stashes caller headers under the reserved `__headers` key inside metadata.
 * `__headers` is not itself a secret name, so it (and its contents) are preserved by the
 * generic recursion — EXCEPT an individual header whose NAME matches a secret pattern
 * (e.g. a header literally named `X-Api-Key`), which is dropped like any other secret key.
 */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) continue; // remove, do not mask
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}
