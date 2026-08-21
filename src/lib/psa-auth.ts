/**
 * Outbound auth for THIS service's calls to PSA's internal API — the single source of truth so every
 * PSA-bound call site presents the same header and key. A second copy is exactly what leaves one
 * call site still riding the old key after a rotation.
 *
 * Background: email-service→PSA was the "fourth purpose" the 2026-08-19 key split missed. These calls
 * sent `X-Internal-API-Key` from PSA_INTERNAL_API_KEY, which PSA verified as `SCHEDULER_API_KEY ||
 * INTERNAL_API_KEY` — so this service's inbound-email/bounce traffic rode the Cloud Scheduler key and
 * blocked its rotation. PSA now also accepts the `x-email-service-api-key` header, verified against
 * EMAIL_SERVICE_TO_PSA_API_KEY with a fallback to INTERNAL_API_KEY, giving this service its own lane.
 */
export const PSA_API_KEY_HEADER = 'x-email-service-api-key';

/**
 * The key value to present to PSA. Prefer the dedicated EMAIL_SERVICE_TO_PSA_API_KEY; fall back to
 * PSA_INTERNAL_API_KEY (the pre-split value) when it is unset or blank, so switching to the new
 * header deploys as a genuine no-op before the new secret is mounted. Resolved at call time so a
 * secret mounted after startup is picked up without a restart.
 */
export function psaApiKey(): string {
  return process.env.EMAIL_SERVICE_TO_PSA_API_KEY?.trim() || process.env.PSA_INTERNAL_API_KEY || '';
}
