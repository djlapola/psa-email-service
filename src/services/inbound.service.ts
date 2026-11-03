import { PrismaClient } from '@prisma/client';
import { PSA_API_KEY_HEADER, psaApiKey } from '../lib/psa-auth';

const PSA_INTERNAL_API_URL = process.env.PSA_INTERNAL_API_URL || 'http://192.168.86.61:3000/api/internal/v1';

interface InboundEmail {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string; // base64 encoded
    contentType: string;
    contentId?: string; // For inline images (cid:xxx references)
    size: number;
  }>;
  envelope?: {
    to?: string[];
    from?: string;
  };
  // SendGrid sender-authentication fields, forwarded verbatim to PSA so it can
  // decide whether a staff reply is genuinely from that person. These are the raw
  // SendGrid Inbound Parse `SPF`/`dkim` form fields.
  spf?: string;
  dkim?: string;
  // Attachments the route dropped for exceeding the size budget (populated before
  // base64-encoding the kept ones). Forwarded to PSA so it can note them.
  skippedAttachments?: SkippedAttachment[];
  // ISO timestamp stamped by the route when SendGrid delivered the webhook.
  receivedAt?: string;
}

interface TicketMatch {
  ticketId: string;
  tenantId: string;
  matchMethod: 'in-reply-to' | 'references' | 'subject-pattern' | 'body-pattern';
}

interface ParsedEmailAddress {
  email: string;
  subdomain: string | null;
  baseDomain: string;
}

// ---------------------------------------------------------------------------
// Thin-forwarder types + pure helpers
//
// email-service no longer classifies inbound mail. It resolves the tenant from
// the recipient subdomain and forwards the parsed message to PSA, which owns
// classification (reply vs. new ticket) and failure tracking. Everything in
// this block is deliberately pure (no Prisma, no network) so it is unit-testable
// without infrastructure.
// ---------------------------------------------------------------------------

/** Hard cap on how long we wait for PSA before treating it as a timeout. */
const PSA_FORWARD_TIMEOUT_MS = 25_000;

export interface PsaInboundAttachment {
  filename: string;
  content: string; // base64
  mimeType: string;
  contentId?: string;
  fileSize: number;
}

/**
 * Attachment size budget (RAW bytes, before base64 expansion). PSA's inbound
 * route accepts up to 32 MiB of JSON (Cloud Run's HTTP/1.1 ceiling); base64
 * inflates bytes by ~33%, so we cap the raw total well under that. Files over the
 * budget are dropped and reported to PSA in `skippedAttachments` rather than
 * blowing the request past the ceiling (which PSA would 413).
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // per single file
export const MAX_TOTAL_ATTACHMENT_BYTES = 22 * 1024 * 1024; // raw total across one email
/** Inline images (contentId) under this size are always kept so bodies don't break. */
const INLINE_KEEP_MAX_BYTES = 1 * 1024 * 1024;

/** An attachment the relay dropped for exceeding the size budget. Forwarded to PSA. */
export interface SkippedAttachment {
  filename: string;
  size: number; // raw bytes
  reason: 'too_large';
}

/**
 * Sender-authentication data forwarded to PSA. PSA uses this to decide whether an
 * inbound staff reply genuinely came from that person (authenticated -> public
 * reply; unverified/missing -> internal note). Every field except `source` is
 * omitted when it can't be determined; never fabricate a verdict. We deliberately
 * do NOT forward Authentication-Results headers: SendGrid does not stamp its own,
 * so any such header is sender-controllable and PSA ignores it.
 */
export interface PsaInboundAuth {
  spf?: string;
  dkim?: string;
  envelopeFrom?: string;
  source: 'sendgrid';
}

export interface PsaInboundPayload {
  tenantId: string;
  tenantSubdomain: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  messageId: string;
  recipients: { to: string[]; cc: string[] };
  inReplyTo: string | null;
  references: string[];
  autoSubmitted: string | null;
  precedence: string | null;
  xAutoreply: string | null;
  receivedAt: string;
  attachments: PsaInboundAttachment[];
  skippedAttachments?: SkippedAttachment[];
  auth: PsaInboundAuth;
}

