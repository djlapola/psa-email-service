/**
 * Centralised access + startup validation for this service's secrets.
 *
 * Two deliberately separate responsibilities:
 *
 *   1. Accessors (sendgridApiKey, webhookSigningSecret) — the ONE place each secret's env-absence
 *      default lives. The four SendGrid client-config sites (sendgrid.service, domain.service,
 *      domain-auth.routes, domain-health.service) all read the key through sendgridApiKey() so the
 *      `|| ''` default exists exactly once. Four copies of a default is how one of them drifts.
 *      Accessors do NOT throw: they run at module load, before server.ts calls dotenv.config(), so a
 *      throw here could fire before .env has even been read.
 *
 *   2. assertRequiredSecrets() — called once from server bootstrap AFTER dotenv.config(). It refuses
 *      to start the process when a required secret is unset/blank, and warns (without failing) on
 *      recommended-but-optional ones. This is what turns a silent misconfiguration — empty SendGrid
 *      key, every send failing at SendGrid's API while /health still reports OK — into a loud,
 *      fail-fast crash that the deploy surfaces immediately.
 */

import { psaApiKey } from './psa-auth';

/** The SendGrid API key. Single source of truth for its env-absence default. */
export function sendgridApiKey(): string {
  return process.env.SENDGRID_API_KEY ?? '';
}

/**
 * The HMAC secret this service signs outbound webhooks with. Single source of truth for its default.
 * Note: no `'default-secret'` fallback — a guessable literal would let a half-configured rotation
 * (secret set on CP but not here) keep producing plausible-looking signatures that CP silently 401s,
 * which is exactly the misconfiguration we want to make visible rather than paper over.
 */
export function webhookSigningSecret(): string {
  return process.env.EMAIL_SERVICE_WEBHOOK_SECRET ?? '';
}

/**
 * Secrets with no safe default and no alternative source: the service has no useful function without
 * them. Missing any of these is a deploy error, not a degraded mode — we refuse to start.
 */
const REQUIRED_ENV_SECRETS = [
  'SENDGRID_API_KEY',      // outbound send + domain auth — the entire purpose of this service
  'DATABASE_URL',          // Prisma: EmailLog, templates, tenant configs all live here
  'EMAIL_SERVICE_API_KEY', // authenticates CP → this service; empty ⇒ every CP call is rejected
] as const;

/**
 * Recommended in production but tolerated when absent (a sensible fallback or a peer that accepts the
 * unconfigured case exists). We WARN so absence is never silent, but do not block startup.
 */
const RECOMMENDED_ENV_SECRETS: { name: string; why: string }[] = [
  {
    // CP accepts unsigned webhooks when its own secret is unset (dev mode), so both-unset works. The
    // hazard is a one-sided config — set on CP, unset here — which CP 401s silently. Warn, don't gate.
    name: 'EMAIL_SERVICE_WEBHOOK_SECRET',
    why: 'outbound webhook signatures to CP/PSA will not be authenticated',
  },
  {
    // Required only for domain provisioning (SendGrid + Cloudflare orchestration), not for the send
    // path a new tenant's welcome email takes. Deliberately not a hard boot gate so a deployment that
    // does not provision domains can still send email.
    name: 'CLOUDFLARE_API_TOKEN',
    why: 'subdomain domain provisioning (Cloudflare DNS) will fail',
  },
  {
    name: 'CLOUDFLARE_ZONE_ID',
    why: 'subdomain domain provisioning (Cloudflare DNS) will fail',
  },
];

/**
 * Validate secrets at startup. Throws (→ refuse to start) if any required secret is unset/blank;
 * warns for recommended ones. Call once from server bootstrap, AFTER dotenv.config().
 *
 * All missing required names are collected into a single message so an operator fixes them in one
 * pass rather than one restart per missing var.
 *
 * Refusing to start is defensible HERE specifically: unlike PSA or CP, this service has no function
 * at all without SendGrid, so a hard-down container that crash-loops with a clear log is a louder,
 * more correct signal than a running service reporting healthy while silently dropping every send. It
 * does not cascade badly into CP/PSA: they treat email-service as a best-effort, async dependency
 * (queue + retry + webhooks), so a connection-refused from a down container is if anything a cleaner
 * failure than accepted-then-silently-failed sends — provided the process fails fast BEFORE binding
 * the port, which is why the caller runs this ahead of app.listen().
 */
export function assertRequiredSecrets(): void {
  const missing: string[] = REQUIRED_ENV_SECRETS.filter(name => {
    const v = process.env[name];
    return !v || v.trim().length === 0;
  });

  // The PSA-presentable key has a documented two-var fallback (psa-auth.ts): either
  // EMAIL_SERVICE_TO_PSA_API_KEY or PSA_INTERNAL_API_KEY satisfies it, so gate on the resolved value
  // rather than one raw var (gating the raw var would wrongly reject a valid new-header-only config).
  if (psaApiKey().trim().length === 0) {
    missing.push('EMAIL_SERVICE_TO_PSA_API_KEY or PSA_INTERNAL_API_KEY');
  }

  if (missing.length > 0) {
    throw new Error(
      `Refusing to start: required secret(s) unset or empty: ${missing.join(', ')}. ` +
        'This service has no function without them. Fail-fast at startup is intentional — the ' +
        'alternative is a service that reports healthy while every send silently fails at SendGrid.',
    );
  }

  for (const { name, why } of RECOMMENDED_ENV_SECRETS) {
    const v = process.env[name];
    if (!v || v.trim().length === 0) {
      console.warn(`[Startup] ${name} is not set — ${why}.`);
    }
  }
}
