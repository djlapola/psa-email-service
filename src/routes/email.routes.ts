import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { QueueService } from '../services/queue.service';
import { TemplateService, injectAttachmentIndicator } from '../services/template.service';
import { WebhookService } from '../services/webhook.service';

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
  // Skip auth for inbound email webhooks and SendGrid event webhooks
  if (req.path.startsWith('/inbound') || req.path.startsWith('/webhooks')) {
    return next();
  }
  authenticate(req, res, next);
});

/**
 * POST /api/send
 * Queue an email for sending (template-based) or send directly (raw HTML)
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { to, template, data, tenantId, from, replyTo, html, text, subject, headers, cc, bcc, tags, metadata, attachments } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }

    // Debug: log attachment data for ticket-comment emails (both paths)
    if (template === 'ticket-comment' || (subject && data?.attachmentCount !== undefined)) {
      console.log(`[EmailRoutes] ticket-comment send request — path: ${html ? 'raw-html' : 'template'}, attachmentCount: ${data?.attachmentCount} (${typeof data?.attachmentCount}), portalTicketUrl: ${data?.portalTicketUrl}`);
    }

    // Path 1: Raw HTML send (used by sendEmailWithHeaders for threading)
    if (html && subject) {
      const { SendGridService } = require('../services/sendgrid.service');
      const sendgridService = new SendGridService(prisma);

      // Inject attachment indicator if data includes attachmentCount > 0
      const withAttachments = injectAttachmentIndicator(
        { html, text: text || '' },
        data || {}
      );

      // Create EmailLog record so raw sends appear in stats/logs
      const resolvedFrom = from || process.env.EMAIL_FROM || 'noreply@skyrack.com';
      const log = await prisma.emailLog.create({
        data: {
          to: Array.isArray(to) ? to.join(', ') : to,
          from: resolvedFrom,
          subject,
          template: template || 'raw-html',
          status: 'sending',
          tenantId,
          metadata: data as object || {},
          attempts: 1,
        },
      });

      const result = await sendgridService.sendEmail({
        to,
        subject,
        html: withAttachments.html,
        text: withAttachments.text,
        from,
        replyTo,
        tenantId,
        tags: tags ? Object.entries(tags).map(([name, value]) => ({ name, value: String(value) })) : undefined,
        headers,
        attachments,
      });

      if (!result.success) {
        await prisma.emailLog.update({
          where: { id: log.id },
          data: { status: 'failed', error: result.error },
        });
        return res.status(500).json({ error: result.error });
      }

      await prisma.emailLog.update({
        where: { id: log.id },
        data: {
          status: 'sent',
          sendgridMessageId: result.messageId,
          sentAt: new Date(),
        },
      });

      return res.status(202).json({
        success: true,
        message: 'Email sent',
        emailId: log.id,
      });
    }

    // Path 2: Template-based send (existing flow)
    if (!template) {
      return res.status(400).json({ error: 'Missing required field: template (or provide html + subject for raw send)' });
    }

    const templateObj = await templateService.getTemplate(template, tenantId);
    if (!templateObj) {
      const allTemplates = await templateService.listSystemTemplates();
      return res.status(400).json({
        error: `Template not found: ${template}`,
        availableTemplates: allTemplates.map((t) => ({ name: t.name, displayName: t.displayName })),
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
      messageId: email.sendgridMessageId,
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
 * List all templates (system + tenant's custom)
 */
router.get('/templates', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { tenantId } = req.query;

    const templates = await templateService.listTemplates(tenantId as string);

    res.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        isSystem: t.isSystem,
        tenantId: t.tenantId,
        variables: t.variables,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

/**
 * GET /api/templates/:name
 * Get a specific template by name (tenant-specific or system default)
 */
router.get('/templates/:name', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { name } = req.params;
    const { tenantId } = req.query;

    const template = await templateService.getTemplate(name, tenantId as string);

    if (!template) {
      return res.status(404).json({ error: `Template not found: ${name}` });
    }

    res.json({
      id: template.id,
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      subject: template.subject,
      htmlBody: template.htmlBody,
      textBody: template.textBody,
      variables: template.variables,
      isSystem: template.isSystem,
      tenantId: template.tenantId,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

/**
 * POST /api/templates
 * Create a custom template (requires tenantId)
 */
router.post('/templates', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { tenantId, name, displayName, description, subject, htmlBody, textBody, variables } =
      req.body;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required for custom templates' });
    }
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!displayName) {
      return res.status(400).json({ error: 'displayName is required' });
    }
    if (!subject) {
      return res.status(400).json({ error: 'subject is required' });
    }
    if (!htmlBody) {
      return res.status(400).json({ error: 'htmlBody is required' });
    }

    const template = await templateService.createTemplate(tenantId, {
      name,
      displayName,
      description,
      subject,
      htmlBody,
      textBody,
      variables,
    });

    res.status(201).json({
      id: template.id,
      name: template.name,
      displayName: template.displayName,
      tenantId: template.tenantId,
      createdAt: template.createdAt,
    });
  } catch (error: any) {
    console.error('Error creating template:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Template with this name already exists for this tenant' });
    }
    res.status(500).json({ error: 'Failed to create template' });
  }
});

/**
 * PUT /api/templates/:id
 * Update a custom template
 */
