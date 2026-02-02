import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const ticketAssignedTemplate: EmailTemplate = {
  name: 'ticket-assigned',
  description: 'Notification when a ticket is assigned to someone',

  sampleData: {
    ticketNumber: 'TKT-001',
    ticketSubject: 'Unable to login to the application',
    ticketDescription: 'I am getting an error message when trying to log in...',
    assignedTo: 'Jane Smith',
    assignedBy: 'John Doe',
    priority: 'High',
    category: 'Technical Support',
    ticketUrl: 'https://app.example.com/tickets/TKT-001',
    companyName: 'Acme Corp',
    tenantName: 'Acme Corp',
    dueDate: '2024-02-05',
  },

  render: (data) => {
    const ticketNumber = escapeHtml(String(data.ticketNumber || 'TKT-???'));
    const ticketSubject = escapeHtml(String(data.ticketSubject || 'No Subject'));
    const ticketDescription = escapeHtml(String(data.ticketDescription || '')).substring(0, 300);
    const assignedTo = escapeHtml(String(data.assignedTo || 'Someone'));
    const assignedBy = escapeHtml(String(data.assignedBy || 'Someone'));
    const priority = escapeHtml(String(data.priority || 'Normal'));
    const category = escapeHtml(String(data.category || 'General'));
    const ticketUrl = String(data.ticketUrl || '#');
    const companyName = escapeHtml(String(data.companyName || 'Support'));
    const tenantName = escapeHtml(String(data.tenantName || ''));
    const dueDate = escapeHtml(String(data.dueDate || ''));

    const priorityColor = getPriorityColor(priority);

    const subject = `[${ticketNumber}] Assigned to you: ${ticketSubject}`;

    const content = `
      <div style="background-color: #dbeafe; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <p style="color: #1e40af; font-size: 14px; margin: 0;">
          <strong>${assignedBy}</strong> assigned ticket <strong>${ticketNumber}</strong> to you.
        </p>
      </div>

      <div style="border-left: 4px solid ${priorityColor}; padding-left: 16px; margin-bottom: 24px;">
        <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 4px 0;">
          ${ticketNumber} • ${category}
        </p>
        <h1 style="color: #1a1a1a; font-size: 22px; margin: 0;">${ticketSubject}</h1>
      </div>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <table style="width: 100%; font-size: 14px;">
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0; width: 120px;">Assigned to:</td>
            <td style="color: #1a1a1a; font-weight: 600;">${assignedTo}</td>
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
          ${dueDate ? `
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0;">Due Date:</td>
            <td style="color: #dc2626; font-weight: 500;">${dueDate}</td>
          </tr>
          ` : ''}
          ${tenantName ? `
          <tr>
            <td style="color: #6a6a6a; padding: 6px 0;">Customer:</td>
            <td style="color: #1a1a1a;">${tenantName}</td>
          </tr>
          ` : ''}
        </table>
      </div>

      ${ticketDescription ? `
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1a1a1a; font-size: 14px; font-weight: 600; margin: 0 0 8px 0;">Description:</h3>
        <p style="color: #4a4a4a; font-size: 14px; line-height: 22px; margin: 0;
                  background-color: #fafafa; padding: 16px; border-radius: 6px;">
          ${ticketDescription}${ticketDescription.length >= 300 ? '...' : ''}
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
    `;

    const text = `
Ticket Assigned to You: ${ticketNumber}

${assignedBy} assigned ticket ${ticketNumber} to you.

Subject: ${ticketSubject}
Priority: ${priority}
${dueDate ? `Due Date: ${dueDate}` : ''}
${tenantName ? `Customer: ${tenantName}` : ''}

${ticketDescription ? `Description:\n${ticketDescription}` : ''}

View ticket: ${ticketUrl}
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
