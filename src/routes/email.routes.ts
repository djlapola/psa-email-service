import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { QueueService } from '../services/queue.service';
import { WebhookService } from '../services/webhook.service';
import { getTemplate, listTemplates } from '../config/templates';

const router = Router();

// API Key authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey || apiKey !== process.env.EMAIL_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }

  next();
};

// Apply auth to all routes except webhooks
router.use((req, res, next) => {
  // Skip auth for Resend webhooks
  if (req.path === '/webhooks/resend') {
    return next();
  }
  authenticate(req, res, next);
});

/**
 * POST /api/send
 * Queue an email for sending
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { to, template, data, tenantId, from, replyTo } = req.body;

    // Validation
    if (!to) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }
    if (!template) {
      return res.status(400).json({ error: 'Missing required field: template' });
    }

    // Check template exists
    const templateObj = getTemplate(template);
    if (!templateObj) {
      return res.status(400).json({
        error: `Template not found: ${template}`,
        availableTemplates: listTemplates(),
      });
    }

    const queueService: QueueService = req.app.locals.queueService;

    const emailId = await queueService.enqueue({
      to,
      template,
      data: data || {},
      tenantId,
      from,
      replyTo,
    });

    res.status(202).json({
      success: true,
      message: 'Email queued for delivery',
      emailId,
    });
  } catch (error) {
    console.error('Error queueing email:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/send/bulk
 * Queue multiple emails for sending
 */
router.post('/send/bulk', async (req: Request, res: Response) => {
  try {
    const { emails } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid emails array' });
    }

    if (emails.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 emails per bulk request' });
    }

    const queueService: QueueService = req.app.locals.queueService;
    const results: { to: string; emailId?: string; error?: string }[] = [];

    for (const email of emails) {
      try {
        const emailId = await queueService.enqueue({
          to: email.to,
          template: email.template,
          data: email.data || {},
          tenantId: email.tenantId,
          from: email.from,
          replyTo: email.replyTo,
        });
        results.push({ to: email.to, emailId });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({ to: email.to, error: errorMessage });
      }
    }

    const successful = results.filter((r) => r.emailId).length;
    const failed = results.filter((r) => r.error).length;

    res.status(202).json({
      success: true,
      message: `Queued ${successful} emails, ${failed} failed`,
      results,
    });
  } catch (error) {
    console.error('Error queueing bulk emails:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * GET /api/status/:emailId
 * Get status of a specific email
 */
router.get('/status/:emailId', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { emailId } = req.params;

    const email = await prisma.emailLog.findUnique({
      where: { id: emailId },
    });

    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json({
      id: email.id,
      to: email.to,
      subject: email.subject,
      template: email.template,
      status: email.status,
      resendId: email.resendId,
      tenantId: email.tenantId,
      attempts: email.attempts,
      error: email.error,
      sentAt: email.sentAt,
      createdAt: email.createdAt,
    });
  } catch (error) {
    console.error('Error fetching email status:', error);
    res.status(500).json({ error: 'Failed to fetch email status' });
  }
});

/**
 * GET /api/logs
 * Get email logs with filtering
 */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, status, template, limit = '50', offset = '0' } = req.query;

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (status) where.status = status;
    if (template) where.template = template;

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit as string, 10), 100),
        skip: parseInt(offset as string, 10),
        select: {
          id: true,
          to: true,
          subject: true,
          template: true,
          status: true,
          tenantId: true,
          attempts: true,
          error: true,
          sentAt: true,
          createdAt: true,
        },
      }),
      prisma.emailLog.count({ where }),
    ]);

    res.json({
      logs,
      total,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    });
  } catch (error) {
    console.error('Error fetching email logs:', error);
    res.status(500).json({ error: 'Failed to fetch email logs' });
  }
});

/**
 * GET /api/templates
 * List available email templates
 */
router.get('/templates', (req: Request, res: Response) => {
  res.json({
    templates: listTemplates(),
  });
});

/**
 * GET /api/templates/:name/preview
 * Preview a template with sample data
 */
router.get('/templates/:name/preview', (req: Request, res: Response) => {
  const { name } = req.params;
  const template = getTemplate(name);

  if (!template) {
    return res.status(404).json({
      error: `Template not found: ${name}`,
      availableTemplates: listTemplates(),
    });
  }

  // Use sample data for preview
  const sampleData = req.query.data
    ? JSON.parse(req.query.data as string)
    : template.sampleData || {};

  try {
    const rendered = template.render(sampleData);
    res.json({
      template: name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      sampleData,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to render template: ${errorMessage}` });
  }
});

/**
 * POST /api/webhooks/resend
 * Handle incoming Resend webhook events
 */
router.post('/webhooks/resend', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const webhookService = new WebhookService(prisma);

    // Parse raw body
    const payload = typeof req.body === 'string' ? req.body : req.body.toString();
    const event = JSON.parse(payload);

    console.log('Received Resend webhook:', event.type);

    // Handle the webhook event
    await webhookService.handleResendWebhook(event);

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing Resend webhook:', error);
    res.status(400).json({ error: 'Invalid webhook payload' });
  }
});

/**
 * GET /api/stats
 * Get email statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const { tenantId, since } = req.query;

    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (since) where.createdAt = { gte: new Date(since as string) };

    const [total, byStatus, byTemplate] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),
      prisma.emailLog.groupBy({
        by: ['template'],
        where,
        _count: true,
        orderBy: { _count: { template: 'desc' } },
        take: 10,
      }),
    ]);

    const statusCounts = byStatus.reduce(
      (acc, item) => {
        acc[item.status] = item._count;
        return acc;
      },
      {} as Record<string, number>
    );

    const templateCounts = byTemplate.map((item) => ({
      template: item.template,
      count: item._count,
    }));

    res.json({
      total,
      byStatus: statusCounts,
      byTemplate: templateCounts,
    });
  } catch (error) {
    console.error('Error fetching email stats:', error);
    res.status(500).json({ error: 'Failed to fetch email stats' });
  }
});

export default router;
