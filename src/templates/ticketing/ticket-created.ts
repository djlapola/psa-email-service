import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const ticketCreatedTemplate: EmailTemplate = {
  name: 'ticket-created',
  description: 'Notification when a new ticket is created',

  sampleData: {
    ticketNumber: 'TKT-001',
    ticketSubject: 'Unable to login to the application',
    ticketDescription: 'I am getting an error message when trying to log in...',
    priority: 'High',
    category: 'Technical Support',
    createdBy: 'John Doe',
    ticketUrl: 'https://app.example.com/tickets/TKT-001',
    companyName: 'Acme Corp',
    tenantName: 'Acme Corp',
  },

  render: (data) => {
    const ticketNumber = escapeHtml(String(data.ticketNumber || 'TKT-???'));
    const ticketSubject = escapeHtml(String(data.ticketSubject || 'No Subject'));
    const ticketDescription = escapeHtml(String(data.ticketDescription || '')).substring(0, 500);
    const priority = escapeHtml(String(data.priority || 'Normal'));
    const category = escapeHtml(String(data.category || 'General'));
    const createdBy = escapeHtml(String(data.createdBy || 'Unknown'));
    const ticketUrl = String(data.ticketUrl || '#');
    const companyName = escapeHtml(String(data.companyName || 'Support'));
    const tenantName = escapeHtml(String(data.tenantName || ''));

    const priorityColor = getPriorityColor(priority);

    const subject = `[${ticketNumber}] New Ticket: ${ticketSubject}`;

    const content = `
      <div style="border-left: 4px solid ${priorityColor}; padding-left: 16px; margin-bottom: 24px;">
        <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 4px 0;">
          ${ticketNumber} • ${category}
        </p>
        <h1 style="color: #1a1a1a; font-size: 22px; margin: 0;">${ticketSubject}</h1>
      </div>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <table style="width: 100%; font-size: 14px;">
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0; width: 120px;">Created by:</td>
            <td style="color: #1a1a1a; font-weight: 500;">${createdBy}</td>
          </tr>
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0;">Priority:</td>
            <td>
              <span style="background-color: ${priorityColor}20; color: ${priorityColor};
                           padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">
                ${priority}
              </span>
            </td>
          </tr>
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0;">Category:</td>
            <td style="color: #1a1a1a;">${category}</td>
          </tr>
          ${tenantName ? `
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0;">Organization:</td>
            <td style="color: #1a1a1a;">${tenantName}</td>
          </tr>
          ` : ''}
        </table>
      </div>

      ${ticketDescription ? `
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1a1a1a; font-size: 14px; font-weight: 600; margin: 0 0 8px 0;">Description:</h3>
        <p style="color: #4a4a4a; font-size: 14px; line-height: 22px; margin: 0;
                  background-color: #fafafa; padding: 16px; border-radius: 6px; white-space: pre-wrap;">
          ${ticketDescription}${ticketDescription.length >= 500 ? '...' : ''}
        </p>
      </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${ticketUrl}"
           style="background-color: #2563eb; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          View Ticket
        </a>
      </div>

      <p style="color: #6a6a6a; font-size: 13px; line-height: 20px; text-align: center;">
        Reply to this email to add a comment to the ticket.
      </p>
    `;

    const text = `
New Ticket Created: ${ticketNumber}

Subject: ${ticketSubject}

Created by: ${createdBy}
Priority: ${priority}
Category: ${category}
${tenantName ? `Organization: ${tenantName}` : ''}

${ticketDescription ? `Description:\n${ticketDescription}` : ''}

View ticket: ${ticketUrl}

Reply to this email to add a comment to the ticket.
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};

function getPriorityColor(priority: string): string {
  const colors: Record<string, string> = {
    critical: '#dc2626',
    high: '#ea580c',
    medium: '#ca8a04',
    normal: '#2563eb',
    low: '#6b7280',
  };
  return colors[priority.toLowerCase()] || colors.normal;
}
