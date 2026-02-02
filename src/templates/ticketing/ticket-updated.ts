import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml, formatDateTime } from '../base';

export const ticketUpdatedTemplate: EmailTemplate = {
  name: 'ticket-updated',
  description: 'Notification when a ticket is updated with a new comment or change',

  sampleData: {
    ticketNumber: 'TKT-001',
    ticketSubject: 'Unable to login to the application',
    updatedBy: 'Jane Smith',
    updateType: 'comment', // comment, status_change, priority_change
    comment: 'I have looked into this issue and found the root cause...',
    previousStatus: 'Open',
    newStatus: 'In Progress',
    previousPriority: 'Normal',
    newPriority: 'High',
    ticketUrl: 'https://app.example.com/tickets/TKT-001',
    companyName: 'Acme Corp',
    updatedAt: new Date().toISOString(),
  },

  render: (data) => {
    const ticketNumber = escapeHtml(String(data.ticketNumber || 'TKT-???'));
    const ticketSubject = escapeHtml(String(data.ticketSubject || 'No Subject'));
    const updatedBy = escapeHtml(String(data.updatedBy || 'Someone'));
    const updateType = String(data.updateType || 'update');
    const comment = escapeHtml(String(data.comment || '')).substring(0, 1000);
    const previousStatus = escapeHtml(String(data.previousStatus || ''));
    const newStatus = escapeHtml(String(data.newStatus || ''));
    const previousPriority = escapeHtml(String(data.previousPriority || ''));
    const newPriority = escapeHtml(String(data.newPriority || ''));
    const ticketUrl = String(data.ticketUrl || '#');
    const companyName = escapeHtml(String(data.companyName || 'Support'));
    const updatedAt = data.updatedAt ? formatDateTime(String(data.updatedAt)) : '';

    const subject = `[${ticketNumber}] ${getUpdateTitle(updateType)}: ${ticketSubject}`;

    let updateContent = '';

    if (updateType === 'comment' && comment) {
      updateContent = `
        <div style="margin-bottom: 24px;">
          <div style="display: flex; align-items: center; margin-bottom: 12px;">
            <div style="width: 40px; height: 40px; background-color: #e5e7eb; border-radius: 50%;
                        display: inline-flex; align-items: center; justify-content: center;
                        font-weight: 600; color: #4b5563; font-size: 16px; margin-right: 12px;">
              ${updatedBy.charAt(0).toUpperCase()}
            </div>
            <div>
              <p style="margin: 0; font-weight: 600; color: #1a1a1a;">${updatedBy}</p>
              <p style="margin: 0; font-size: 12px; color: #6b7280;">${updatedAt}</p>
            </div>
          </div>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 3px solid #2563eb;">
            <p style="color: #4a4a4a; font-size: 14px; line-height: 22px; margin: 0; white-space: pre-wrap;">
              ${comment}
            </p>
          </div>
        </div>
      `;
    }

    if (updateType === 'status_change' && previousStatus && newStatus) {
      updateContent = `
        <div style="background-color: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 12px 0;">
            <strong>${updatedBy}</strong> changed the status
          </p>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="background-color: #e5e7eb; color: #4b5563; padding: 6px 12px;
                         border-radius: 6px; font-size: 14px; text-decoration: line-through;">
              ${previousStatus}
            </span>
            <span style="color: #6b7280;">→</span>
            <span style="background-color: #dbeafe; color: #1d4ed8; padding: 6px 12px;
                         border-radius: 6px; font-size: 14px; font-weight: 600;">
              ${newStatus}
            </span>
          </div>
        </div>
      `;
    }

    if (updateType === 'priority_change' && previousPriority && newPriority) {
      updateContent = `
        <div style="background-color: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 12px 0;">
            <strong>${updatedBy}</strong> changed the priority
          </p>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="background-color: #e5e7eb; color: #4b5563; padding: 6px 12px;
                         border-radius: 6px; font-size: 14px; text-decoration: line-through;">
              ${previousPriority}
            </span>
            <span style="color: #6b7280;">→</span>
            <span style="background-color: #fef3c7; color: #b45309; padding: 6px 12px;
                         border-radius: 6px; font-size: 14px; font-weight: 600;">
              ${newPriority}
            </span>
          </div>
        </div>
      `;
    }

    const content = `
      <div style="border-left: 4px solid #2563eb; padding-left: 16px; margin-bottom: 24px;">
        <p style="color: #6a6a6a; font-size: 14px; margin: 0 0 4px 0;">${ticketNumber}</p>
        <h1 style="color: #1a1a1a; font-size: 20px; margin: 0;">${ticketSubject}</h1>
      </div>

      ${updateContent}

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
Ticket Updated: ${ticketNumber}

Subject: ${ticketSubject}

${updateType === 'comment' ? `${updatedBy} commented:\n\n${comment}` : ''}
${updateType === 'status_change' ? `${updatedBy} changed status: ${previousStatus} → ${newStatus}` : ''}
${updateType === 'priority_change' ? `${updatedBy} changed priority: ${previousPriority} → ${newPriority}` : ''}

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

function getUpdateTitle(updateType: string): string {
  switch (updateType) {
    case 'comment':
      return 'New Comment';
    case 'status_change':
      return 'Status Changed';
    case 'priority_change':
      return 'Priority Changed';
    default:
      return 'Updated';
  }
}
