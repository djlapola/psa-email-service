import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const welcomeTemplate: EmailTemplate = {
  name: 'welcome',
  description: 'Welcome email for new users',

  sampleData: {
    userName: 'John Doe',
    companyName: 'Acme Corp',
    loginUrl: 'https://app.example.com/login',
    supportEmail: 'support@example.com',
  },

  render: (data) => {
    const userName = escapeHtml(String(data.userName || 'there'));
    const companyName = escapeHtml(String(data.companyName || 'Our Platform'));
    const loginUrl = String(data.loginUrl || '#');
    const supportEmail = escapeHtml(String(data.supportEmail || 'support@example.com'));

    const subject = `Welcome to ${companyName}!`;

    const content = `
      <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Welcome to ${companyName}!</h1>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 16px;">
        Hi ${userName},
      </p>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 24px;">
        We're excited to have you on board! Your account has been created and you're all set to get started.
      </p>

      <div style="background-color: #f8fafc; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
        <h2 style="color: #1a1a1a; font-size: 18px; margin-bottom: 16px;">Getting Started</h2>
        <ul style="color: #4a4a4a; font-size: 14px; line-height: 24px; margin: 0; padding-left: 20px;">
          <li style="margin-bottom: 8px;">Log in to your account</li>
          <li style="margin-bottom: 8px;">Complete your profile</li>
          <li style="margin-bottom: 8px;">Explore the features</li>
          <li>Reach out if you need any help</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${loginUrl}"
           style="background-color: #2563eb; color: white; padding: 14px 28px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          Log In to Your Account
        </a>
      </div>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px;">
        Need help? Contact us at <a href="mailto:${supportEmail}" style="color: #2563eb;">${supportEmail}</a>
      </p>
    `;

    const text = `
Welcome to ${companyName}!

Hi ${userName},

We're excited to have you on board! Your account has been created and you're all set to get started.

Getting Started:
- Log in to your account
- Complete your profile
- Explore the features
- Reach out if you need any help

Log in here: ${loginUrl}

Need help? Contact us at ${supportEmail}
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};
