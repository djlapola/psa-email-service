import sgClient from '@sendgrid/client';
import { PrismaClient } from '@prisma/client';
import { cloudflareService } from './cloudflare.service';

sgClient.setApiKey(process.env.SENDGRID_API_KEY || '');

interface DomainProvisionResult {
  success: boolean;
  domain?: string;
  sendgridDomainId?: string;
  status?: string;
  error?: string;
}

interface DomainStatus {
  tenantId: string;
  domain: string;
  sendgridDomainId: string | null;
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'not_provisioned';
  dnsRecordsCreated: boolean;
  lastChecked: Date | null;
  receivingEnabled: boolean;
  receivingVerified: boolean;
}

class DomainService {
  private baseDomain: string;
  private prisma: PrismaClient;
  private inboundWebhookUrl: string;

  constructor(prisma: PrismaClient) {
    this.baseDomain = process.env.BASE_DOMAIN || 'skyrack.com';
    this.prisma = prisma;
    this.inboundWebhookUrl = process.env.SENDGRID_INBOUND_WEBHOOK_URL || '';
  }

  /**
   * Provision a new email domain for a tenant
   * 1. Create domain authentication in SendGrid
   * 2. Add DNS records to Cloudflare
   * 3. Store config in database
   */
  async provisionTenantDomain(
    tenantId: string,
    subdomain: string
  ): Promise<DomainProvisionResult> {
    const fullDomain = `${subdomain}.${this.baseDomain}`;

    try {
      console.log(`[DomainService] Provisioning domain ${fullDomain} for tenant ${tenantId}`);

      // Step 1: Create domain authentication in SendGrid
      const [response, body] = await sgClient.request({
        method: 'POST',
        url: '/v3/whitelabel/domains',
        body: {
          domain: fullDomain,      // e.g., 'deskside.skyrack.com' - authenticate the full tenant domain
          subdomain: 'em',         // SendGrid creates DKIM records under em.deskside.skyrack.com
          automatic_security: true,
          default: false,
        },
      });

      const sendgridDomain = body as any;
      const sendgridDomainId = String(sendgridDomain.id);

      console.log(`[DomainService] SendGrid domain created with ID: ${sendgridDomainId}`);

      // Step 2: Extract DNS records from SendGrid response and create in Cloudflare
      // SendGrid returns a dns object with keys like mail_cname, dkim1, dkim2
      const dnsRecords = sendgridDomain.dns || {};
      const recordIds: string[] = [];
      const errors: string[] = [];

      for (const key of Object.keys(dnsRecords)) {
        const record = dnsRecords[key];
        if (record.host && record.data) {
          const result = await cloudflareService.createDnsRecord({
            type: (record.type || 'cname').toUpperCase() as 'MX' | 'TXT' | 'CNAME',
            name: record.host,
            content: record.data,
          });

          if (result.success && result.id) {
            recordIds.push(result.id);
          } else {
            errors.push(`Failed to create ${record.type} record for ${record.host}: ${result.error}`);
          }
        }
      }

      // Step 3: Add MX record for inbound email receiving
      const mxResult = await cloudflareService.createDnsRecord({
        type: 'MX',
        name: fullDomain,
        content: 'mx.sendgrid.net',
        priority: 10,
      });

      if (mxResult.success && mxResult.id) {
        recordIds.push(mxResult.id);
      } else {
        errors.push(`Failed to create MX record: ${mxResult.error}`);
      }

      if (errors.length > 0) {
        console.error(`[DomainService] DNS record errors:`, errors);
      }

      console.log(`[DomainService] Created ${recordIds.length} DNS records in Cloudflare`);

      // Step 4: Store in database (reusing resendDomainId field for SendGrid ID)
      await this.prisma.tenantEmailConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          domain: fullDomain,
          fromEmail: `support@${fullDomain}`,
          fromName: `${subdomain} Support`,
          resendDomainId: sendgridDomainId,
          cloudflareDnsRecordIds: recordIds,
          domainVerified: false,
          receivingEnabled: false,
          receivingVerified: false,
        },
        update: {
          domain: fullDomain,
          fromEmail: `support@${fullDomain}`,
          resendDomainId: sendgridDomainId,
          cloudflareDnsRecordIds: recordIds,
          domainVerified: false,
        },
      });

      // Step 5: Schedule verification after DNS propagation
      console.log(`[DomainService] Scheduling verification in 30s...`);
      setTimeout(async () => {
        await this.verifyDomain(tenantId);
      }, 30000);

      return {
        success: true,
        domain: fullDomain,
        sendgridDomainId,
        status: 'pending',
      };
    } catch (error: any) {
      console.error(`[DomainService] Provision error:`, error?.response?.body || error);
      return {
        success: false,
        error: error?.response?.body?.errors?.[0]?.message || error.message,
      };
    }
  }

  /**
   * Trigger domain verification in SendGrid
   */
  async verifyDomain(
    tenantId: string
  ): Promise<{ success: boolean; status?: string; error?: string }> {
    try {
      const config = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      if (!config?.resendDomainId) {
        return { success: false, error: 'No domain configured for tenant' };
      }

      console.log(`[DomainService] Validating domain: ${config.resendDomainId}`);

      const [response, body] = await sgClient.request({
        method: 'POST',
        url: `/v3/whitelabel/domains/${config.resendDomainId}/validate`,
      });

      const validation = body as any;
      const isValid = validation.valid === true;

      await this.prisma.tenantEmailConfig.update({
        where: { tenantId },
        data: {
          domainVerified: isValid,
          updatedAt: new Date(),
        },
      });

      console.log(`[DomainService] Domain validation result: ${isValid ? 'verified' : 'pending'}`);

      return {
        success: true,
        status: isValid ? 'verified' : 'pending',
      };
    } catch (error: any) {
      console.error(`[DomainService] Verify error:`, error?.response?.body || error);
      return {
        success: false,
        error: error?.response?.body?.errors?.[0]?.message || error.message,
      };
    }
  }

  /**
   * Get domain status for a tenant
   */
  async getDomainStatus(tenantId: string): Promise<DomainStatus> {
    const config = await this.prisma.tenantEmailConfig.findUnique({
      where: { tenantId },
    });

    if (!config || !config.resendDomainId) {
      return {
        tenantId,
        domain: '',
        sendgridDomainId: null,
        status: 'not_provisioned',
        dnsRecordsCreated: false,
        lastChecked: null,
        receivingEnabled: false,
        receivingVerified: false,
      };
    }

    // Check current status from SendGrid
    try {
      const [response, body] = await sgClient.request({
        method: 'GET',
        url: `/v3/whitelabel/domains/${config.resendDomainId}`,
      });

      const domainInfo = body as any;
      const isValid = domainInfo.valid === true;

      // Update database if status changed
      if (isValid && !config.domainVerified) {
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId },
          data: { domainVerified: true },
        });
      }

      return {
        tenantId,
        domain: config.domain || '',
        sendgridDomainId: config.resendDomainId,
        status: isValid ? 'verified' : 'pending',
        dnsRecordsCreated: ((config.cloudflareDnsRecordIds as string[]) || []).length > 0,
        lastChecked: new Date(),
        receivingEnabled: config.receivingEnabled,
        receivingVerified: config.receivingVerified,
      };
    } catch (error) {
      // Fall back to database status
      return {
        tenantId,
        domain: config.domain || '',
        sendgridDomainId: config.resendDomainId,
        status: config.domainVerified ? 'verified' : 'pending',
        dnsRecordsCreated: ((config.cloudflareDnsRecordIds as string[]) || []).length > 0,
        lastChecked: config.updatedAt,
        receivingEnabled: config.receivingEnabled,
        receivingVerified: config.receivingVerified,
      };
    }
  }

  /**
   * Enable receiving capability for an existing tenant domain
   * Sets up SendGrid Inbound Parse webhook for this domain
   */
  async enableReceiving(
    tenantId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      if (!config || !config.domain) {
        return { success: false, error: 'No domain configured for tenant' };
      }

      if (config.receivingEnabled) {
        return { success: true }; // Already enabled
      }

      if (!this.inboundWebhookUrl) {
        return { success: false, error: 'SENDGRID_INBOUND_WEBHOOK_URL not configured' };
      }

      console.log(`[DomainService] Setting up Inbound Parse for ${config.domain}`);

      const [response, body] = await sgClient.request({
        method: 'POST',
        url: '/v3/user/webhooks/parse/settings',
        body: {
          hostname: config.domain,
          url: this.inboundWebhookUrl,
          spam_check: true,
          send_raw: false,
        },
      });

      await this.prisma.tenantEmailConfig.update({
        where: { tenantId },
        data: {
          receivingEnabled: true,
          receivingVerified: true,
        },
      });

      console.log(`[DomainService] Inbound Parse enabled for ${config.domain}`);

      return { success: true };
    } catch (error: any) {
      console.error(`[DomainService] Enable receiving error:`, error?.response?.body || error);
      return {
        success: false,
        error: error?.response?.body?.errors?.[0]?.message || error.message,
      };
    }
  }

  /**
   * Remove a tenant's email domain
   */
  async deprovisionTenantDomain(
    tenantId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      if (!config) {
        return { success: true }; // Nothing to remove
      }

      // Remove Inbound Parse setting from SendGrid
      if (config.domain && config.receivingEnabled) {
        try {
          await sgClient.request({
            method: 'DELETE',
            url: `/v3/user/webhooks/parse/settings/${config.domain}`,
          });
        } catch (e: any) {
          console.warn(`[DomainService] Could not remove inbound parse: ${e.message}`);
        }
      }

      // Remove domain authentication from SendGrid
      if (config.resendDomainId) {
        try {
          await sgClient.request({
            method: 'DELETE',
            url: `/v3/whitelabel/domains/${config.resendDomainId}`,
          });
        } catch (e: any) {
          console.warn(`[DomainService] Could not remove SendGrid domain: ${e.message}`);
        }
      }

      // Remove DNS records from Cloudflare
      if (config.cloudflareDnsRecordIds && Array.isArray(config.cloudflareDnsRecordIds)) {
        await cloudflareService.removeTenantDnsRecords(config.cloudflareDnsRecordIds as string[]);
      }

      // Remove from database
      await this.prisma.tenantEmailConfig.delete({
        where: { tenantId },
      });

      return { success: true };
    } catch (error: any) {
      console.error(`[DomainService] Deprovision error:`, error);
      return { success: false, error: error.message };
    }
  }
}

export function createDomainService(prisma: PrismaClient): DomainService {
  return new DomainService(prisma);
}
