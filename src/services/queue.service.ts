import { PrismaClient } from '@prisma/client';
import { ResendService } from './resend.service';
import { WebhookService } from './webhook.service';
import { TemplateService } from './template.service';

export interface QueuedEmail {
  id: string;
  to: string;
  template: string;
  data: Record<string, unknown>;
  tenantId?: string;
  from?: string;
  replyTo?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 30000]; // 1s, 5s, 30s
const PROCESS_INTERVAL = 1000; // Check queue every second

export class QueueService {
  private prisma: PrismaClient;
  private resendService: ResendService;
  private webhookService: WebhookService;
  private templateService: TemplateService;
  private queue: QueuedEmail[] = [];
  private processing = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.resendService = new ResendService(prisma);
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

    const from = email.from || process.env.EMAIL_FROM || 'noreply@example.com';

    // Create log entry
    const log = await this.prisma.emailLog.create({
      data: {
        to: email.to,
        from,
        subject: rendered.subject,
        template: email.template,
        status: 'queued',
        tenantId: email.tenantId,
        metadata: email.data as object,
        attempts: 0,
      },
    });

    // Add to in-memory queue
    this.queue.push({
      id: log.id,
      to: email.to,
      template: email.template,
      data: email.data,
      tenantId: email.tenantId,
      from,
      replyTo: email.replyTo,
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

    // Update status to sending
    await this.prisma.emailLog.update({
      where: { id: email.id },
      data: { status: 'sending', attempts: { increment: 1 } },
    });

    const result = await this.resendService.sendEmail({
      to: email.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: email.from,
      replyTo: email.replyTo,
      tenantId: email.tenantId,
      tags: email.tenantId ? [{ name: 'tenant_id', value: email.tenantId }] : undefined,
    });

    if (result.success) {
      await this.prisma.emailLog.update({
        where: { id: email.id },
        data: {
          status: 'sent',
          resendId: result.resendId,
          sentAt: new Date(),
        },
      });
      console.log(`Email sent: ${email.id} -> ${email.to} (resendId: ${result.resendId})`);
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
    await this.prisma.emailLog.update({
      where: { id },
      data: { status: 'failed', error },
    });
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
      this.queue.push({
        id: log.id,
        to: log.to,
        template: log.template,
        data: (log.metadata as Record<string, unknown>) || {},
        tenantId: log.tenantId || undefined,
        from: log.from,
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
