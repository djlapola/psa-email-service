import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { EventWebhook, EventWebhookHeader } from '@sendgrid/eventwebhook';
import { QueueService } from '../services/queue.service';
import { TemplateService, injectAttachmentIndicator } from '../services/template.service';
import { WebhookService } from '../services/webhook.service';
import { acceptsRotatableKey } from '../lib/api-key';

const router = Router();

// SendGrid allows at most 10 categories per message.
const SENDGRID_CATEGORY_LIMIT = 10;

// Cap on forwarded SendGrid reason/response text. SendGrid 'reason' is usually a short
// SMTP string but can occasionally carry a long provider response; bound it so PSA and
// our own EmailLog.error never receive an unbounded blob.
const MAX_REASON_LENGTH = 500;

/** Coerce a SendGrid reason/response to a bounded string, or undefined when empty. */
function truncateReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null || reason === '') return undefined;
  const s = String(reason);
  return s.length > MAX_REASON_LENGTH ? s.slice(0, MAX_REASON_LENGTH) : s;
}

/** Raw SendGrid detail forwarded to PSA alongside the collapsed `event` field. */
export interface SendGridForwardDetail {
  sgEvent: string;      // raw SendGrid event name
  sgType?: string;      // SendGrid 'type' (e.g. 'bounce' | 'blocked')
  status?: string;      // SMTP status code (e.g. '5.1.10')
  reason?: string;      // SendGrid 'reason' or 'response', truncated
  sgTimestamp?: number; // SendGrid event unix timestamp
  sgMessageId?: string; // SendGrid message id, filter suffix stripped
}

export interface SendGridEventClassification {
  sgMessageId?: string;
  eventType: string;
  // Our EmailLog status for this event, or null to leave status unchanged.
  newStatus: 'delivered' | 'bounced' | 'complained' | null;
  // The collapsed event to forward to PSA, or null to not forward.
  webhookEvent: 'email.bounced' | 'email.complained' | null;
  detail: SendGridForwardDetail;
}

/**
 * Pure mapping of a raw SendGrid Event Webhook entry to (a) our EmailLog status, (b) the
 * collapsed PSA event (backward compatible), and (c) the raw detail forwarded alongside it.
 *
 * Forwarding policy (which SendGrid events reach PSA):
 *   - delivered           → status 'delivered',  NOT forwarded
 *   - bounce (any type)    → status 'bounced',    forwarded as email.bounced (sgType distinguishes bounce vs blocked)
 *   - dropped (any reason) → status 'bounced',    forwarded as email.bounced (reason carries the drop cause)
 *   - spamreport           → status 'complained', forwarded as email.complained
 *   - deferred             → status unchanged,    NOT forwarded (transient; caller logs only)
 *   - processed / unsubscribe / open / click / unknown → status unchanged, NOT forwarded
 */
export function classifySendGridEvent(event: any): SendGridEventClassification {
  const sgMessageId =
    typeof event?.sg_message_id === 'string' ? event.sg_message_id.split('.')[0] : undefined;
  const eventType: string = event?.event;

  let newStatus: SendGridEventClassification['newStatus'] = null;
  let webhookEvent: SendGridEventClassification['webhookEvent'] = null;

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
    // deferred / processed / unsubscribe / open / click / etc. → no status change, not forwarded
  }

  const detail: SendGridForwardDetail = {
    sgEvent: eventType,
    sgType: event?.type || undefined,
    status: event?.status || undefined,
    reason: truncateReason(event?.reason || event?.response),
    sgTimestamp: typeof event?.timestamp === 'number' ? event.timestamp : undefined,
    sgMessageId,
  };

  return { sgMessageId, eventType, newStatus, webhookEvent, detail };
}

/**
 * Normalise caller-supplied `tags` into SendGrid's { name, value }[] shape.
 *
 * Accepts either:
 *   - a plain object:            { tenant_id: 'abc', type: 'invoice' }
 *   - an array of {name,value}:  [{ name: 'type', value: 'invoice' }]
 *   - an array of bare strings:  ['invoice']  (legacy — treated as message types)
 *
 * Previously the route ran `Object.entries(tags)` unconditionally. On an array
 * that yields ['0', ...] entries, so the array *index* became the category name
 * and we emitted meaningless `0:invoice` / `1:ticket-created` categories in
 * SendGrid. Those are permanent and can never be reclaimed.
 */
function normalizeTags(tags: unknown): { name: string; value: string }[] {
  if (!tags) return [];

  if (Array.isArray(tags)) {
    return tags
      .map((t) => {
        if (t && typeof t === 'object' && 'name' in (t as object)) {
          const { name, value } = t as { name: unknown; value: unknown };
          return { name: String(name), value: String(value ?? '') };
        }
        // Bare scalar: historically these were message types passed positionally,
        // which is exactly what produced the `0:`/`1:` category debris. Keep them
        // under a proper `type:` key instead of an array index.
        return { name: 'type', value: String(t) };
      })
      .filter((t) => t.name && t.value);
  }

  if (typeof tags === 'object') {
    return Object.entries(tags as Record<string, unknown>)
      .map(([name, value]) => ({ name, value: String(value) }))
      .filter((t) => t.name && t.value);
  }

  return [];
}

