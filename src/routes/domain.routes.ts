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

    // Capture BEFORE verifyDomain flips domainVerified, so we emit only on an ACTUAL
    // transition (verified <-> unverified) rather than on every Verify click. verifyDomain
    // is ALSO called by Sweep A and the post-provision timer, so the emit lives HERE in the
    // route — never in the service — to avoid double-emitting from those paths.
    const before = await prisma.tenantEmailConfig.findUnique({ where: { tenantId } });
    const wasVerified = before?.domainVerified === true;

    const result = await domainService.verifyDomain(tenantId);

    if (result.success) {
      const nowVerified = result.status === 'verified';
      if (before && nowVerified !== wasVerified) {
        const dhs = req.app.locals.domainHealthService;
        const domain = before.domain || '';
        if (nowVerified) {
          // unverified -> verified: recovery. Best-effort; do NOT touch lastHealthAlertAt
          // on the recovery direction (matches emitByodRecovery).
          try {
            await dhs.emitDomainStatusChange({ tenantId, domain, owner: 'skyrack' }, 'verified', wasVerified);
          } catch (emitErr: any) {
            console.error(`Domain recovery emit failed for ${domain} (${tenantId}):`, emitErr?.message || emitErr);
          }
        } else {
          // verified -> unverified: drift. Gate lastHealthAlertAt on a delivered emit only,
          // so a failed webhook doesn't suppress Sweep A's alert for 24h.
          try {
            const ok = await dhs.emitDomainStatusChange({ tenantId, domain, owner: 'skyrack' }, 'failed', wasVerified);
            if (ok) {
              await prisma.tenantEmailConfig.update({
                where: { tenantId },
                data: { lastHealthAlertAt: new Date() },
              });
            }
          } catch (emitErr: any) {
            console.error(`Domain failure emit failed for ${domain} (${tenantId}):`, emitErr?.message || emitErr);
          }
        }
      }
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
 * POST /api/domains/:tenantId/enable-receiving
 * Enable receiving capability for an existing tenant domain
 */
router.post('/:tenantId/enable-receiving', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const domainService = createDomainService(prisma);
    const { tenantId } = req.params;
    const result = await domainService.enableReceiving(tenantId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error('Enable receiving error:', error);
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
