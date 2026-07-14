import sgMail from '@sendgrid/mail';
import { PrismaClient } from '@prisma/client';

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  fromPrefix?: string;
  replyTo?: string;
  tenantId?: string;
  tags?: { name: string; value: string }[];
  headers?: Record<string, string>;
  attachments?: Array<{
    content: string;    // base64 encoded content
    filename: string;
    type: string;       // MIME type, e.g., 'application/pdf'
    disposition?: string; // 'attachment' or 'inline'
  }>;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  from?: string;
}

export class SendGridService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Check if a domain has been verified as a BYOD custom domain for a tenant
   */
  private async hasVerifiedCustomDomain(tenantId: string, emailDomain: string): Promise<boolean> {
    try {
      // Check BYOD custom domains first
      const customDomain = await this.prisma.tenantEmailDomain.findUnique({
        where: { tenantId_domain: { tenantId, domain: emailDomain.toLowerCase() } },
      });
      if (customDomain?.status === 'verified') return true;

      // Also check if this matches the tenant's provisioned subdomain (e.g., deskside.skyrack.com)
      const tenantConfig = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });
      if (tenantConfig?.domainVerified && tenantConfig?.domain) {
        if (tenantConfig.domain.toLowerCase() === emailDomain.toLowerCase()) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the from address and replyTo for a given tenant
   * If tenant has a verified domain, use their custom from address
   * Otherwise, use the default with tenant's replyTo if configured
   */
  private async getTenantEmailConfig(tenantId?: string, requestedFrom?: string, fromPrefix?: string): Promise<{
    from: string;
    replyTo?: string;
  }> {
    const defaultFromName = process.env.EMAIL_FROM_NAME || 'Skyrack PSA';
    const defaultFromEmail = process.env.EMAIL_FROM || 'psa@skyrack.com';
    const defaultFrom = `${defaultFromName} <${defaultFromEmail}>`;

    if (!tenantId) {
      return { from: defaultFrom };
    }

    try {
      // If a specific from address was requested, check if its domain is a verified BYOD domain
      if (requestedFrom) {
        const fromEmail = requestedFrom.match(/<([^>]+)>/)?.[1] || requestedFrom;
        const emailDomain = fromEmail.split('@')[1];
        if (emailDomain) {
          const isVerified = await this.hasVerifiedCustomDomain(tenantId, emailDomain);
          if (isVerified) {
            // Custom domain is verified — send from the requested address directly
            return { from: requestedFrom };
          }
          // Custom domain not verified — fall back to default, set requested as replyTo
          return {
            from: defaultFrom,
            replyTo: fromEmail,
          };
        }
      }

      const tenantConfig = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      // Resolve the display name once, independent of which sending path wins.
      const fromName = tenantConfig?.fromName || defaultFromName;

      // Caller-supplied local-part: compose the address on the tenant's own verified
      // subdomain. Sanitize to a safe local-part and cap length.
      if (fromPrefix) {
        const sanitized = fromPrefix.toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 64);
        // Only compose against a VERIFIED subdomain. fromPrefix must NEVER be composed
        // against a BYOD domain from tenant_email_domains: a tenant configures exactly one
        // BYOD address (byodFromEmail), so synthesizing other local-parts on their domain
        // could produce an address that does not exist at their mail provider. Subdomain only.
        if (sanitized && tenantConfig?.domainVerified && tenantConfig.domain) {
          return {
            from: `${fromName} <${sanitized}@${tenantConfig.domain}>`,
            replyTo: tenantConfig?.replyTo || undefined,
          };
        }
        // Otherwise fall through to the normal resolution (do NOT compose against an
        // unverified domain).
      }

      // BYOD first: prefer a verified custom domain that has a configured from address.
      // A verified row with a NULL byodFromEmail must not be used (filtered out below);
      // never synthesize a local-part.
      const byod = await this.prisma.tenantEmailDomain.findFirst({
        where: { tenantId, status: 'verified', byodFromEmail: { not: null } },
        orderBy: [{ isDefault: 'desc' }, { verifiedAt: 'desc' }],
      });
      if (byod?.byodFromEmail) {
        // BYOD is SEND-ONLY: it authenticates whitelabel CNAMEs but adds no MX and no
        // Inbound Parse webhook, so a reply to the BYOD address never reaches us. The
        // tenant's verified subdomain (fromEmail) is the inbound ingest path that threads
        // replies back into tickets, so point Reply-To there. Do NOT "clean up" this
        // seemingly-redundant Reply-To — without it, replies to BYOD mail are lost.
        const byodReplyTo =
          tenantConfig?.replyTo ||
          (tenantConfig?.domainVerified && tenantConfig.fromEmail ? tenantConfig.fromEmail : undefined);
        return {
          from: `${fromName} <${byod.byodFromEmail}>`,
          replyTo: byodReplyTo,
        };
      }

      // If tenant has a verified subdomain (skyrack.com), use their configured from address
      if (tenantConfig?.domainVerified && tenantConfig.fromEmail) {
        return {
          from: `${fromName} <${tenantConfig.fromEmail}>`,
          replyTo: tenantConfig.replyTo || undefined,
        };
      }

      // Tenant exists but domain not verified - use default from with tenant's replyTo
      if (tenantConfig) {
        return {
          from: defaultFrom,
          replyTo: tenantConfig.replyTo || tenantConfig.fromEmail || undefined,
        };
      }

      // No tenant config at all
      return { from: defaultFrom };
    } catch (error) {
      console.error('Error fetching tenant email config:', error);
      return { from: defaultFrom };
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    // Get tenant-specific email configuration, passing requested from for BYOD domain check
    const tenantConfig = await this.getTenantEmailConfig(options.tenantId, options.from, options.fromPrefix);

    // getTenantEmailConfig resolves BYOD domains, subdomain config, and defaults
    const from = tenantConfig.from;
    const replyTo = options.replyTo || tenantConfig.replyTo;

    try {
      const msg: sgMail.MailDataRequired = {
        from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text || 'Please view this email in an HTML-compatible email client.',
        replyTo: replyTo,
        headers: options.headers,
      };

      if (options.tags && options.tags.length > 0) {
        msg.categories = options.tags.map(t => `${t.name}:${t.value}`);
      }

      if (options.attachments?.length) {
        msg.attachments = options.attachments.map(a => ({
          content: a.content,
          filename: a.filename,
          type: a.type,
          disposition: a.disposition || 'attachment',
        }));
      }

      const [response] = await sgMail.send(msg);

      return {
        success: true,
        messageId: response.headers['x-message-id'] as string,
        from,
      };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || 'Unknown error';
      console.error('SendGrid API error:', errorMessage);
      return { success: false, error: errorMessage, from };
    }
  }
}

export function createSendGridService(prisma: PrismaClient): SendGridService {
  return new SendGridService(prisma);
}