router.put('/templates/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { id } = req.params;
    const { displayName, description, subject, htmlBody, textBody, variables, isActive } = req.body;

    const template = await templateService.updateTemplate(id, {
      displayName,
      description,
      subject,
      htmlBody,
      textBody,
      variables,
      isActive,
    });

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({
      id: template.id,
      name: template.name,
      displayName: template.displayName,
      tenantId: template.tenantId,
      updatedAt: template.updatedAt,
    });
  } catch (error: any) {
    console.error('Error updating template:', error);
    if (error.message === 'Cannot modify system templates') {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update template' });
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a custom template (not system ones)
 */
router.delete('/templates/:id', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { id } = req.params;

    const deleted = await templateService.deleteTemplate(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ success: true, message: 'Template deleted' });
  } catch (error: any) {
    console.error('Error deleting template:', error);
    if (error.message === 'Cannot delete system templates') {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/**
 * POST /api/templates/:name/preview
 * Preview a template with sample data
 */
router.post('/templates/:name/preview', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const templateService = new TemplateService(prisma);
    const { name } = req.params;
    const { tenantId, data } = req.body;

    const template = await templateService.getTemplate(name, tenantId);

    if (!template) {
      return res.status(404).json({ error: `Template not found: ${name}` });
    }

    // Use provided data or generate sample data from variables
    const sampleData = data || generateSampleData(template.variables as any[]);

    const rendered = templateService.renderTemplate(template, sampleData);

    res.json({
      template: name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      sampleData,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error previewing template:', error);
    res.status(500).json({ error: `Failed to render template: ${errorMessage}` });
  }
});

/**
 * Generate sample data from template variables
 */
function generateSampleData(variables: { name: string; example: string }[]): Record<string, string> {
  if (!Array.isArray(variables)) return {};
  return variables.reduce(
    (acc, v) => {
      acc[v.name] = v.example || `{{${v.name}}}`;
      return acc;
    },
    {} as Record<string, string>
  );
}

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

    const [total, totalUnfiltered, byStatus, byTemplate] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.count(),
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
      totalUnfiltered,
      byStatus: statusCounts,
      byTemplate: templateCounts,
    });
  } catch (error) {
    console.error('Error fetching email stats:', error);
    res.status(500).json({ error: 'Failed to fetch email stats' });
  }
});

/**
 * POST /api/webhooks/sendgrid
 * Handle SendGrid Event Webhook (delivery, bounce, open, etc.)
 * Public endpoint — verified via SENDGRID_WEBHOOK_SECRET signature
 */
router.post('/webhooks/sendgrid', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;

    // Verify SendGrid webhook signature if secret is configured
    const webhookSecret = process.env.SENDGRID_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-twilio-email-event-webhook-signature'] as string;
      const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'] as string;

      if (!signature || !timestamp) {
        return res.status(401).json({ error: 'Missing webhook signature headers' });
      }

      // Verify HMAC signature: HMAC-SHA256(timestamp + payload, secret)
      const payload = JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(timestamp + payload)
        .digest('base64');

      if (signature !== expectedSignature) {
        console.warn('SendGrid webhook signature verification failed');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];
    const webhookService = new WebhookService(prisma);

    for (const event of events) {
      const sgMessageId = event.sg_message_id?.split('.')[0]; // SendGrid appends .filter info
      const eventType = event.event; // delivered, bounce, dropped, deferred, open, click, etc.

      if (!sgMessageId) continue;

      // Find the EmailLog by sendgridMessageId
      const emailLog = await prisma.emailLog.findFirst({
        where: { sendgridMessageId: sgMessageId },
      });

      if (!emailLog) {
        console.log(`SendGrid webhook: no EmailLog found for sg_message_id=${sgMessageId}`);
        continue;
      }

      // Map SendGrid events to our status values
      let newStatus: string | null = null;
      let webhookEvent: string | null = null;

      switch (eventType) {
        case 'delivered':
          newStatus = 'delivered';
          break;
        case 'bounce':
        case 'dropped':
          newStatus = 'bounced';
          webhookEvent = 'email.bounced';
          break;
        case 'spamreport':
          newStatus = 'complained';
          webhookEvent = 'email.complained';
          break;
        case 'deferred':
          // Don't change status for deferred, just log
          console.log(`SendGrid webhook: email ${emailLog.id} deferred — ${event.reason || 'no reason'}`);
          continue;
      }

      if (newStatus) {
        await prisma.emailLog.update({
          where: { id: emailLog.id },
          data: {
            status: newStatus,
            error: event.reason || event.response || undefined,
          },
        });
        console.log(`SendGrid webhook: email ${emailLog.id} status updated to ${newStatus}`);
      }

      // Notify CP/PSA about bounces and complaints
      if (webhookEvent) {
        await webhookService.notifyEmailEvent({
          event: webhookEvent as any,
          emailId: emailLog.id,
          to: emailLog.to,
          tenantId: emailLog.tenantId || undefined,
          template: emailLog.template,
          reason: event.reason || event.response,
        });
      }
    }

    // Always return 200 to prevent SendGrid retries
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing SendGrid webhook:', error);
    // Still return 200 to prevent infinite retries from SendGrid
    res.status(200).json({ received: true });
  }
});

export default router;
