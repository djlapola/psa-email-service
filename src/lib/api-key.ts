import crypto from 'crypto';

/**
 * Timing-safe comparison of a presented key against a single expected value.
 *
 * Mirrors Control Plane's `internal-auth.ts#timingSafeKeyMatch` (pad-to-length +
 * crypto.timingSafeEqual). Note this REPLACES the plain `!==` string comparison the email-service
 * verify sites used before — see acceptsRotatableKey for why. Returns false for an empty/undefined
 * expected value, so an unset env var can never authenticate.
 */
function timingSafeKeyMatch(presented: string, expected: string): boolean {
  if (!expected) return false;
  try {
    const expectedBuf = Buffer.from(expected);
    // Pad/truncate the presented key to the expected length so timingSafeEqual (which requires
    // equal-length buffers) doesn't itself leak the expected length via a thrown error.
    const presentedBuf = Buffer.from(presented.padEnd(expected.length, '\0').slice(0, expected.length));
    return expectedBuf.length === presentedBuf.length && crypto.timingSafeEqual(expectedBuf, presentedBuf);
  } catch {
    return false;
  }
}

// Latch so accepting a PREVIOUS key logs once per process (keyed by the previous env-var name),
// not once per request — during a rotation window every PSA/CP/scheduler call would otherwise spam
// this line. Keyed by name so distinct rotatable keys each get their own one-time signal.
const previousKeyAcceptedLogged = new Set<string>();

/**
 * True if `presented` matches the current key (env var `currentEnvName`) or, during a rotation,
 * its optional previous key (env var `previousEnvName`).
 *
 * When the previous var is unset, empty, or whitespace-only, behaviour is exactly as before — only
 * the current key is accepted. This lets `EMAIL_SERVICE_API_KEY` be rotated in stages (deploy
 * dual-accept → set old value as `*_PREVIOUS` → update callers → unset `*_PREVIOUS`) with no window
 * where PSA/CP get 401s and outbound email silently fails.
 *
 * The one-time warn when the PREVIOUS key is accepted is the only signal telling an operator whether
 * any caller is still using the old key before removing PREVIOUS to finish the rotation.
 *
 * Shape mirrors CP's rotation helper (`isValidInternalApiKey`), generalised to take the env-var
 * NAMES + a log label so all four email-service verify sites share one implementation.
 */
export function acceptsRotatableKey(
  presented: string | string[] | undefined,
  currentEnvName: string,
  previousEnvName: string,
  label: string,
): boolean {
  // A missing header, an empty header, or a repeated (array) header never authenticates — this
  // preserves the old `!apiKey || apiKey !== ...` semantics, where a non-string could not match.
  if (typeof presented !== 'string' || presented.length === 0) return false;

  // Current key — the only path when PREVIOUS is not configured.
  if (timingSafeKeyMatch(presented, process.env[currentEnvName] || '')) {
    return true;
  }

  // Previous key — only considered when set AND not empty/whitespace-only, so a blank PREVIOUS can
  // never become a key that an empty or padded header could match.
  const previous = process.env[previousEnvName];
  if (previous && previous.trim().length > 0 && timingSafeKeyMatch(presented, previous)) {
    if (!previousKeyAcceptedLogged.has(previousEnvName)) {
      previousKeyAcceptedLogged.add(previousEnvName);
      console.warn(
        `[${label}] Accepted the PREVIOUS API key (${previousEnvName}). ` +
          'A caller is still using the old key — update remaining callers, then unset PREVIOUS to ' +
          'complete rotation. (logged once per process)',
      );
    }
    return true;
  }

  return false;
}
