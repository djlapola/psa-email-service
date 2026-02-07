import { PrismaClient } from '@prisma/client';

const PSA_INTERNAL_API_URL = process.env.PSA_INTERNAL_API_URL || 'http://192.168.86.61:3000/api/internal/v1';
const PSA_INTERNAL_API_KEY = process.env.PSA_INTERNAL_API_KEY || '';

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
  }>;
  envelope?: {
    to?: string[];
    from?: string;
  };
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
    const emailLower = email.toLowerCase().trim();
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
          'X-Control-Plane-API-Key': PSA_INTERNAL_API_KEY,
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
   * Process an inbound email - route to PSA
   */
  async processInboundEmail(email: InboundEmail): Promise<{ success: boolean; ticketId?: string; isNew?: boolean; error?: string }> {
    try {
      // Parse the "to" address to determine tenant
      const toAddress = email.to.split(',')[0].trim(); // Take first recipient
      const parsed = this.parseEmailAddress(toAddress);

      if (!parsed.subdomain) {
        console.error(`[InboundService] Could not determine tenant from address: ${toAddress}`);
        return { success: false, error: 'Could not determine tenant from recipient address' };
      }

      // Look up tenant
      const tenant = await this.getTenantBySubdomain(parsed.subdomain);
      if (!tenant) {
        console.error(`[InboundService] Tenant not found for subdomain: ${parsed.subdomain}`);
        return { success: false, error: `Tenant not found for subdomain: ${parsed.subdomain}` };
      }

      console.log(`[InboundService] Processing email for tenant: ${tenant.tenantId}`);

      // Try to match to existing ticket
      const match = await this.matchEmailToTicket(email, tenant.tenantId);

      if (match) {
        // Add comment to existing ticket
        return await this.addCommentToTicket(email, match.ticketId, tenant.tenantId, parsed.subdomain);
      } else {
        // Create new ticket
        return await this.createTicketFromEmail(email, tenant.tenantId, parsed.subdomain);
      }
    } catch (error: any) {
      console.error(`[InboundService] Process error:`, error);
      return { success: false, error: error.message };
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
          'X-Control-Plane-API-Key': PSA_INTERNAL_API_KEY,
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
          attachments: (email.attachments || []).map(a => ({ id: a.filename, filename: a.filename, contentType: a.contentType, size: 0 })),
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
          'X-Control-Plane-API-Key': PSA_INTERNAL_API_KEY,
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
          attachments: (email.attachments || []).map(a => ({ id: a.filename, filename: a.filename, contentType: a.contentType, size: 0 })),
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
