import { EmailTemplate } from '../../config/templates';
import { baseTemplate, escapeHtml } from '../base';

export const passwordResetTemplate: EmailTemplate = {
  name: 'password-reset',
  description: 'Password reset request email',

  sampleData: {
    userName: 'John Doe',
    resetUrl: 'https://app.example.com/reset-password?token=abc123',
    expiresIn: '1 hour',
    companyName: 'Acme Corp',
    ipAddress: '192.168.1.1',
  },

  render: (data) => {
    const userName = escapeHtml(String(data.userName || 'User'));
    const resetUrl = String(data.resetUrl || '#');
    const expiresIn = escapeHtml(String(data.expiresIn || '1 hour'));
    const companyName = escapeHtml(String(data.companyName || 'Our Platform'));
    const ipAddress = escapeHtml(String(data.ipAddress || 'Unknown'));

    const subject = `Reset your password - ${companyName}`;

    const content = `
      <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Reset your password</h1>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 16px;">
        Hi ${userName},
      </p>

      <p style="color: #4a4a4a; font-size: 16px; line-height: 24px; margin-bottom: 24px;">
        We received a request to reset your password. Click the button below to create a new password.
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${resetUrl}"
           style="background-color: #2563eb; color: white; padding: 14px 28px;
                  text-decoration: none; border-radius: 6px; font-weight: 600;
                  display: inline-block;">
          Reset Password
        </a>
      </div>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px; margin-bottom: 16px;">
        This link will expire in ${expiresIn}. If you didn't request a password reset,
        please ignore this email or contact support if you have concerns.
      </p>

      <div style="background-color: #fef3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 16px; margin-bottom: 16px;">
        <p style="color: #856404; font-size: 14px; margin: 0;">
          <strong>Security Notice:</strong> This request was made from IP address ${ipAddress}.
          If this wasn't you, please secure your account immediately.
        </p>
      </div>

      <p style="color: #6a6a6a; font-size: 14px; line-height: 22px;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
      </p>
    `;

    const text = `
Reset your password

Hi ${userName},

We received a request to reset your password. Click the link below to create a new password.

${resetUrl}

This link will expire in ${expiresIn}. If you didn't request a password reset, please ignore this email or contact support if you have concerns.

Security Notice: This request was made from IP address ${ipAddress}. If this wasn't you, please secure your account immediately.
    `.trim();

    return {
      subject,
      html: baseTemplate(content, companyName),
      text,
    };
  },
};
