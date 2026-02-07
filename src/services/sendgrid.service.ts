import sgMail from '@sendgrid/mail';
import { PrismaClient } from '@prisma/client';

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tenantId?: string;
  tags?: { name: string; value: string }[];
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class SendGridService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Get the from address and replyTo for a given tenant
   * If tenant has a verified domain, use their custom from address
   * Otherwise, use the default with tenant's replyTo if configured
   */
  private async getTenantEmailConfig(tenantId?: string): Promise<{
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
      const tenantConfig = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      if (!tenantConfig) {
        return { from: defaultFrom };
      }

      // If tenant has a verified domain, use their custom from address
      if (tenantConfig.domainVerified && tenantConfig.fromEmail) {
        const fromName = tenantConfig.fromName || defaultFromName;
        return {
          from: `${fromName} <${tenantConfig.fromEmail}>`,
          replyTo: tenantConfig.replyTo || undefined,
        };
      }

      // Tenant exists but domain not verified - use default from with tenant's replyTo
      return {
        from: defaultFrom,
        replyTo: tenantConfig.replyTo || tenantConfig.fromEmail || undefined,
      };
    } catch (error) {
      console.error('Error fetching tenant email config:', error);
      return { from: defaultFrom };
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    // Get tenant-specific email configuration
    const tenantConfig = await this.getTenantEmailConfig(options.tenantId);

    // Use explicit from/replyTo if provided, otherwise use tenant config
    const from = options.from || tenantConfig.from;
    const replyTo = options.replyTo || tenantConfig.replyTo;

    try {
      const msg: sgMail.MailDataRequired = {
        from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text || '',
        replyTo: replyTo,
        headers: options.headers,
      };

      if (options.tags && options.tags.length > 0) {
        msg.categories = options.tags.map(t => `${t.name}:${t.value}`);
      }

      const [response] = await sgMail.send(msg);

      return {
        success: true,
        messageId: response.headers['x-message-id'] as string,
      };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || 'Unknown error';
      console.error('SendGrid API error:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}

export function createSendGridService(prisma: PrismaClient): SendGridService {
  return new SendGridService(prisma);
}