/**
 * Outcome of a forward attempt. The route maps this to the SendGrid response:
 *   psa-success / psa-client-error / tenant-unresolved -> 200 (ack, don't retry)
 *   psa-server-error / timeout / network-error         -> 5xx (ask SendGrid to retry)
 */
export type ForwardResult =
  | { kind: 'psa-success' }
  | { kind: 'psa-client-error'; status: number }
  | { kind: 'psa-server-error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network-error'; message: string }
  | { kind: 'tenant-unresolved'; reason: string };

/** Extract one bare lowercased address from a "Name <a@b>" or "a@b" string. */
export function extractOneAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** Split a comma-separated recipient header into bare lowercased addresses. */
export function extractAddresses(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).trim().toLowerCase();
    })
    .filter(Boolean);
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Apply the attachment size budget to a list of attachments, operating on RAW
 * byte sizes (call this BEFORE base64-encoding so dropped files are never
 * encoded or forwarded). Rules:
 *   1. Any file over MAX_ATTACHMENT_BYTES is dropped.
 *   2. While the kept raw total still exceeds MAX_TOTAL_ATTACHMENT_BYTES, drop
 *      the LARGEST remaining file, one at a time, until it fits.
 *   3. A file that is under INLINE_KEEP_MAX_BYTES AND has a contentId (an inline
 *      image) is NEVER dropped, so message bodies that reference it don't break.
 * Returns the kept attachments (input order preserved) and a `skipped` record for
 * each dropped file. Pure; never throws.
 */
export function applyAttachmentBudget<T extends { filename: string; size: number; contentId?: string }>(
  attachments: T[],
): { kept: T[]; skipped: SkippedAttachment[] } {
  const skipped: SkippedAttachment[] = [];
  const isProtectedInline = (a: T) => !!a.contentId && a.size < INLINE_KEEP_MAX_BYTES;

  // Pass 1: per-file cap. (A protected inline image is < 1 MB so it can never
  // exceed the 25 MB cap, but we guard explicitly for clarity.)
  let kept: T[] = [];
  for (const a of attachments) {
    if (a.size > MAX_ATTACHMENT_BYTES && !isProtectedInline(a)) {
      skipped.push({ filename: a.filename, size: a.size, reason: 'too_large' });
    } else {
      kept.push(a);
    }
  }

  // Pass 2: total budget — drop the largest droppable file until the raw total fits.
  const rawTotal = (list: T[]) => list.reduce((sum, a) => sum + a.size, 0);
  while (rawTotal(kept) > MAX_TOTAL_ATTACHMENT_BYTES) {
    const droppable = kept.filter((a) => !isProtectedInline(a));
    if (droppable.length === 0) break; // only protected inline images remain
    let largest = droppable[0];
    for (const a of droppable) if (a.size > largest.size) largest = a;
    kept = kept.filter((a) => a !== largest);
    skipped.push({ filename: largest.filename, size: largest.size, reason: 'too_large' });
  }

  return { kept, skipped };
}

/**
 * Build the optional `auth` object relayed to PSA from the SendGrid sender-
 * authentication fields. Purely additive: `spf`/`dkim`/`envelopeFrom` are each
 * included only when present (verbatim), so PSA can tell "missing" from a real
 * verdict; `source` is always 'sendgrid'. Never throws — a bad/missing field is
 * simply omitted.
 */
export function buildAuthObject(email: InboundEmail): PsaInboundAuth {
  const auth: PsaInboundAuth = { source: 'sendgrid' };
  if (email.spf) auth.spf = email.spf;
  if (email.dkim) auth.dkim = email.dkim;
  const envelopeFrom = email.envelope?.from;
  if (envelopeFrom) auth.envelopeFrom = envelopeFrom;
  return auth;
}

/**
 * Build the recipients object PSA requires to validate the mail belongs to the
 * tenant. `to` is the union of the parsed To header and the SMTP envelope
 * recipients (envelope.to is the address SendGrid actually received for); `cc`
 * is the parsed Cc header. Unlike the legacy watcher logic, the tenant's own
 * support@ address is NOT stripped — PSA needs the real recipient set.
 */
