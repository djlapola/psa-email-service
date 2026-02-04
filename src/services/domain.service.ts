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
      // Step 1: Create domain in Resend
      console.log(`[DomainService] Creating domain in Resend...`);
      const resendResult = await resend.domains.create({
        name: fullDomain,
        region: 'us-east-1',
      });

      if (resendResult.error) {
        console.error(`[DomainService] Resend error:`, resendResult.error);
        return {
          success: false,
          error: `Resend error: ${resendResult.error.message}`,
        };
      }

      const resendDomain = resendResult.data!;
      console.log(`[DomainService] Resend domain created: ${resendDomain.id}`);

      // Step 2: Add DNS records to Cloudflare
      console.log(`[DomainService] Adding DNS records to Cloudflare...`);
      const dnsResult = await cloudflareService.addTenantDnsRecords(
        subdomain,
        resendDomain.records.map((r) => ({
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
        },
        update: {
          fromEmail: `support@${fullDomain}`,
          domain: fullDomain,
          resendDomainId: resendDomain.id,
          cloudflareDnsRecordIds: dnsResult.recordIds,
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

      return {
        tenantId,
        domain: config.domain || '',
        resendDomainId: config.resendDomainId,
        status: status as DomainStatus['status'],
        dnsRecordsCreated: ((config.cloudflareDnsRecordIds as string[]) || []).length > 0,
        lastChecked: new Date(),
      };
    } catch (error) {
      return {
        tenantId,
        domain: config.domain || '',
        resendDomainId: config.resendDomainId,
        status: config.domainVerified ? 'verified' : 'pending',
        dnsRecordsCreated: ((config.cloudflareDnsRecordIds as string[]) || []).length > 0,
        lastChecked: config.updatedAt,
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
