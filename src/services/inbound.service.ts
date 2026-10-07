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

  return {
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
  };
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
   * Strip quoted reply text from email body
   * Removes content after common quote indicators like "On ... wrote:" or lines starting with ">"
   */
  private stripQuotedText(text: string): string {
    if (!text) return '';

    // Split into lines
    const lines = text.split('\n');
    const cleanLines: string[] = [];

    for (const line of lines) {
      // Stop at "On ... wrote:" pattern (Gmail, Apple Mail)
      if (/^On .+ wrote:$/i.test(line.trim())) {
        break;
      }

      // Stop at "From:" header pattern (Outlook)
      if (/^From:\s*.+/i.test(line.trim())) {
        break;
      }

      // Stop at separator lines (common in many clients)
      if (/^-{3,}/.test(line.trim()) || /^_{3,}/.test(line.trim())) {
        break;
      }

      // Skip lines that start with ">" (quoted text)
      if (line.trim().startsWith('>')) {
        continue;
      }

      cleanLines.push(line);
    }

    // Trim trailing whitespace and return
    return cleanLines.join('\n').trim();
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
  // DEPRECATED — local classification (unused as of the thin-forwarder change).
  //
  // PSA now owns reply-vs-new-ticket classification. The methods below
  // (matchEmailToTicket, findTicketByMessageId, parseTicketIdFromText,
  // findTicketByNumber, storeMessageId, createTicketFromEmail,
  // addCommentToTicket, getAdditionalRecipients, stripQuotedText) are no longer
  // called by processInboundEmail. They are retained for one release so the
  // change is a pure routing swap and easy to revert; they can be deleted — see
  // the report's "dead code" list. Nothing in the inbound path reads or writes
  // the EmailMessageId table anymore.
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
   * Store a Message-ID for future ticket matching
   */
  async storeMessageId(tenantId: string, ticketId: string, messageId: string, commentId?: string): Promise<void> {
    // Clean the message ID
    const cleanMessageId = messageId.replace(/^<|>$/g, '').trim();

    await this.prisma.emailMessageId.create({
      data: {
        tenantId,
        ticketId,
        commentId: commentId || null,
        messageId: cleanMessageId,
      },
    });

    console.log(`[InboundService] Stored Message-ID: ${cleanMessageId} for ticket ${ticketId}`);
  }

  /**
   * Extract just the email address from a "From" field
   * Handles formats like: "Name <email@example.com>" or just "email@example.com"
   */
  private extractEmailAddress(from: string): string {
    const match = from.match(/<([^>]+)>/);
    if (match) {
      return match[1].toLowerCase();
    }
    // If no angle brackets, assume it's just the email
    return from.trim().toLowerCase();
  }

  /**
   * Extract additional recipients (TO excluding support@, plus all CC) for watcher handling
   * Always parses the TO header since envelope.to only contains the address SendGrid received for
   */
  private getAdditionalRecipients(email: InboundEmail, subdomain: string): string {
    console.log(`[InboundService] getAdditionalRecipients - to: "${email.to}", cc: "${email.cc}", envelope: ${JSON.stringify(email.envelope)}, subdomain: "${subdomain}"`);
    const supportEmail = `support@${subdomain}.${this.baseDomain}`.toLowerCase();
    const recipients: string[] = [];

    // Always parse TO header - it contains ALL recipients
    // (envelope.to only contains the address SendGrid actually received for)
    if (email.to) {
      const toAddresses = email.to.split(',').map(e => e.trim()).filter(Boolean);
      for (const addr of toAddresses) {
        const emailMatch = addr.match(/<([^>]+)>/);
        const emailAddr = (emailMatch ? emailMatch[1] : addr).trim().toLowerCase();
        if (emailAddr && emailAddr !== supportEmail && !recipients.includes(emailAddr)) {
          recipients.push(emailAddr);
        }
      }
    }

    // Add all CC addresses
    if (email.cc) {
      const ccAddresses = email.cc.split(',').map(e => e.trim()).filter(Boolean);
      for (const addr of ccAddresses) {
        const emailMatch = addr.match(/<([^>]+)>/);
        const emailAddr = (emailMatch ? emailMatch[1] : addr).trim().toLowerCase();
        if (emailAddr && !recipients.includes(emailAddr)) {
          recipients.push(emailAddr);
        }
      }
    }

    console.log(`[InboundService] Final additionalRecipients: "${recipients.join(', ')}"`);
    return recipients.join(', ');
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
    try {
      const response = await fetch(`${PSA_INTERNAL_API_URL}/inbound/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PSA_API_KEY_HEADER]: psaApiKey(),
          'X-Tenant-Id': payload.tenantId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return classifyPsaStatus(response.status);
    } catch (error: any) {
      if (error?.name === 'AbortError') return { kind: 'timeout' };
      return { kind: 'network-error', message: error?.message || 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Create a new ticket from an inbound email
   */
  private async createTicketFromEmail(email: InboundEmail, tenantId: string, subdomain: string): Promise<{ success: boolean; ticketId?: string; isNew?: boolean; error?: string }> {
    try {
      console.log(`[InboundService] Creating new ticket for tenant: ${tenantId}`);

      const response = await fetch(`${PSA_INTERNAL_API_URL}/tickets/from-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PSA_API_KEY_HEADER]: psaApiKey(),
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({
          tenantSubdomain: subdomain,
          fromEmail: this.extractEmailAddress(email.from),
          fromName: email.from.replace(/<.*>/, "").trim().replace(/^["']|["']$/g, '') || this.extractEmailAddress(email.from),
          toEmail: email.to,
          additionalRecipients: this.getAdditionalRecipients(email, subdomain),
          subject: email.subject || "No Subject",
          bodyText: this.stripQuotedText(email.text || ""),
          bodyHtml: this.stripQuotedText(email.html || ""),
          messageId: email.headers?.["message-id"] || email.headers?.["Message-ID"] || "",
          inReplyTo: email.headers?.["in-reply-to"] || email.headers?.["In-Reply-To"] || null,
          references: (email.headers?.["references"] || email.headers?.["References"] || "").split(/\s+/).filter(Boolean),
          attachments: (email.attachments || []).map(a => ({ filename: a.filename, content: a.content, mimeType: a.contentType, contentId: a.contentId, fileSize: a.size || 0 })),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[InboundService] PSA create ticket error: ${response.status} ${errorText}`);
        return { success: false, error: `PSA error: ${response.status}` };
      }

      const result = await response.json() as { ticketId?: string; id?: string };
      const ticketId = result.ticketId || result.id;

      console.log(`[InboundService] Created ticket: ${ticketId}`);

      // Store the Message-ID for future matching
      const messageId = email.headers?.['message-id'] || email.headers?.['Message-ID'];
      if (messageId && ticketId) {
        await this.storeMessageId(tenantId, ticketId, messageId);
      }

      return { success: true, ticketId, isNew: true };
    } catch (error: any) {
      console.error(`[InboundService] Create ticket error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add a comment to an existing ticket
   */
  private async addCommentToTicket(email: InboundEmail, ticketId: string, tenantId: string, subdomain: string): Promise<{ success: boolean; ticketId?: string; isNew?: boolean; error?: string }> {
    try {
      console.log(`[InboundService] Adding comment to ticket: ${ticketId}`);

      const response = await fetch(`${PSA_INTERNAL_API_URL}/tickets/${ticketId}/comments/from-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [PSA_API_KEY_HEADER]: psaApiKey(),
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({
          tenantId,
          tenantSubdomain: subdomain,
          fromEmail: this.extractEmailAddress(email.from),
          fromName: email.from.replace(/<.*>/, "").trim().replace(/^["']|["']$/g, '') || this.extractEmailAddress(email.from),
          additionalRecipients: this.getAdditionalRecipients(email, subdomain),
          bodyText: this.stripQuotedText(email.text || ""),
          bodyHtml: this.stripQuotedText(email.html || ""),
          messageId: email.headers?.["message-id"] || email.headers?.["Message-ID"] || "",
          attachments: (email.attachments || []).map(a => ({ filename: a.filename, content: a.content, mimeType: a.contentType, contentId: a.contentId, fileSize: a.size || 0 })),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[InboundService] PSA add comment error: ${response.status} ${errorText}`);
        return { success: false, error: `PSA error: ${response.status}` };
      }

      const result = await response.json() as { commentId?: string; id?: string };
      const commentId = result.commentId || result.id;

      console.log(`[InboundService] Added comment to ticket: ${ticketId}`);

      // Store the Message-ID for future matching
      const messageId = email.headers?.['message-id'] || email.headers?.['Message-ID'];
      if (messageId) {
        await this.storeMessageId(tenantId, ticketId, messageId, commentId);
      }

      return { success: true, ticketId, isNew: false };
    } catch (error: any) {
      console.error(`[InboundService] Add comment error:`, error);
      return { success: false, error: error.message };
    }
  }
}

export function createInboundService(prisma: PrismaClient): InboundService {
  return new InboundService(prisma);
}
