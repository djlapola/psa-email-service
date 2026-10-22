import { PrismaClient, EmailTemplate } from '@prisma/client';
import { renderTemplateString } from '../lib/render-template-string';
import { escapeHtml } from '../lib/html-escape';

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateVariable {
  name: string;
  description: string;
  example: string;
}

export class TemplateService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Get a template by name, checking tenant-specific first, then system default
   */
  async getTemplate(name: string, tenantId?: string): Promise<EmailTemplate | null> {
    // First, try to find tenant-specific template
    if (tenantId) {
      const tenantTemplate = await this.prisma.emailTemplate.findFirst({
        where: {
          name,
          tenantId,
          isActive: true,
        },
      });

      if (tenantTemplate) {
        return tenantTemplate;
      }
    }

    // Fall back to system default (tenantId = null)
    const systemTemplate = await this.prisma.emailTemplate.findFirst({
      where: {
        name,
        tenantId: null,
        isActive: true,
      },
    });

    return systemTemplate;
  }

  /**
   * Render a template with the provided data
   */
  renderTemplate(template: EmailTemplate, data: Record<string, unknown>): RenderedTemplate {
    const subject = renderTemplateString(template.subject, data, 'subject');
    const html = renderTemplateString(template.htmlBody, data, 'html');
    // Fallback text is derived from a TEXT-mode substitution of the HTML template (not the
    // escaped html above), so a value's `&`/`<` never leak into the plain-text part as
    // &amp;/&lt; entities before tag-stripping.
    const text = template.textBody
      ? renderTemplateString(template.textBody, data, 'text')
      : this.stripHtml(renderTemplateString(template.htmlBody, data, 'text'));

    return { subject, html, text };
  }

  /**
   * Get and render a template in one call
   */
  async getAndRender(
    name: string,
    data: Record<string, unknown>,
    tenantId?: string
  ): Promise<RenderedTemplate | null> {
    const template = await this.getTemplate(name, tenantId);

    if (!template) {
      return null;
    }

    return this.renderTemplate(template, data);
  }

  /**
   * List all templates (system + tenant-specific)
   */
  async listTemplates(tenantId?: string): Promise<EmailTemplate[]> {
    const where: any = {
      isActive: true,
      OR: [{ tenantId: null }],
    };

    if (tenantId) {
      where.OR.push({ tenantId });
    }

    return this.prisma.emailTemplate.findMany({
      where,
      orderBy: [{ name: 'asc' }, { tenantId: 'asc' }],
    });
  }

  /**
   * List system templates only
   */
  async listSystemTemplates(): Promise<EmailTemplate[]> {
    return this.prisma.emailTemplate.findMany({
      where: {
        tenantId: null,
        isSystem: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Create a custom tenant template
   */
  async createTemplate(
    tenantId: string,
    data: {
      name: string;
      displayName: string;
      description?: string;
      subject: string;
      htmlBody: string;
      textBody?: string;
      variables?: TemplateVariable[];
    }
  ): Promise<EmailTemplate> {
    return this.prisma.emailTemplate.create({
      data: {
        tenantId,
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        subject: data.subject,
        htmlBody: data.htmlBody,
        textBody: data.textBody,
        variables: (data.variables || []) as any,
        isSystem: false,
        isActive: true,
      },
    });
  }

  /**
   * Update a custom template (not system templates)
   */
  async updateTemplate(
    id: string,
    data: {
      displayName?: string;
      description?: string;
      subject?: string;
      htmlBody?: string;
      textBody?: string;
      variables?: TemplateVariable[];
      isActive?: boolean;
    }
  ): Promise<EmailTemplate | null> {
    // First check if it's a system template
    const existing = await this.prisma.emailTemplate.findUnique({
      where: { id },
    });

    if (!existing) {
      return null;
    }

    if (existing.isSystem) {
      throw new Error('Cannot modify system templates');
    }

    // Build update data, casting variables to any for Prisma JSON compatibility
    const updateData: any = { ...data };
    if (data.variables) {
      updateData.variables = data.variables as any;
    }

    return this.prisma.emailTemplate.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Delete a custom template (not system templates)
   */
  async deleteTemplate(id: string): Promise<boolean> {
    const existing = await this.prisma.emailTemplate.findUnique({
      where: { id },
    });

    if (!existing) {
      return false;
    }

    if (existing.isSystem) {
      throw new Error('Cannot delete system templates');
    }

    await this.prisma.emailTemplate.delete({
      where: { id },
    });

    return true;
  }

  /**
   * Get template by ID
   */
  async getTemplateById(id: string): Promise<EmailTemplate | null> {
    return this.prisma.emailTemplate.findUnique({
      where: { id },
    });
  }

  /**
   * Strip HTML tags for plain text fallback
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export function createTemplateService(prisma: PrismaClient): TemplateService {
  return new TemplateService(prisma);
}

/**
 * Inject attachment indicator into rendered HTML/text when attachments are present.
 * Handles both template-rendered and raw HTML emails.
 */
export function injectAttachmentIndicator(
  rendered: { html: string; text: string },
  data: Record<string, unknown>
): { html: string; text: string } {
  const count = Number(data?.attachmentCount) || 0;
  const rawUrl = data?.portalTicketUrl != null ? String(data.portalTicketUrl) : '';

  // Original gate: no indicator at all unless there are attachments AND a portal URL was
  // supplied. A PRESENT-but-invalid URL still renders (as the no-link variant below); only
  // a missing/empty URL suppresses the indicator entirely.
  if (count <= 0 || !rawUrl) {
    return rendered;
  }

  // Skip if an attachment indicator is already present \u2014 either a template {{#if}} block
  // (which prints "View in portal") or a prior call (the paperclip entity is our marker).
  if (rendered.html.includes('View in portal') || rendered.html.includes('&#128206;')) {
    return rendered;
  }

  // Only turn portalTicketUrl into a link if it is a real http(s) URL. The value comes from
  // caller `data`, so an unvalidated string in an href is an injection vector (javascript:,
  // attribute breakout). Present-but-invalid \u2192 show the indicator with NO link.
  let safeUrl: string | null = null;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeUrl = rawUrl;
      }
    } catch {
      safeUrl = null;
    }
  }

  const htmlIndicator = safeUrl
    ? `<p style="margin: 16px 0;">&#128206; ${count} attachment(s) \u2014 <a href="${escapeHtml(safeUrl)}">View in portal</a></p>`
    : `<p style="margin: 16px 0;">&#128206; ${count} attachment(s)</p>`;
  const textIndicator = safeUrl
    ? `\n\u{1F4CE} ${count} attachment(s) \u2014 View in portal: ${safeUrl}\n`
    : `\n\u{1F4CE} ${count} attachment(s)\n`;

  // HTML: insert before the CTA button wrapper, or before </body>
  let html = rendered.html;
  const btnIdx = html.indexOf('<div class="btn-wrap">');
  if (btnIdx !== -1) {
    html = html.slice(0, btnIdx) + htmlIndicator + '\n\n        ' + html.slice(btnIdx);
  } else {
    const bodyIdx = html.lastIndexOf('</body>');
    if (bodyIdx !== -1) {
      html = html.slice(0, bodyIdx) + htmlIndicator + '\n' + html.slice(bodyIdx);
    } else {
      html += htmlIndicator;
    }
  }

  // Text: insert before "View ticket" line, or append
  let text = rendered.text;
  const viewIdx = text.indexOf('View ticket');
  if (viewIdx !== -1) {
    text = text.slice(0, viewIdx) + textIndicator + '\n' + text.slice(viewIdx);
  } else {
    text += textIndicator;
  }

  return { html, text };
}
