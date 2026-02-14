import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import sgClient from '@sendgrid/client';

sgClient.setApiKey(process.env.SENDGRID_API_KEY || '');

const router = Router();

// API Key authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey =
    req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey || apiKey !== process.env.EMAIL_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }

  next();
};

router.use(authenticate);

/**
 * POST /api/domains/authenticate
 * Start domain authentication for a tenant's custom (BYOD) domain
 */
router.post('/authenticate', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, domain } = req.body;

    if (!tenantId || !domain) {
      return res.status(400).json({ error: 'tenantId and domain are required' });
    }

    // Validate domain format (basic check)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    // Check if domain already exists for this tenant
    const existing = await prisma.tenantEmailDomain.findUnique({
      where: { tenantId_domain: { tenantId, domain: domain.toLowerCase() } },
    });

    if (existing?.status === 'verified') {
      return res.status(409).json({ error: 'Domain is already verified for this tenant' });
    }

    // Call SendGrid domain authentication API
    console.log(`[DomainAuth] Authenticating domain ${domain} for tenant ${tenantId}`);

    const [response, body] = await sgClient.request({
      method: 'POST',
      url: '/v3/whitelabel/domains',
      body: {
        domain: domain.toLowerCase(),
        subdomain: 'em',           // SendGrid DKIM prefix
        automatic_security: true,
        default: false,
      },
    });

    const sgDomain = body as any;
    const sendgridDomainId = String(sgDomain.id);

    // Extract DNS records into a human-readable format
    const dnsRecords: Array<{ type: string; host: string; value: string; valid: boolean }> = [];
    const dns = sgDomain.dns || {};

    for (const key of Object.keys(dns)) {
      const record = dns[key];
      if (record.host && record.data) {
        dnsRecords.push({
          type: (record.type || 'cname').toUpperCase(),
          host: record.host,
          value: record.data,
          valid: record.valid || false,
        });
      }
    }

    // Upsert the domain record
    await prisma.tenantEmailDomain.upsert({
      where: { tenantId_domain: { tenantId, domain: domain.toLowerCase() } },
      create: {
        tenantId,
        domain: domain.toLowerCase(),
        status: 'pending',
        sendgridDomainId,
        dnsRecords,
      },
      update: {
        status: 'pending',
        sendgridDomainId,
        dnsRecords,
        verifiedAt: null,
      },
    });

    console.log(`[DomainAuth] Domain ${domain} registered with SendGrid ID ${sendgridDomainId}, ${dnsRecords.length} DNS records returned`);

    res.json({
      success: true,
      domain: domain.toLowerCase(),
      sendgridDomainId,
      status: 'pending',
      dnsRecords,
      message: 'Add the DNS records below to your domain, then call POST /api/domains/verify to complete verification.',
    });
  } catch (error: any) {
    console.error('[DomainAuth] Authenticate error:', error?.response?.body || error);
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || 'Unknown error';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/domains/verify
 * Check if DNS records have been configured for a tenant's custom domain
 */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, domain } = req.body;

    if (!tenantId || !domain) {
      return res.status(400).json({ error: 'tenantId and domain are required' });
    }

    const domainRecord = await prisma.tenantEmailDomain.findUnique({
      where: { tenantId_domain: { tenantId, domain: domain.toLowerCase() } },
    });

    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found. Call POST /api/domains/authenticate first.' });
    }

    if (!domainRecord.sendgridDomainId) {
      return res.status(400).json({ error: 'Domain has no SendGrid authentication ID' });
    }

    // Call SendGrid validation API
    console.log(`[DomainAuth] Validating domain ${domain} (SendGrid ID: ${domainRecord.sendgridDomainId})`);

    const [response, body] = await sgClient.request({
      method: 'POST',
      url: `/v3/whitelabel/domains/${domainRecord.sendgridDomainId}/validate`,
    });

    const validation = body as any;
    const isValid = validation.valid === true;

    // Build per-record results from validation_results
    const recordResults: Array<{ type: string; host: string; valid: boolean; reason?: string }> = [];
    const validationResults = validation.validation_results || {};

    for (const key of Object.keys(validationResults)) {
      const result = validationResults[key];
      recordResults.push({
        type: key,
        host: result.host || key,
        valid: result.valid === true,
        reason: result.reason || undefined,
      });
    }

    // Update the domain record
    const now = new Date();
    const updateData: any = {
      status: isValid ? 'verified' : 'failed',
      lastVerifiedAt: now,
    };

    if (isValid) {
      updateData.verifiedAt = now;
    }

    // Update DNS records with current validity
    if (domainRecord.dnsRecords && Array.isArray(domainRecord.dnsRecords)) {
      const updatedRecords = (domainRecord.dnsRecords as any[]).map(record => {
        const matchingResult = recordResults.find(r =>
          r.host === record.host || r.type.toLowerCase().includes(record.host.split('.')[0])
        );
        return {
          ...record,
          valid: matchingResult?.valid ?? record.valid,
        };
      });
      updateData.dnsRecords = updatedRecords;
    }

    await prisma.tenantEmailDomain.update({
      where: { id: domainRecord.id },
      data: updateData,
    });

    console.log(`[DomainAuth] Domain ${domain} validation: ${isValid ? 'verified' : 'failed'}`);

    res.json({
      success: true,
      domain: domain.toLowerCase(),
      status: isValid ? 'verified' : 'failed',
      valid: isValid,
      validationResults: recordResults,
      message: isValid
        ? 'Domain verified! You can now send emails from this domain.'
        : 'DNS records not yet valid. Ensure all records are configured and allow up to 48 hours for propagation.',
    });
  } catch (error: any) {
    console.error('[DomainAuth] Verify error:', error?.response?.body || error);
    const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || 'Unknown error';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * GET /api/domains/:tenantId
 * List all custom (BYOD) domains for a tenant
 */
router.get('/:tenantId', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId } = req.params;

    const domains = await prisma.tenantEmailDomain.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      tenantId,
      domains: domains.map(d => ({
        id: d.id,
        domain: d.domain,
        status: d.status,
        dnsRecords: d.dnsRecords,
        verifiedAt: d.verifiedAt,
        lastVerifiedAt: d.lastVerifiedAt,
        createdAt: d.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('[DomainAuth] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/domains/:tenantId/:domain/dns-records
 * Return the DNS records needed for a specific domain
 */
router.get('/:tenantId/:domain/dns-records', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, domain } = req.params;

    const domainRecord = await prisma.tenantEmailDomain.findUnique({
      where: { tenantId_domain: { tenantId, domain: domain.toLowerCase() } },
    });

    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    res.json({
      domain: domainRecord.domain,
      status: domainRecord.status,
      dnsRecords: domainRecord.dnsRecords || [],
      verifiedAt: domainRecord.verifiedAt,
      lastVerifiedAt: domainRecord.lastVerifiedAt,
    });
  } catch (error: any) {
    console.error('[DomainAuth] DNS records error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/domains/:tenantId/:domain
 * Remove a custom domain authentication
 */
router.delete('/:tenantId/:domain', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, domain } = req.params;

    const domainRecord = await prisma.tenantEmailDomain.findUnique({
      where: { tenantId_domain: { tenantId, domain: domain.toLowerCase() } },
    });

    if (!domainRecord) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    // Remove domain authentication from SendGrid
    if (domainRecord.sendgridDomainId) {
      try {
        await sgClient.request({
          method: 'DELETE',
          url: `/v3/whitelabel/domains/${domainRecord.sendgridDomainId}`,
        });
      } catch (e: any) {
        console.warn(`[DomainAuth] Could not remove SendGrid domain auth: ${e.message}`);
      }
    }

    // Remove from database
    await prisma.tenantEmailDomain.delete({
      where: { id: domainRecord.id },
    });

    console.log(`[DomainAuth] Removed domain ${domain} for tenant ${tenantId}`);

    res.json({ success: true, message: `Domain ${domain} removed` });
  } catch (error: any) {
    console.error('[DomainAuth] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
