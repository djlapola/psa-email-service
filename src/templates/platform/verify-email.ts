import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const verifyEmailTemplate: EmailTemplate = {
  name: 'verify-email',
  description: 'Email verification for new user accounts',

  sampleData: {
    userName: 'John Doe',
    verificationUrl: 'https://app.example.com/verify?token=abc123',
    expiresIn: '24 hours',
    companyName: 'Acme Corp',
  },

  render: (data) => {
    const userName = escapeHtml(String(data.userName || 'User'));
    const verificationUrl = String(data.verificationUrl || '#');
    const expiresIn = escapeHtml(String(data.expiresIn || '24 hours'));
    const companyName = escapeHtml(String(data.companyName || 'Our Platform'));

    const subject = `Verify your email address - ${companyName}`;

    const content = `
      <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Verify your email address</h1>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 16px;">
        Hi ${userName},
      </p>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 24px;">
        Thank you for signing up! Please verify your email address by clicking the button below.
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${verificationUrl}"
           style="background-color: #2563eb; color: white; padding: 14px 28px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          Verify Email Address
        </a>
      </div>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px; margin-bottom: 16px;">
        This link will expire in ${expiresIn}. If you didn't create an account with ${companyName},
        you can safely ignore this email.
      </p>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${verificationUrl}" style="color: #2563eb; word-break: break-all;">${verificationUrl}</a>
      </p>
    `;

    const text = `
Verify your email address

Hi ${userName},

Thank you for signing up! Please verify your email address by clicking the link below.

${verificationUrl}

This link will expire in ${expiresIn}. If you didn't create an account with ${companyName}, you can safely ignore this email.
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};
