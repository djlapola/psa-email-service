import { Resend } from 'resend';
import { PrismaClient } from '@prisma/client';

const resend = new Resend(process.env.RESEND_API_KEY);

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
  resendId?: string;
  error?: string;
}

export class ResendService {
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
      const result = await resend.emails.send({
        from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
        reply_to: replyTo,
        tags: options.tags,
        headers: options.headers,
      });

      if (result.error) {
        return {
          success: false,
          error: result.error.message,
        };
      }

      return {
        success: true,
        resendId: result.data?.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Resend API error:', errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Verify Resend webhook signature
   */
  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.warn('RESEND_WEBHOOK_SECRET not configured, skipping signature verification');
      return true; // Allow in development
    }

    try {
      // Resend uses svix for webhooks
      // For now, we'll do basic validation
      // In production, use the svix library for proper verification
      const crypto = require('crypto');
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('hex');

      return signature === expectedSignature || signature.includes(expectedSignature);
    } catch (error) {
      console.error('Webhook signature verification failed:', error);
      return false;
    }
  }
}

export function createResendService(prisma: PrismaClient): ResendService {
  return new ResendService(prisma);
}
