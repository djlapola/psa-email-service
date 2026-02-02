import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const planChangeTemplate: EmailTemplate = {
  name: 'plan-change',
  description: 'Notification of subscription plan changes',

  sampleData: {
    userName: 'John Doe',
    companyName: 'Acme Corp',
    tenantName: 'Acme Corp',
    previousPlan: 'Professional',
    newPlan: 'Enterprise',
    changeType: 'upgrade', // upgrade, downgrade, cancelled
    effectiveDate: '2024-02-01',
    newPrice: '$499/month',
    dashboardUrl: 'https://app.example.com/billing',
  },

  render: (data) => {
    const userName = escapeHtml(String(data.userName || 'User'));
    const companyName = escapeHtml(String(data.companyName || 'Our Platform'));
    const tenantName = escapeHtml(String(data.tenantName || 'Your Organization'));
    const previousPlan = escapeHtml(String(data.previousPlan || 'Previous Plan'));
    const newPlan = escapeHtml(String(data.newPlan || 'New Plan'));
    const changeType = String(data.changeType || 'change');
    const effectiveDate = escapeHtml(String(data.effectiveDate || 'immediately'));
    const newPrice = escapeHtml(String(data.newPrice || ''));
    const dashboardUrl = String(data.dashboardUrl || '#');

    const isUpgrade = changeType === 'upgrade';
    const isCancelled = changeType === 'cancelled';

    const actionColor = isCancelled ? '#dc2626' : isUpgrade ? '#16a34a' : '#2563eb';
    const actionText = isCancelled ? 'Subscription Cancelled' : isUpgrade ? 'Plan Upgraded' : 'Plan Changed';

    const subject = `${actionText}: ${previousPlan} → ${newPlan} - ${companyName}`;

    const content = `
      <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">${actionText}</h1>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 16px;">
        Hi ${userName},
      </p>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 24px;">
        ${isCancelled
          ? `Your subscription for ${tenantName} has been cancelled.`
          : `Your subscription plan for ${tenantName} has been ${changeType}d.`
        }
      </p>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
        <h2 style="color: #1a1a1a; font-size: 18px; margin-bottom: 16px;">Plan Details</h2>
        <table style="width: 100%; font-size: 14px;">
          <tr>
            <td style="color: #6a6a6a; padding: 8px 0;">Previous Plan:</td>
            <td style="color: #1a1a1a; font-weight: 600; text-align: right;">${previousPlan}</td>
          </tr>
          <tr>
            <td style="color: #6a6a6a; padding: 8px 0;">New Plan:</td>
            <td style="color: ${actionColor}; font-weight: 600; text-align: right;">${isCancelled ? 'Cancelled' : newPlan}</td>
          </tr>
          <tr>
            <td style="color: #6a6a6a; padding: 8px 0;">Effective Date:</td>
            <td style="color: #1a1a1a; font-weight: 600; text-align: right;">${effectiveDate}</td>
          </tr>
          ${newPrice && !isCancelled ? `
          <tr>
            <td style="color: #6a6a6a; padding: 8px 0;">New Price:</td>
            <td style="color: #1a1a1a; font-weight: 600; text-align: right;">${newPrice}</td>
          </tr>
          ` : ''}
        </table>
      </div>

      ${isCancelled ? `
      <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
        <p style="color: #991b1b; font-size: 14px; margin: 0;">
          Your access will continue until the end of your current billing period.
          After that, your data will be retained for 30 days before being permanently deleted.
        </p>
      </div>
      ` : ''}

      <div style="text-align: center; margin: 32px 0;">
        <a href="${dashboardUrl}"
           style="background-color: #2563eb; color: white; padding: 14px 28px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          View Billing Dashboard
        </a>
      </div>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px;">
        If you have any questions about your plan or billing, please contact our support team.
      </p>
    `;

    const text = `
${actionText}

Hi ${userName},

${isCancelled
  ? `Your subscription for ${tenantName} has been cancelled.`
  : `Your subscription plan for ${tenantName} has been ${changeType}d.`
}

Plan Details:
- Previous Plan: ${previousPlan}
- New Plan: ${isCancelled ? 'Cancelled' : newPlan}
- Effective Date: ${effectiveDate}
${newPrice && !isCancelled ? `- New Price: ${newPrice}` : ''}

${isCancelled ? `Your access will continue until the end of your current billing period. After that, your data will be retained for 30 days before being permanently deleted.` : ''}

View your billing dashboard: ${dashboardUrl}

If you have any questions about your plan or billing, please contact our support team.
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};
