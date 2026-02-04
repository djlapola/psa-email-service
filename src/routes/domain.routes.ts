import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { createDomainService } from '../services/domain.service';

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

// Apply auth to all domain routes
router.use(authenticate);

/**
 * POST /api/domains/provision
 * Provision a new email domain for a tenant
 */
router.post('/provision', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const domainService = createDomainService(prisma);
    const { tenantId, subdomain } = req.body;

    if (!tenantId || !subdomain) {
      return res.status(400).json({
        success: false,
        error: 'tenantId and subdomain are required',
      });
    }

    // Validate subdomain format
    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      return res.status(400).json({
        success: false,
        error: 'Subdomain must contain only lowercase letters, numbers, and hyphens',
      });
    }

    const result = await domainService.provisionTenantDomain(tenantId, subdomain);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error('Domain provision error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/domains/:tenantId/verify
 * Trigger domain verification for a tenant
 */
router.post('/:tenantId/verify', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const domainService = createDomainService(prisma);
    const { tenantId } = req.params;
    const result = await domainService.verifyDomain(tenantId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error('Domain verify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/domains/:tenantId/status
 * Get domain status for a tenant
 */
router.get('/:tenantId/status', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const domainService = createDomainService(prisma);
    const { tenantId } = req.params;
    const status = await domainService.getDomainStatus(tenantId);
    res.json(status);
  } catch (error: any) {
    console.error('Domain status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/domains/:tenantId
 * Remove a tenant's email domain
 */
router.delete('/:tenantId', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const domainService = createDomainService(prisma);
    const { tenantId } = req.params;
    const result = await domainService.deprovisionTenantDomain(tenantId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error('Domain deprovision error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
