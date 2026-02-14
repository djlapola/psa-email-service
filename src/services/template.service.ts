import { PrismaClient, EmailTemplate } from '@prisma/client';

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
    const subject = this.interpolate(template.subject, data);
    const html = this.interpolate(template.htmlBody, data);
    const text = template.textBody ? this.interpolate(template.textBody, data) : this.stripHtml(html);

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
   * Simple interpolation of {{variable}} patterns
   * Also handles basic {{#if variable}}...{{/if}} conditionals
   */
  private interpolate(template: string, data: Record<string, unknown>): string {
    let result = template;

    // Handle {{#if variable}}content{{/if}} blocks
    result = result.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (match, varName, content) => {
        const value = data[varName];
        if (value !== undefined && value !== null && value !== '' && value !== false && value !== 0) {
          return content;
        }
        return '';
      }
    );

    // Handle simple {{variable}} replacements
    result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = data[varName];
      if (value !== undefined && value !== null) {
        return String(value);
      }
      return match; // Keep original if no value provided
    });

    return result;
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
  const portalUrl = data?.portalTicketUrl ? String(data.portalTicketUrl) : '';

  if (count <= 0 || !portalUrl) {
    return rendered;
  }

  // Skip if already injected (e.g. by template {{#if}} block)
  if (rendered.html.includes('View in portal')) {
    return rendered;
  }

  const htmlIndicator = `<p style="margin: 16px 0;">&#128206; ${count} attachment(s) \u2014 <a href="${portalUrl}">View in portal</a></p>`;
  const textIndicator = `\n\u{1F4CE} ${count} attachment(s) \u2014 View in portal: ${portalUrl}\n`;

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
