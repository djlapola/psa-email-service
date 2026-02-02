import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const ticketResolvedTemplate: EmailTemplate = {
  name: 'ticket-resolved',
  description: 'Notification when a ticket is resolved/closed',

  sampleData: {
    ticketNumber: 'TKT-001',
    ticketSubject: 'Unable to login to the application',
    resolvedBy: 'Jane Smith',
    resolution: 'The issue was caused by an expired session token. We have updated the authentication system to handle token refresh more gracefully.',
    ticketUrl: 'https://app.example.com/tickets/TKT-001',
    feedbackUrl: 'https://app.example.com/feedback?ticket=TKT-001',
    companyName: 'Acme Corp',
    reopenDays: 7,
  },

  render: (data) => {
    const ticketNumber = escapeHtml(String(data.ticketNumber || 'TKT-???'));
    const ticketSubject = escapeHtml(String(data.ticketSubject || 'No Subject'));
    const resolvedBy = escapeHtml(String(data.resolvedBy || 'Our team'));
    const resolution = escapeHtml(String(data.resolution || '')).substring(0, 1000);
    const ticketUrl = String(data.ticketUrl || '#');
    const feedbackUrl = String(data.feedbackUrl || '');
    const companyName = escapeHtml(String(data.companyName || 'Support'));
    const reopenDays = Number(data.reopenDays || 7);

    const subject = `[${ticketNumber}] Resolved: ${ticketSubject}`;

    const content = `
      <div style="background-color: #dcfce7; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
        <div style="font-size: 32px; margin-bottom: 8px;">✓</div>
        <p style="color: #166534; font-size: 16px; font-weight: 600; margin: 0;">
          Your ticket has been resolved!
        </p>
      </div>

      <div style="border-left: 4px solid #16a34a; padding-left: 16px; margin-bottom: 24px;">
        <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 4px 0;">${ticketNumber}</p>
        <h1 style="color: #1a1a1a; font-size: 20px; margin: 0;">${ticketSubject}</h1>
      </div>

      ${resolution ? `
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1a1a1a; font-size: 14px; font-weight: 600; margin: 0 0 8px 0;">Resolution:</h3>
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 8px;">
          <p style="color: #166534; font-size: 14px; line-height: 22px; margin: 0; white-space: pre-wrap;">
            ${resolution}
          </p>
        </div>
      </div>
      ` : ''}

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <p style="color: #4a4a4a; font-size: 14px; margin: 0;">
          Resolved by <strong>${resolvedBy}</strong>
        </p>
      </div>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${ticketUrl}"
           style="background-color: #2563eb; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block; margin-right: 12px;">
          View Ticket
        </a>
        ${feedbackUrl ? `
        <a href="${feedbackUrl}"
           style="background-color: #16a34a; color: white; padding: 12px 24px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          Rate Support
        </a>
        ` : ''}
      </div>

      <div style="background-color: #fefce8; border: 1px solid #fef08a; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
        <p style="color: #854d0e; font-size: 13px; margin: 0;">
          <strong>Not resolved?</strong> Reply to this email within ${reopenDays} days to reopen the ticket.
          After that, please create a new ticket.
        </p>
      </div>

      <p style="color: #6a6a6a; font-size: 13px; line-height: 20px; text-align: center;">
        Thank you for contacting ${companyName} support!
      </p>
    `;

    const text = `
Ticket Resolved: ${ticketNumber}

Your ticket has been resolved!

Subject: ${ticketSubject}
Resolved by: ${resolvedBy}

${resolution ? `Resolution:\n${resolution}` : ''}

View ticket: ${ticketUrl}
${feedbackUrl ? `Rate our support: ${feedbackUrl}` : ''}

Not resolved? Reply to this email within ${reopenDays} days to reopen the ticket. After that, please create a new ticket.

Thank you for contacting ${companyName} support!
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};
