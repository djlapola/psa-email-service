import { PrismaClient } from '@prisma/client';
import { SendGridService } from './sendgrid.service';
import { WebhookService } from './webhook.service';
import { TemplateService, injectAttachmentIndicator } from './template.service';
import { stripSecrets } from '../lib/redact-secrets';

export interface QueuedEmail {
  id: string;
  to: string;
  template: string;
  data: Record<string, unknown>;
  tenantId?: string;
  from?: string;
  fromPrefix?: string;
  replyTo?: string;
  // Caller-supplied headers (e.g. PSA's Auto-Submitted, X-Auto-Response-Suppress,
  // Message-ID) passed through verbatim to SendGrid. Email-service never adds or
  // rewrites these.
  headers?: Record<string, string>;
}

// Reserved key under which caller headers are stashed inside the EmailLog.metadata
// JSON column so they survive a restart reload. The in-memory queue carries headers
// in their own field; this is only the durable persistence seam (no schema change).
const HEADERS_META_KEY = '__headers';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 30000]; // 1s, 5s, 30s
const PROCESS_INTERVAL = 1000; // Check queue every second

export class QueueService {
  private prisma: PrismaClient;
  private sendgridService: SendGridService;
  private webhookService: WebhookService;
  private templateService: TemplateService;
  private queue: QueuedEmail[] = [];
  private processing = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.sendgridService = new SendGridService(prisma);
    this.webhookService = new WebhookService(prisma);
    this.templateService = new TemplateService(prisma);
  }

  /**
   * Add email to the queue and return immediately
   */
  async enqueue(email: Omit<QueuedEmail, 'id'>): Promise<string> {
    // Get template from database (tenant-specific or system default)
    const rendered = await this.templateService.getAndRender(
      email.template,
      email.data,
      email.tenantId
    );

    if (!rendered) {
      throw new Error(`Template not found: ${email.template}`);
    }

    // Create log entry (from is a placeholder; updated post-send with the resolved address).
    // Stash any caller headers inside the metadata JSON column (reserved key) so they are
    // not lost if the process restarts before the job is sent; stripped back out on reload.
    const metadata =
      email.headers && Object.keys(email.headers).length > 0
        ? { ...email.data, [HEADERS_META_KEY]: email.headers }
        : email.data;
    const log = await this.prisma.emailLog.create({
      data: {
        to: email.to,
        from: email.from || 'pending-resolution',
        subject: rendered.subject,
        template: email.template,
        status: 'queued',
        tenantId: email.tenantId,
        metadata: metadata as object,
        attempts: 0,
      },
    });

    // Add to in-memory queue — do NOT default from; let getTenantEmailConfig
    // resolve the tenant's branded address when no explicit from was provided
    this.queue.push({
      id: log.id,
      to: email.to,
      template: email.template,
      data: email.data,
      tenantId: email.tenantId,
      from: email.from,
      fromPrefix: email.fromPrefix,
      replyTo: email.replyTo,
      headers: email.headers,
    });

    console.log(`Email queued: ${log.id} -> ${email.to} (${email.template})`);
    return log.id;
  }

  /**
   * Start processing the queue
   */
  start(): void {
    if (this.intervalId) return;

    console.log('Email queue processor started');
    this.intervalId = setInterval(() => this.processQueue(), PROCESS_INTERVAL);
  }

  /**
   * Stop processing the queue
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Email queue processor stopped');
    }
  }

  /**
   * Process queued emails
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const email = this.queue.shift();

    if (!email) {
      this.processing = false;
      return;
    }

    try {
      await this.sendEmail(email);
    } catch (error) {
      console.error(`Failed to process email ${email.id}:`, error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send a single email with retry logic
   */
  private async sendEmail(email: QueuedEmail): Promise<void> {
    // Get template from database (tenant-specific or system default)
    const rendered = await this.templateService.getAndRender(
      email.template,
      email.data,
      email.tenantId
    );

    if (!rendered) {
      await this.markFailed(email.id, `Template not found: ${email.template}`);
      return;
    }

    // Inject attachment indicator if data includes attachmentCount > 0
    const withAttachments = injectAttachmentIndicator(rendered, email.data);
    rendered.html = withAttachments.html;
    rendered.text = withAttachments.text;

    // Update status to sending
    await this.prisma.emailLog.update({
      where: { id: email.id },
      data: { status: 'sending', attempts: { increment: 1 } },
    });

    const result = await this.sendgridService.sendEmail({
      to: email.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: email.from,
      fromPrefix: email.fromPrefix,
      replyTo: email.replyTo,
      tenantId: email.tenantId,
      tags: email.tenantId ? [{ name: 'tenant_id', value: email.tenantId }] : undefined,
      headers: email.headers,
    });

    if (result.success) {
      // Terminal state: scrub secrets (e.g. welcome tempPassword) out of the persisted
      // metadata. The row will not be reloaded (loadPendingEmails takes only queued/sending),
      // so no future render needs the cleartext values. Rebuild the exact stored shape
      // (data + the reserved __headers key) so headers are preserved through the scrub.
      const persistedMetadata =
        email.headers && Object.keys(email.headers).length > 0
          ? { ...email.data, [HEADERS_META_KEY]: email.headers }
          : email.data;
      await this.prisma.emailLog.update({
        where: { id: email.id },
        data: {
          status: 'sent',
          sendgridMessageId: result.messageId,
          sentAt: new Date(),
          metadata: stripSecrets(persistedMetadata) as object,
          ...(result.from && { from: result.from }),
        },
      });
      console.log(`Email sent: ${email.id} -> ${email.to} (messageId: ${result.messageId})`);
    } else {
      const log = await this.prisma.emailLog.findUnique({ where: { id: email.id } });
      const attempts = log?.attempts || 1;

      if (attempts < MAX_RETRIES) {
        // Schedule retry
        const delay = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.log(`Email failed, scheduling retry ${attempts}/${MAX_RETRIES} in ${delay}ms: ${email.id}`);

        await this.prisma.emailLog.update({
          where: { id: email.id },
          data: { status: 'queued', error: result.error },
        });

        setTimeout(() => {
          this.queue.push(email);
        }, delay);
      } else {
        await this.markFailed(email.id, result.error || 'Max retries exceeded');

        // Notify via webhook about failed email
        await this.webhookService.notifyEmailEvent({
          event: 'email.failed',
          emailId: email.id,
          to: email.to,
          tenantId: email.tenantId,
          template: email.template,
          error: result.error,
        });
      }
    }
  }

  /**
   * Mark email as permanently failed
   */
  private async markFailed(id: string, error: string): Promise<void> {
    // Terminal state: scrub secrets out of the persisted metadata. markFailed only has the
    // id, so read the actual stored metadata and scrub whatever is there (covers reloaded
    // rows whose metadata differs from any in-memory copy). Only write metadata when a
    // value exists, to avoid Prisma's JsonNull/DbNull ambiguity on a null column.
    const existing = await this.prisma.emailLog.findUnique({
      where: { id },
      select: { metadata: true },
    });
    const data: { status: string; error: string; metadata?: object } = {
      status: 'failed',
      error,
    };
    if (existing?.metadata != null) {
      data.metadata = stripSecrets(existing.metadata) as object;
    }
    await this.prisma.emailLog.update({ where: { id }, data });
    console.error(`Email permanently failed: ${id} - ${error}`);
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Check if currently processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Load pending emails from database on startup
   */
  async loadPendingEmails(): Promise<void> {
    const pending = await this.prisma.emailLog.findMany({
      where: {
        status: { in: ['queued', 'sending'] },
        attempts: { lt: MAX_RETRIES },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const log of pending) {
      // Recover caller headers stashed under the reserved key and strip them back out
      // so template data stays clean. Rows persisted before this key existed simply
      // yield no headers (undefined), so pre-existing jobs process unchanged.
      const meta = (log.metadata as Record<string, unknown>) || {};
      let data = meta;
      let headers: Record<string, string> | undefined;
      if (meta && typeof meta === 'object' && HEADERS_META_KEY in meta) {
        const { [HEADERS_META_KEY]: stashed, ...rest } = meta;
        headers = stashed as Record<string, string>;
        data = rest;
      }

      this.queue.push({
        id: log.id,
        to: log.to,
        template: log.template,
        data,
        tenantId: log.tenantId || undefined,
        from: log.from,
        headers,
      });
    }

    if (pending.length > 0) {
      console.log(`Loaded ${pending.length} pending emails from database`);
    }
  }
}

export function createQueueService(prisma: PrismaClient): QueueService {
  return new QueueService(prisma);
}
