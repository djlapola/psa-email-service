import { verifyEmailTemplate } from '../templates/platform/verify-email';
import { welcomeTemplate } from '../templates/platform/welcome';
import { passwordResetTemplate } from '../templates/platform/password-reset';
import { planChangeTemplate } from '../templates/platform/plan-change';
import { ticketCreatedTemplate } from '../templates/ticketing/ticket-created';
import { ticketUpdatedTemplate } from '../templates/ticketing/ticket-updated';
import { ticketAssignedTemplate } from '../templates/ticketing/ticket-assigned';
import { ticketResolvedTemplate } from '../templates/ticketing/ticket-resolved';

export interface EmailTemplate {
  name: string;
  description: string;
  render: (data: Record<string, unknown>) => {
    subject: string;
    html: string;
    text: string;
  };
  sampleData?: Record<string, unknown>;
}

const templates: Record<string, EmailTemplate> = {
  // Platform templates
  'verify-email': verifyEmailTemplate,
  'welcome': welcomeTemplate,
  'password-reset': passwordResetTemplate,
  'plan-change': planChangeTemplate,

  // Ticketing templates
  'ticket-created': ticketCreatedTemplate,
  'ticket-updated': ticketUpdatedTemplate,
  'ticket-assigned': ticketAssignedTemplate,
  'ticket-resolved': ticketResolvedTemplate,
};

export function getTemplate(name: string): EmailTemplate | undefined {
  return templates[name];
}

export function listTemplates(): { name: string; description: string }[] {
  return Object.entries(templates).map(([name, template]) => ({
    name,
    description: template.description,
  }));
}

export function registerTemplate(name: string, template: EmailTemplate): void {
  templates[name] = template;
}