/**
 * Build the final SendGrid categories for a message: guarantee a `tenant_id`
 * category (so the message is visible to per-tenant reporting), then append the
 * normalised caller tags, capped at SendGrid's 10-category limit.
 */
function buildCategories(
  tags: unknown,
  tenantId?: string
): { name: string; value: string }[] | undefined {
  const normalized = normalizeTags(tags);
  const withTenant =
    tenantId && !normalized.some((t) => t.name === 'tenant_id')
      ? [{ name: 'tenant_id', value: String(tenantId) }, ...normalized]
      : normalized;
  // tenant_id is first, so if we overflow the cap it is the one category kept.
  const final = withTenant.slice(0, SENDGRID_CATEGORY_LIMIT);
  return final.length ? final : undefined;
}

// API Key authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!acceptsRotatableKey(apiKey, 'EMAIL_SERVICE_API_KEY', 'EMAIL_SERVICE_API_KEY_PREVIOUS', 'EmailServiceAuth')) {
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
    const { to, template, data, tenantId, from, fromPrefix, replyTo, html, text, subject, headers, cc, bcc, tags, metadata, attachments } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }

    if (from && fromPrefix) {
      return res.status(400).json({ error: 'Provide either from or fromPrefix, not both' });
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

      // Create EmailLog record so raw sends appear in stats/logs. sendEmail resolves the
      // real sender internally, so record a placeholder here and backfill on success.
      const requestedFrom = from;
      const log = await prisma.emailLog.create({
        data: {
          to: Array.isArray(to) ? to.join(', ') : to,
          from: requestedFrom || 'pending-resolution',
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
        fromPrefix,
        replyTo,
        tenantId,
        tags: buildCategories(tags, tenantId),
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
          from: result.from || requestedFrom || 'unknown',
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
      fromPrefix,
      replyTo,
      headers,
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
          headers: email.headers,
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
      // Only seed variables that declare a non-empty example. A variable with an empty
      // example is left absent, so `interpolate` treats it as "off": {{#if}} blocks drop
      // and plain {{var}} placeholders stay literal (same output as before). This lets a
      // template declare mutually-exclusive conditional flags (empty example) that render
      // OFF in preview, instead of every flag's block rendering at once.
      if (v.example) {
        acc[v.name] = v.example;
      }
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

    // Verify SendGrid Event Webhook signature (ECDSA) if verification key is configured
    const verificationKey = process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY || process.env.SENDGRID_WEBHOOK_SECRET;
    if (verificationKey) {
      const signature = req.headers[EventWebhookHeader.SIGNATURE().toLowerCase()] as string;
      const timestamp = req.headers[EventWebhookHeader.TIMESTAMP().toLowerCase()] as string;

      if (!signature || !timestamp) {
        return res.status(401).json({ error: 'Missing webhook signature headers' });
      }

      const eventWebhook = new EventWebhook();
      const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(verificationKey);
      const payload = (req.body as Buffer).toString();

      if (!eventWebhook.verifySignature(ecPublicKey, payload, signature, timestamp)) {
        console.warn('SendGrid webhook ECDSA signature verification failed');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } else {
      console.warn('SENDGRID_WEBHOOK_VERIFICATION_KEY not set — skipping webhook signature verification');
    }

    // req.body is a raw Buffer from express.raw(); parse it to get the events array
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    const parsedBody = JSON.parse(rawBody);
    const events = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const webhookService = new WebhookService(prisma);

    for (const event of events) {
      const { sgMessageId, eventType, newStatus, webhookEvent, detail } = classifySendGridEvent(event);

      if (!sgMessageId) continue;

      // Find the EmailLog by sendgridMessageId
      const emailLog = await prisma.emailLog.findFirst({
        where: { sendgridMessageId: sgMessageId },
      });

      if (!emailLog) {
        console.log(`SendGrid webhook: no EmailLog found for sg_message_id=${sgMessageId}`);
        continue;
      }

      // Deferred is a transient retry by SendGrid, NOT a bounce. Deliberately log-only —
      // never forwarded to PSA — so a temporary greylist/defer is not mistaken for a
      // delivery failure. (This was already the behaviour; preserved.)
      if (eventType === 'deferred') {
        console.log(`SendGrid webhook: email ${emailLog.id} deferred — ${event.reason || 'no reason'}`);
        continue;
      }

      if (newStatus) {
        await prisma.emailLog.update({
          where: { id: emailLog.id },
          // Record the bounded reason on the existing EmailLog.error field. No dedicated
          // field exists for the structured sgType/SMTP-status detail (see schema note),
          // so that is forwarded to PSA only — recording it here would require a migration.
          data: {
            status: newStatus,
            error: detail.reason,
          },
        });
        console.log(`SendGrid webhook: email ${emailLog.id} status updated to ${newStatus}`);
      }

      // Notify CP/PSA about bounces and complaints. Keep the collapsed `event` field for
      // backward compatibility, but forward the raw SendGrid detail (`detail`) alongside it
      // so PSA can tell a hard bounce (type 'bounce') from a block (type 'blocked') or a
      // drop reason. The HMAC signature covers these fields (signed over the whole event).
      if (webhookEvent) {
        await webhookService.notifyEmailEvent({
          event: webhookEvent,
          emailId: emailLog.id,
          to: emailLog.to,
          tenantId: emailLog.tenantId || undefined,
          template: emailLog.template,
          ...detail,
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