export function buildRecipients(email: InboundEmail): { to: string[]; cc: string[] } {
  const envelopeTo = (email.envelope?.to || []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const to = dedupe([...extractAddresses(email.to), ...envelopeTo]);
  const cc = dedupe(extractAddresses(email.cc));
  return { to, cc };
}

/**
 * Build the exact JSON payload POSTed to PSA's inbound endpoint. Bodies are
 * forwarded verbatim (no quoted-reply stripping) — PSA owns that now.
 */
export function buildPsaInboundPayload(
  email: InboundEmail,
  tenantId: string,
  tenantSubdomain: string,
): PsaInboundPayload {
  const headers = email.headers || {};
  const fromEmail = extractOneAddress(email.from || '');
  const fromName =
    (email.from || '').replace(/<.*>/, '').trim().replace(/^["']|["']$/g, '') || fromEmail;
  const references = (headers['references'] || headers['References'] || '')
    .split(/\s+/)
    .filter(Boolean);

  const payload: PsaInboundPayload = {
    tenantId,
    tenantSubdomain,
    fromEmail,
    fromName,
    subject: email.subject || '',
    bodyText: email.text || '',
    bodyHtml: email.html || '',
    messageId: headers['message-id'] || headers['Message-ID'] || '',
    recipients: buildRecipients(email),
    inReplyTo: headers['in-reply-to'] || headers['In-Reply-To'] || null,
    references,
    autoSubmitted: headers['auto-submitted'] || headers['Auto-Submitted'] || null,
    precedence: headers['precedence'] || headers['Precedence'] || null,
    xAutoreply: headers['x-autoreply'] || headers['X-Autoreply'] || null,
    receivedAt: email.receivedAt || new Date().toISOString(),
    attachments: (email.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      mimeType: a.contentType,
      contentId: a.contentId,
      fileSize: a.size || 0,
    })),
    auth: buildAuthObject(email),
  };

  // Only include skippedAttachments when at least one was dropped.
  if (email.skippedAttachments && email.skippedAttachments.length > 0) {
    payload.skippedAttachments = email.skippedAttachments;
  }

  return payload;
}

/**
 * Classify a PSA HTTP status into a forward outcome.
 *   2xx                 -> success (PSA accepted; any ticket outcome is PSA's business)
 *   5xx, 408, 429, 401  -> server-error (transient; retrying may succeed)
 *   other 4xx (400/403/404…) -> client-error (deterministic; retrying won't help)
 *
 * 401 is treated as retryable on purpose: a 401 from PSA means this service's
 * API key/header is wrong or stale (a config/rotation problem), NOT bad mail.
 * Acking it would silently drop real mail during an auth misconfiguration, so we
 * force SendGrid to keep retrying while the credential is fixed.
 */
export function classifyPsaStatus(status: number): ForwardResult {
  if (status >= 200 && status < 300) return { kind: 'psa-success' };
  if (status >= 500 || status === 408 || status === 429 || status === 401) {
    return { kind: 'psa-server-error', status };
  }
  return { kind: 'psa-client-error', status };
}

class InboundService {
  private prisma: PrismaClient;
  private baseDomain: string;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.baseDomain = process.env.BASE_DOMAIN || 'skyrack.com';
  }

  /**
   * Parse email address to extract subdomain
   * e.g., support@deskside.skyrack.com -> { email: 'support@deskside.skyrack.com', subdomain: 'deskside', baseDomain: 'skyrack.com' }
   */
  parseEmailAddress(email: string): ParsedEmailAddress {
    let cleaned = email.trim();
    // Extract email from angle brackets if present: "Name" <email@domain.com> or <email@domain.com>
    const angleMatch = cleaned.match(/<([^>]+)>/);
    if (angleMatch) {
      cleaned = angleMatch[1].trim();
    }
    const emailLower = cleaned.toLowerCase();
    const atIndex = emailLower.indexOf('@');
    if (atIndex === -1) {
      return { email: emailLower, subdomain: null, baseDomain: '' };
    }

    const domain = emailLower.substring(atIndex + 1);

    // Check if this is a tenant subdomain (e.g., tenant.skyrack.com)
    if (domain.endsWith(`.${this.baseDomain}`)) {
      const subdomain = domain.replace(`.${this.baseDomain}`, '');
      return { email: emailLower, subdomain, baseDomain: this.baseDomain };
    }

    return { email: emailLower, subdomain: null, baseDomain: domain };
  }

  /**
   * Look up tenant by subdomain
   */
  async getTenantBySubdomain(subdomain: string): Promise<{ tenantId: string; domain: string } | null> {
    const domain = `${subdomain}.${this.baseDomain}`;
    const config = await this.prisma.tenantEmailConfig.findFirst({
      where: { domain },
    });

    if (!config) {
      return null;
    }

    return { tenantId: config.tenantId, domain: config.domain || domain };
  }

  // =========================================================================
  // DEPRECATED — local ticket matching (unused as of the thin-forwarder change).
  //
  // PSA now owns reply-vs-new-ticket classification. The methods below
  // (matchEmailToTicket, findTicketByMessageId, parseTicketIdFromText,
  // findTicketByNumber) are no longer called by processInboundEmail; they are
  // retained for one release so the change is easy to revert. The PSA write-path
  // methods (createTicketFromEmail, addCommentToTicket) and their helpers
  // (storeMessageId, extractEmailAddress, getAdditionalRecipients,
  // stripQuotedText) have been removed. Nothing in the inbound path reads or
  // writes the EmailMessageId table anymore.
  // =========================================================================

  /**
   * Try to match an inbound email to an existing ticket
   * Returns ticket info if matched, null if this should create a new ticket
   */
  async matchEmailToTicket(email: InboundEmail, tenantId: string): Promise<TicketMatch | null> {
    const headers = email.headers || {};

    // Method 1: Check In-Reply-To header against stored Message-IDs
    const inReplyTo = headers['in-reply-to'] || headers['In-Reply-To'];
    if (inReplyTo) {
      const match = await this.findTicketByMessageId(inReplyTo, tenantId);
      if (match) {
        console.log(`[InboundService] Matched by In-Reply-To: ${inReplyTo} -> ticket ${match.ticketId}`);
        return { ...match, matchMethod: 'in-reply-to' };
      }
    }

    // Method 2: Check References header against stored Message-IDs
    const references = headers['references'] || headers['References'];
    if (references) {
      // References can contain multiple Message-IDs separated by whitespace
      const messageIds = references.split(/\s+/).filter(Boolean);
      for (const messageId of messageIds) {
        const match = await this.findTicketByMessageId(messageId.trim(), tenantId);
        if (match) {
          console.log(`[InboundService] Matched by References: ${messageId} -> ticket ${match.ticketId}`);
          return { ...match, matchMethod: 'references' };
        }
      }
    }

    // Method 3: Parse subject for [TKT-XXXXXX] pattern
    const ticketNumber = this.parseTicketIdFromText(email.subject);
    if (ticketNumber) {
      const ticketId = await this.findTicketByNumber(ticketNumber, tenantId);
      if (ticketId) {
        console.log(`[InboundService] Matched by subject pattern: ${ticketNumber} -> ticket ${ticketId}`);
        return { ticketId, tenantId, matchMethod: 'subject-pattern' };
      }
    }

    // Method 4: Parse body for [TKT-XXXXXX] pattern
    const bodyText = email.text || '';
    const bodyTicketNumber = this.parseTicketIdFromText(bodyText);
    if (bodyTicketNumber) {
      const ticketId = await this.findTicketByNumber(bodyTicketNumber, tenantId);
      if (ticketId) {
        console.log(`[InboundService] Matched by body pattern: ${bodyTicketNumber} -> ticket ${ticketId}`);
        return { ticketId, tenantId, matchMethod: 'body-pattern' };
      }
    }

    // No match found - this will create a new ticket
    return null;
  }

  /**
   * Find ticket by Message-ID in our database
   */
  private async findTicketByMessageId(messageId: string, tenantId: string): Promise<{ ticketId: string; tenantId: string } | null> {
    // Clean the message ID (remove angle brackets if present)
    const cleanMessageId = messageId.replace(/^<|>$/g, '').trim();

    const record = await this.prisma.emailMessageId.findFirst({
      where: {
        messageId: cleanMessageId,
        tenantId,
      },
    });

    if (record) {
      return { ticketId: record.ticketId, tenantId: record.tenantId };
    }

    return null;
  }

  /**
   * Parse ticket number from text using [TKT-XXXXXX] pattern
   */
  private parseTicketIdFromText(text: string): string | null {
    if (!text) return null;
    // Match [TKT-000011] and capture the full "TKT-000011"
    const match = text.match(/\[(TKT-\d{6})\]/i);
    if (match) {
      return match[1]; // Return "TKT-000011"
    }
    return null;
  }

  /**
   * Look up ticket ID by ticket number (e.g., "TKT-000011")
   */
  private async findTicketByNumber(ticketNumber: string, tenantId: string): Promise<string | null> {
    try {
      const response = await fetch(`${PSA_INTERNAL_API_URL}/tickets/by-number/${encodeURIComponent(ticketNumber)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          [PSA_API_KEY_HEADER]: psaApiKey(),
          'X-Tenant-Id': tenantId,
        },
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json() as { ticketId?: string; id?: string };
      return result.ticketId || result.id || null;
    } catch (error) {
      console.error('[InboundService] Error looking up ticket by number:', error);
      return null;
    }
  }

  /**
   * Resolve the tenant subdomain from the mail's recipients. Prefers the SMTP
   * envelope recipients (the address SendGrid actually received for), then the
   * To header, and returns the first address under the base domain.
   */
  private resolveSubdomain(email: InboundEmail): string | null {
    const candidates = [...(email.envelope?.to || []), ...extractAddresses(email.to)];
    for (const cand of candidates) {
      const parsed = this.parseEmailAddress(cand);
      if (parsed.subdomain) return parsed.subdomain;
    }
    return null;
  }

  /**
   * Thin forwarder: resolve the tenant from the recipient subdomain and POST the
   * parsed message to PSA. No local classification, no EmailMessageId access.
   * Returns a ForwardResult the route maps to the SendGrid response.
   */
  async processInboundEmail(email: InboundEmail): Promise<ForwardResult> {
    const subdomain = this.resolveSubdomain(email);
    if (!subdomain) {
      return { kind: 'tenant-unresolved', reason: `no base-domain recipient in to/envelope` };
    }

    const tenant = await this.getTenantBySubdomain(subdomain);
    if (!tenant) {
      return { kind: 'tenant-unresolved', reason: `unknown subdomain: ${subdomain}` };
    }

    const payload = buildPsaInboundPayload(email, tenant.tenantId, subdomain);
    return this.forwardToPsa(payload);
  }

  /**
   * POST the inbound payload to PSA's internal inbound endpoint with a 25s
   * timeout. Never logs bodies or attachments.
   */
  private async forwardToPsa(payload: PsaInboundPayload): Promise<ForwardResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PSA_FORWARD_TIMEOUT_MS);
    const body = JSON.stringify(payload);
    try {
      const response = await fetch(`${PSA_INTERNAL_API_URL}/inbound/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PSA_API_KEY_HEADER]: psaApiKey(),
          'X-Tenant-Id': payload.tenantId,
        },
        body,
        signal: controller.signal,
      });
      if (response.status === 413) {
        // Attachments were already size-budgeted, so a 413 is unexpected and
        // retrying the same payload won't help — log loudly (metadata only, no
        // body/attachment content) but still classify as client-error (200 ack).
        console.error(
          `[InboundService] PSA returned 413 Payload Too Large — tenant=${payload.tenantId} ` +
            `messageId=${payload.messageId || '(none)'} payloadBytes=${Buffer.byteLength(body)}. ` +
            `Acknowledging to SendGrid; retry would not help.`,
        );
      }
      return classifyPsaStatus(response.status);
    } catch (error: any) {
      if (error?.name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'network-error', message: error?.message || 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

}

export function createInboundService(prisma: PrismaClient): InboundService {
  return new InboundService(prisma);
}
