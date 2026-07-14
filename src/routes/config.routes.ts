import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();

// API Key authentication middleware (mirrors email.routes.ts)
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey || apiKey !== process.env.EMAIL_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }

  next();
};

// All routes in this router require authentication.
router.use(authenticate);

/**
 * GET /api/config/:tenantId
 * Return the tenant's sender config subset.
 */
router.get('/:tenantId', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;

    const config = await prisma.tenantEmailConfig.findFirst({
      where: { tenantId: req.params.tenantId },
    });

    if (!config) {
      return res.status(404).json({ error: 'No email config for tenant' });
    }

    return res.status(200).json({
      tenantId: config.tenantId,
      fromEmail: config.fromEmail,
      fromName: config.fromName,
      replyTo: config.replyTo,
      domain: config.domain,
      domainVerified: config.domainVerified,
    });
  } catch (error) {
    console.error('[Config] GET failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/config/:tenantId
 * Update the tenant's sender display name (fromName) and/or the sender
 * local-part (fromEmailPrefix). fromEmail is always constructed from the
 * tenant's own sending domain — a full address is never accepted.
 */
router.patch('/:tenantId', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { fromName, fromEmailPrefix } = req.body;

    if (fromName === undefined && fromEmailPrefix === undefined) {
      return res.status(400).json({ error: 'fromName or fromEmailPrefix is required' });
    }

    const data: { fromName?: string | null; fromEmail?: string } = {};

    if (fromName !== undefined) {
      if (typeof fromName !== 'string') {
        return res.status(400).json({ error: 'fromName must be a string' });
      }

      const trimmed = fromName.trim();

      if (trimmed.length > 100) {
        return res.status(400).json({ error: 'fromName must be at most 100 characters' });
      }

      // Guard against email-header injection.
      if (/[\r\n<>]/.test(trimmed)) {
        return res.status(400).json({ error: 'fromName contains invalid characters' });
      }

      // Empty string clears fromName (sends fall back to the default).
      data.fromName = trimmed === '' ? null : trimmed;
    }

    const existing = await prisma.tenantEmailConfig.findFirst({
      where: { tenantId: req.params.tenantId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'No email config for tenant' });
    }

    if (fromEmailPrefix !== undefined) {
      if (typeof fromEmailPrefix !== 'string') {
        return res.status(400).json({ error: 'fromEmailPrefix must be a string' });
      }

      // Never accept a full address; keep only the local-part characters.
      const sanitized = fromEmailPrefix
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '')
        .slice(0, 64);

      if (sanitized === '') {
        return res.status(400).json({ error: 'fromEmailPrefix must contain at least one valid character' });
      }

      if (!existing.domain) {
        return res.status(400).json({ error: 'Tenant has no sending domain configured' });
      }

      // domainVerified is intentionally not gated here — the resolver checks it
      // before using fromEmail.
      data.fromEmail = `${sanitized}@${existing.domain}`;
    }

    const updated = await prisma.tenantEmailConfig.update({
      where: { id: existing.id },
      data,
    });

    return res.status(200).json({
      tenantId: updated.tenantId,
      fromEmail: updated.fromEmail,
      fromName: updated.fromName,
      replyTo: updated.replyTo,
      domain: updated.domain,
      domainVerified: updated.domainVerified,
    });
  } catch (error) {
    console.error('[Config] PATCH failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
