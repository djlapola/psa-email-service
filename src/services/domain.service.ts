import { Resend } from 'resend';
import { PrismaClient } from '@prisma/client';
import { cloudflareService } from './cloudflare.service';

const resend = new Resend(process.env.RESEND_API_KEY);

interface DomainProvisionResult {
  success: boolean;
  domain?: string;
  resendDomainId?: string;
  status?: string;
  error?: string;
}

interface DomainStatus {
  tenantId: string;
  domain: string;
  resendDomainId: string | null;
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'not_provisioned';
  dnsRecordsCreated: boolean;
  lastChecked: Date | null;
  receivingEnabled: boolean;
  receivingVerified: boolean;
}

class DomainService {
  private baseDomain: string;
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.baseDomain = process.env.BASE_DOMAIN || 'skyrack.com';
    this.prisma = prisma;
  }

  /**
   * Provision a new email domain for a tenant
   * 1. Create domain in Resend
   * 2. Add DNS records to Cloudflare
   * 3. Trigger verification
   * 4. Store config in database
   */
  async provisionTenantDomain(
    tenantId: string,
    subdomain: string
  ): Promise<DomainProvisionResult> {
    const fullDomain = `${subdomain}.${this.baseDomain}`;

    console.log(`[DomainService] Provisioning domain: ${fullDomain} for tenant: ${tenantId}`);

    try {
      // Step 1: Create domain in Resend with sending AND receiving enabled
      console.log(`[DomainService] Creating domain in Resend with sending and receiving...`);
      const resendResult = await resend.domains.create({
        name: fullDomain,
        region: 'us-east-1',
      } as any); // Note: capabilities are set via separate API call after creation

      if (resendResult.error) {
        console.error(`[DomainService] Resend error:`, resendResult.error);
        return {
          success: false,
          error: `Resend error: ${resendResult.error.message}`,
        };
      }

      const resendDomain = resendResult.data!;
      console.log(`[DomainService] Resend domain created: ${resendDomain.id}`);

      // Step 1b: Enable receiving capability via PATCH
      console.log(`[DomainService] Enabling receiving capability...`);
      let receivingEnabled = false;
      let domainRecords = resendDomain.records;

      try {
        const updateResponse = await fetch(`https://api.resend.com/domains/${resendDomain.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ receiving: 'enabled' }),
        });

        if (updateResponse.ok) {
          receivingEnabled = true;
          console.log(`[DomainService] Receiving enabled for domain`);

          // Fetch updated domain info to get MX records
          const domainInfo = await resend.domains.get(resendDomain.id);
          if (domainInfo.data?.records) {
            domainRecords = domainInfo.data.records;
          }
        } else {
          const errorText = await updateResponse.text();
          console.warn(`[DomainService] Failed to enable receiving: ${errorText}`);
        }
      } catch (err) {
        console.warn(`[DomainService] Error enabling receiving:`, err);
      }

      // Step 2: Add DNS records to Cloudflare (including MX if receiving enabled)
      console.log(`[DomainService] Adding DNS records to Cloudflare...`);
      const dnsResult = await cloudflareService.addTenantDnsRecords(
        subdomain,
        domainRecords.map((r: any) => ({
          record: r.record,
          name: r.name,
          type: r.type,
          value: r.value,
          priority: r.priority,
        }))
      );

      if (!dnsResult.success) {
        console.error(`[DomainService] DNS errors:`, dnsResult.errors);
        // Don't fail completely - domain is created, DNS can be retried
      }

      // Step 3: Store in database
      console.log(`[DomainService] Storing config in database...`);
      await this.prisma.tenantEmailConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          fromEmail: `support@${fullDomain}`,
          fromName: `${subdomain} Support`,
          domain: fullDomain,
          domainVerified: false,
          resendDomainId: resendDomain.id,
          cloudflareDnsRecordIds: dnsResult.recordIds,
          receivingEnabled,
          receivingVerified: false,
        },
        update: {
          fromEmail: `support@${fullDomain}`,
          domain: fullDomain,
          resendDomainId: resendDomain.id,
          cloudflareDnsRecordIds: dnsResult.recordIds,
          receivingEnabled,
          receivingVerified: false,
        },
      });

      // Step 4: Trigger verification (with delay to allow DNS propagation)
      console.log(`[DomainService] Scheduling verification...`);
      setTimeout(async () => {
        await this.verifyDomain(tenantId);
      }, 30000); // Wait 30 seconds for DNS propagation

      return {
        success: true,
        domain: fullDomain,
        resendDomainId: resendDomain.id,
        status: resendDomain.status,
      };
    } catch (error: any) {
      console.error(`[DomainService] Provision error:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Trigger domain verification in Resend
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

      console.log(`[DomainService] Verifying domain: ${config.resendDomainId}`);

      const result = await resend.domains.verify(config.resendDomainId);

      if (result.error) {
        return { success: false, error: result.error.message };
      }

      // Check status
      const domainInfo = await resend.domains.get(config.resendDomainId);
      const status = domainInfo.data?.status;

      // Update database
      await this.prisma.tenantEmailConfig.update({
        where: { tenantId },
        data: {
          domainVerified: status === 'verified',
          updatedAt: new Date(),
        },
      });

      return { success: true, status };
    } catch (error: any) {
      console.error(`[DomainService] Verify error:`, error);
      return { success: false, error: error.message };
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
        resendDomainId: null,
        status: 'not_provisioned',
        dnsRecordsCreated: false,
        lastChecked: null,
        receivingEnabled: false,
        receivingVerified: false,
      };
    }

    // Get current status from Resend
    try {
      const domainInfo = await resend.domains.get(config.resendDomainId);
      const status = domainInfo.data?.status || 'pending';

      // Update database if status changed
      if (status === 'verified' && !config.domainVerified) {
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId },
          data: { domainVerified: true },
        });
      }

      // Check if receiving is verified (MX record status from Resend)
      const mxRecord = domainInfo.data?.records?.find((r: any) => r.type === 'MX');
      const receivingVerified = mxRecord?.status === 'verified';

      if (receivingVerified && !config.receivingVerified) {
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId },
          data: { receivingVerified: true },
        });
      }

      return {
        tenantId,
        domain: config.domain || '',
        resendDomainId: config.resendDomainId,
        status: status as DomainStatus['status'],
        dnsRecordsCreated: ((config.cloudflareDnsRecordIds as string[]) || []).length > 0,
        lastChecked: new Date(),
        receivingEnabled: config.receivingEnabled,
        receivingVerified: receivingVerified || config.receivingVerified,
      };
    } catch (error) {
      return {
        tenantId,
        domain: config.domain || '',
        resendDomainId: config.resendDomainId,
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
   */
  async enableReceiving(
    tenantId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.prisma.tenantEmailConfig.findUnique({
        where: { tenantId },
      });

      if (!config?.resendDomainId) {
        return { success: false, error: 'No domain configured for tenant' };
      }

      if (config.receivingEnabled) {
        return { success: true }; // Already enabled
      }

      console.log(`[DomainService] Enabling receiving for tenant: ${tenantId}`);

      // Enable receiving via Resend PATCH API
      const updateResponse = await fetch(`https://api.resend.com/domains/${config.resendDomainId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ receiving: 'enabled' }),
      });

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        return { success: false, error: `Failed to enable receiving: ${errorText}` };
      }

      // Get updated domain info with MX record
      const domainInfo = await resend.domains.get(config.resendDomainId);
      const mxRecord = domainInfo.data?.records?.find((r: any) => r.type === 'MX');

      if (mxRecord) {
        // Add MX record to Cloudflare
        const subdomain = config.domain?.replace(`.${this.baseDomain}`, '') || '';
        console.log(`[DomainService] Adding MX record to Cloudflare for ${subdomain}...`);

        const dnsResult = await cloudflareService.addTenantDnsRecords(subdomain, [
          {
            record: mxRecord.record,
            name: mxRecord.name,
            type: mxRecord.type,
            value: mxRecord.value,
            priority: mxRecord.priority,
          },
        ]);

        // Update stored DNS record IDs
        const existingRecordIds = (config.cloudflareDnsRecordIds as string[]) || [];
        const allRecordIds = [...existingRecordIds, ...dnsResult.recordIds];

        await this.prisma.tenantEmailConfig.update({
          where: { tenantId },
          data: {
            receivingEnabled: true,
            cloudflareDnsRecordIds: allRecordIds,
          },
        });
      } else {
        // No MX record yet, just mark as enabled
        await this.prisma.tenantEmailConfig.update({
          where: { tenantId },
          data: { receivingEnabled: true },
        });
      }

      return { success: true };
    } catch (error: any) {
      console.error(`[DomainService] Enable receiving error:`, error);
      return { success: false, error: error.message };
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

      // Remove DNS records from Cloudflare
      if (config.cloudflareDnsRecordIds && Array.isArray(config.cloudflareDnsRecordIds)) {
        await cloudflareService.removeTenantDnsRecords(config.cloudflareDnsRecordIds as string[]);
      }

      // Delete domain from Resend
      if (config.resendDomainId) {
        await resend.domains.remove(config.resendDomainId);
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
