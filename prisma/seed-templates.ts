import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TemplateDefinition {
  name: string;
  displayName: string;
  description: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  variables: { name: string; description: string; example: string }[];
}

const baseStyles = `
<style>
  body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f4f4f5; }
  .wrapper { width: 100%; background-color: #f4f4f5; padding: 40px 0; }
  .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
  .header { background-color: #2563eb; padding: 24px 40px; text-align: center; }
  .header h1 { color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 20px; font-weight: 600; margin: 0; }
  .body { padding: 40px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; line-height: 1.6; color: #374151; }
  .body h2 { color: #111827; font-size: 20px; font-weight: 600; margin: 0 0 16px 0; }
  .body p { margin: 0 0 16px 0; }
  .body a { color: #2563eb; }
  .btn-wrap { text-align: center; margin: 24px 0; }
  .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 6px; }
  .info-box { background-color: #f3f4f6; border-radius: 6px; padding: 20px; margin: 20px 0; }
  .info-box-blue { background-color: #eff6ff; border-left: 4px solid #2563eb; }
  .info-box-green { background-color: #f0fdf4; border-left: 4px solid #22c55e; }
  .info-box-yellow { background-color: #fefce8; border-left: 4px solid #eab308; }
  .info-table { width: 100%; border-collapse: collapse; }
  .info-table td { padding: 8px 0; vertical-align: top; }
  .info-table .label { font-weight: 600; color: #6b7280; width: 120px; }
  .info-table .value { color: #111827; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .badge-low { background-color: #dbeafe; color: #1e40af; }
  .badge-medium { background-color: #fef3c7; color: #92400e; }
  .badge-high { background-color: #fee2e2; color: #991b1b; }
  .badge-critical { background-color: #991b1b; color: #ffffff; }
  .footer { padding: 24px 40px; background-color: #f9fafb; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #6b7280; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; border-radius: 0 !important; }
    .header, .body, .footer { padding-left: 24px !important; padding-right: 24px !important; }
    .btn { display: block !important; width: 100% !important; }
  }
</style>`;

function wrapTemplate(content: string, companyName = '{{companyName}}'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  ${baseStyles}
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>${companyName}</h1>
      </div>
      <div class="body">
        ${content}
      </div>
      <div class="footer">
        <p>This email was sent by ${companyName}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const templates: TemplateDefinition[] = [
  // ============ TICKETING TEMPLATES ============
  {
    name: 'ticket-created',
    displayName: 'Ticket Created',
    description: 'Sent when a new support ticket is created',
    subject: '[Ticket #{{ticketNumber}}] {{ticketSubject}}',
    htmlBody: wrapTemplate(`
        <h2>New Support Ticket Created</h2>
        <p>Hi {{contactName}},</p>
        <p>Your support ticket has been created and our team will review it shortly.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{ticketSubject}}</td></tr>
            <tr><td class="label">Priority</td><td class="value"><span class="badge badge-{{priorityLower}}">{{priority}}</span></td></tr>
            <tr><td class="label">Created</td><td class="value">{{createdAt}}</td></tr>
          </table>
        </div>

        {{#if ticketDescription}}
        <p><strong>Description:</strong></p>
        <div class="info-box">
          {{ticketDescription}}
        </div>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket</a>
        </div>

        <p>If you have any additional information to add, simply reply to this email or click the button above.</p>
    `),
    textBody: `New Support Ticket Created

Hi {{contactName}},

Your support ticket has been created and our team will review it shortly.

Ticket #: {{ticketNumber}}
Subject: {{ticketSubject}}
Priority: {{priority}}
Created: {{createdAt}}

{{#if ticketDescription}}
Description:
{{ticketDescription}}
{{/if}}

View your ticket: {{ticketUrl}}

If you have any additional information to add, simply reply to this email.`,
    variables: [
      { name: 'contactName', description: 'Name of the contact', example: 'John Smith' },
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'ticketSubject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'ticketDescription', description: 'Full ticket description', example: 'I am unable to log into my email account...' },
      { name: 'priority', description: 'Priority level', example: 'High' },
      { name: 'priorityLower', description: 'Priority level lowercase', example: 'high' },
      { name: 'createdAt', description: 'Creation timestamp', example: 'Jan 15, 2024 at 2:30 PM' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'ticket-assigned',
    displayName: 'Ticket Assigned',
    description: 'Sent when a ticket is assigned to a technician',
    subject: '[Ticket #{{ticketNumber}}] Assigned to {{assigneeName}}',
    htmlBody: wrapTemplate(`
        <h2>Ticket Assigned</h2>
        <p>Hi {{contactName}},</p>
        <p>Your ticket has been assigned to <strong>{{assigneeName}}</strong> who will be assisting you.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{ticketSubject}}</td></tr>
            <tr><td class="label">Assigned To</td><td class="value">{{assigneeName}}</td></tr>
            <tr><td class="label">Priority</td><td class="value"><span class="badge badge-{{priorityLower}}">{{priority}}</span></td></tr>
          </table>
        </div>

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket</a>
        </div>

        <p>{{assigneeName}} will reach out to you shortly. If you have any urgent updates, feel free to reply to this email.</p>
    `),
    textBody: `Ticket Assigned

Hi {{contactName}},

Your ticket has been assigned to {{assigneeName}} who will be assisting you.

Ticket #: {{ticketNumber}}
Subject: {{ticketSubject}}
Assigned To: {{assigneeName}}
Priority: {{priority}}

View your ticket: {{ticketUrl}}

{{assigneeName}} will reach out to you shortly. If you have any urgent updates, feel free to reply to this email.`,
    variables: [
      { name: 'contactName', description: 'Name of the contact', example: 'John Smith' },
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'ticketSubject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'assigneeName', description: 'Name of the assigned technician', example: 'Sarah Johnson' },
      { name: 'priority', description: 'Priority level', example: 'High' },
      { name: 'priorityLower', description: 'Priority level lowercase', example: 'high' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'ticket-updated',
    displayName: 'Ticket Updated',
    description: 'Sent when a ticket receives an update or status change',
    subject: '[Ticket #{{ticketNumber}}] {{updateType}}',
    htmlBody: wrapTemplate(`
        <h2>Ticket Updated</h2>
        <p>Hi {{contactName}},</p>
        <p>There's been an update to your support ticket.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{ticketSubject}}</td></tr>
            <tr><td class="label">Status</td><td class="value">{{status}}</td></tr>
            <tr><td class="label">Updated By</td><td class="value">{{updatedBy}}</td></tr>
          </table>
        </div>

        {{#if updateMessage}}
        <p><strong>Update:</strong></p>
        <div class="info-box">
          {{updateMessage}}
        </div>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket</a>
        </div>

        <p>Reply to this email to add a comment to the ticket.</p>
    `),
    textBody: `Ticket Updated

Hi {{contactName}},

There's been an update to your support ticket.

Ticket #: {{ticketNumber}}
Subject: {{ticketSubject}}
Status: {{status}}
Updated By: {{updatedBy}}

{{#if updateMessage}}
Update:
{{updateMessage}}
{{/if}}

View your ticket: {{ticketUrl}}

Reply to this email to add a comment to the ticket.`,
    variables: [
      { name: 'contactName', description: 'Name of the contact', example: 'John Smith' },
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'ticketSubject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'status', description: 'Current ticket status', example: 'In Progress' },
      { name: 'updateType', description: 'Type of update for subject', example: 'Status Changed to In Progress' },
      { name: 'updatedBy', description: 'Name of person who made the update', example: 'Sarah Johnson' },
      { name: 'updateMessage', description: 'The update message/comment', example: 'I have started working on this issue...' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'ticket-resolved',
    displayName: 'Ticket Resolved',
    description: 'Sent to the client contact when a ticket status changes to Resolved',
    subject: '{{ticketNumber}} has been resolved',
    htmlBody: wrapTemplate(`
        <h2>Your Ticket Has Been Resolved</h2>
        <p>Hi {{contactFirstName}},</p>
        <p>Great news! Your support ticket has been resolved.</p>

        <div class="info-box info-box-green">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{subject}}</td></tr>
            <tr><td class="label">Client</td><td class="value">{{clientName}}</td></tr>
            <tr><td class="label">Status</td><td class="value"><span class="badge badge-resolved">Resolved</span></td></tr>
          </table>
        </div>

        {{#if resolutionSummary}}
        <p><strong>Resolution Summary:</strong></p>
        <div class="info-box">
          {{resolutionSummary}}
        </div>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket</a>
        </div>

        <p>If this issue reoccurs or you have any questions, simply reply to this email or click the button above to reopen the ticket.</p>

        <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">We'd love your feedback! How did we do? Reply to let us know.</p>
    `),
    textBody: `Your Ticket Has Been Resolved

Hi {{contactFirstName}},

Great news! Your support ticket has been resolved.

Ticket #: {{ticketNumber}}
Subject: {{subject}}
Client: {{clientName}}
Status: Resolved

{{#if resolutionSummary}}
Resolution Summary:
{{resolutionSummary}}
{{/if}}

View your ticket: {{ticketUrl}}

If this issue reoccurs or you have any questions, simply reply to this email to reopen the ticket.

We'd love your feedback! How did we do? Reply to let us know.`,
    variables: [
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'subject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'clientName', description: 'Name of the client company', example: 'Acme Corp' },
      { name: 'contactName', description: 'Full name of the contact', example: 'John Smith' },
      { name: 'contactFirstName', description: 'First name of the contact', example: 'John' },
      { name: 'resolutionSummary', description: 'Summary of how the issue was resolved', example: 'Reset the password and verified email access is working.' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'ticket-closed',
    displayName: 'Ticket Closed',
    description: 'Sent to the client contact when a ticket status changes to Closed',
    subject: '{{ticketNumber}} has been closed',
    htmlBody: wrapTemplate(`
        <h2>Your Ticket Has Been Closed</h2>
        <p>Hi {{contactFirstName}},</p>
        <p>Your support ticket has been closed.</p>

        <div class="info-box">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{subject}}</td></tr>
            <tr><td class="label">Client</td><td class="value">{{clientName}}</td></tr>
            <tr><td class="label">Status</td><td class="value"><span class="badge badge-closed">Closed</span></td></tr>
          </table>
        </div>

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket History</a>
        </div>

        <p>If you need further assistance with this issue, you can reply to this email to create a new ticket referencing this one.</p>

        <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">Thank you for using our support services!</p>
    `),
    textBody: `Your Ticket Has Been Closed

Hi {{contactFirstName}},

Your support ticket has been closed.

Ticket #: {{ticketNumber}}
Subject: {{subject}}
Client: {{clientName}}
Status: Closed

View ticket history: {{ticketUrl}}

If you need further assistance with this issue, you can reply to this email to create a new ticket referencing this one.

Thank you for using our support services!`,
    variables: [
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'subject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'clientName', description: 'Name of the client company', example: 'Acme Corp' },
      { name: 'contactName', description: 'Full name of the contact', example: 'John Smith' },
      { name: 'contactFirstName', description: 'First name of the contact', example: 'John' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'ticket-comment',
    displayName: 'New Ticket Comment',
    description: 'Sent when a new public comment is added to a ticket',
    subject: 'New comment on {{ticketNumber}}: {{subject}}',
    htmlBody: wrapTemplate(`
        <h2>New Comment on Your Ticket</h2>
        <p>Hi {{recipientFirstName}},</p>
        <p><strong>{{commenterName}}</strong> added a comment to your ticket.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Ticket #</td><td class="value">{{ticketNumber}}</td></tr>
            <tr><td class="label">Subject</td><td class="value">{{subject}}</td></tr>
            <tr><td class="label">Client</td><td class="value">{{clientName}}</td></tr>
          </table>
        </div>

        <p><strong>Comment:</strong></p>
        <div class="info-box" style="background-color: #ffffff; border: 1px solid #e5e7eb;">
          {{commentText}}
        </div>

        {{#if attachmentCount}}
        <p style="margin: 16px 0;">&#128206; {{attachmentCount}} attachment(s) — <a href="{{portalTicketUrl}}">View in portal</a></p>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{ticketUrl}}" class="btn">View Ticket & Reply</a>
        </div>

        <p>You can reply directly to this email to respond to the comment.</p>
    `),
    textBody: `New Comment on Your Ticket

Hi {{recipientFirstName}},

{{commenterName}} added a comment to your ticket.

Ticket #: {{ticketNumber}}
Subject: {{subject}}
Client: {{clientName}}

Comment:
{{commentText}}

{{#if attachmentCount}}
📎 {{attachmentCount}} attachment(s) — View in portal: {{portalTicketUrl}}
{{/if}}

View ticket & reply: {{ticketUrl}}

You can reply directly to this email to respond to the comment.`,
    variables: [
      { name: 'ticketNumber', description: 'Ticket number/ID', example: 'TKT-1234' },
      { name: 'subject', description: 'Subject line of the ticket', example: 'Cannot access email' },
      { name: 'clientName', description: 'Name of the client company', example: 'Acme Corp' },
      { name: 'recipientName', description: 'Full name of the recipient', example: 'John Smith' },
      { name: 'recipientFirstName', description: 'First name of the recipient', example: 'John' },
      { name: 'commenterName', description: 'Name of person who commented', example: 'Sarah Johnson' },
      { name: 'commentText', description: 'The comment text', example: 'I have checked the server logs and found the issue...' },
      { name: 'ticketUrl', description: 'URL to view the ticket', example: 'https://portal.example.com/tickets/1234' },
      { name: 'attachmentCount', description: 'Number of attachments on the comment (0 or omitted hides the attachment line)', example: '3' },
      { name: 'portalTicketUrl', description: 'Portal URL for viewing attachments', example: 'https://portal.example.com/tickets/1234' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },

  // ============ PLATFORM TEMPLATES ============
  {
    name: 'welcome',
    displayName: 'Welcome Email',
    description: 'Sent to new users when their account is created',
    subject: 'Welcome to {{companyName}}!',
    htmlBody: wrapTemplate(`
        <h2>Welcome to {{companyName}}!</h2>
        <p>Hi {{userName}},</p>
        <p>Your account has been created and you're all set to get started.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Email</td><td class="value">{{userEmail}}</td></tr>
            {{#if temporaryPassword}}
            <tr><td class="label">Temporary Password</td><td class="value" style="font-family: monospace;">{{temporaryPassword}}</td></tr>
            {{/if}}
          </table>
        </div>

        {{#if temporaryPassword}}
        <p style="color: #dc2626;"><strong>Important:</strong> Please change your password after your first login.</p>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{loginUrl}}" class="btn">Login to Your Account</a>
        </div>

        <p>If you have any questions or need help getting started, don't hesitate to reach out to our support team.</p>
    `),
    textBody: `Welcome to {{companyName}}!

Hi {{userName}},

Your account has been created and you're all set to get started.

Email: {{userEmail}}
{{#if temporaryPassword}}
Temporary Password: {{temporaryPassword}}

Important: Please change your password after your first login.
{{/if}}

Login to your account: {{loginUrl}}

If you have any questions or need help getting started, don't hesitate to reach out to our support team.`,
    variables: [
      { name: 'userName', description: 'Name of the new user', example: 'John Smith' },
      { name: 'userEmail', description: 'Email address of the user', example: 'john@example.com' },
      { name: 'temporaryPassword', description: 'Temporary password (optional)', example: 'TempPass123!' },
      { name: 'loginUrl', description: 'URL to login page', example: 'https://app.example.com/login' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'password-reset',
    displayName: 'Password Reset',
    description: 'Sent when a user requests a password reset',
    subject: 'Reset your {{companyName}} password',
    htmlBody: wrapTemplate(`
        <h2>Password Reset Request</h2>
        <p>Hi {{userName}},</p>
        <p>We received a request to reset your password. Click the button below to create a new password.</p>

        <div class="btn-wrap">
          <a href="{{resetUrl}}" class="btn">Reset Password</a>
        </div>

        <div class="info-box info-box-yellow">
          <p style="margin: 0;"><strong>This link will expire in {{expiresIn}}.</strong></p>
        </div>

        <p>If you didn't request this password reset, you can safely ignore this email. Your password will not be changed.</p>

        <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">For security reasons, this link can only be used once. If you need to reset your password again, please request a new link.</p>
    `),
    textBody: `Password Reset Request

Hi {{userName}},

We received a request to reset your password. Use the link below to create a new password:

{{resetUrl}}

This link will expire in {{expiresIn}}.

If you didn't request this password reset, you can safely ignore this email. Your password will not be changed.

For security reasons, this link can only be used once. If you need to reset your password again, please request a new link.`,
    variables: [
      { name: 'userName', description: 'Name of the user', example: 'John Smith' },
      { name: 'resetUrl', description: 'Password reset URL', example: 'https://app.example.com/reset-password?token=abc123' },
      { name: 'expiresIn', description: 'How long until link expires', example: '1 hour' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'verify-email',
    displayName: 'Email Verification',
    description: 'Sent to verify a user email address',
    subject: 'Verify your email address',
    htmlBody: wrapTemplate(`
        <h2>Verify Your Email Address</h2>
        <p>Hi {{userName}},</p>
        <p>Please verify your email address by clicking the button below.</p>

        <div class="btn-wrap">
          <a href="{{verifyUrl}}" class="btn">Verify Email Address</a>
        </div>

        <div class="info-box">
          <p style="margin: 0;">This link will expire in {{expiresIn}}.</p>
        </div>

        <p>If you didn't create an account, you can safely ignore this email.</p>
    `),
    textBody: `Verify Your Email Address

Hi {{userName}},

Please verify your email address by clicking the link below:

{{verifyUrl}}

This link will expire in {{expiresIn}}.

If you didn't create an account, you can safely ignore this email.`,
    variables: [
      { name: 'userName', description: 'Name of the user', example: 'John Smith' },
      { name: 'verifyUrl', description: 'Email verification URL', example: 'https://app.example.com/verify-email?token=abc123' },
      { name: 'expiresIn', description: 'How long until link expires', example: '24 hours' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
  {
    name: 'plan-change',
    displayName: 'Plan Change Notification',
    description: 'Sent when a subscription plan changes',
    subject: 'Your {{companyName}} plan has been updated',
    htmlBody: wrapTemplate(`
        <h2>Plan Update Confirmation</h2>
        <p>Hi {{userName}},</p>
        <p>Your subscription plan has been updated.</p>

        <div class="info-box info-box-blue">
          <table class="info-table">
            <tr><td class="label">Previous Plan</td><td class="value">{{previousPlan}}</td></tr>
            <tr><td class="label">New Plan</td><td class="value"><strong>{{newPlan}}</strong></td></tr>
            <tr><td class="label">Effective Date</td><td class="value">{{effectiveDate}}</td></tr>
            {{#if newPrice}}
            <tr><td class="label">New Price</td><td class="value">{{newPrice}}</td></tr>
            {{/if}}
          </table>
        </div>

        {{#if planFeatures}}
        <p><strong>Your new plan includes:</strong></p>
        <ul>
          {{planFeatures}}
        </ul>
        {{/if}}

        <div class="btn-wrap">
          <a href="{{accountUrl}}" class="btn">View Account Details</a>
        </div>

        <p>If you have any questions about your plan change, please contact our support team.</p>
    `),
    textBody: `Plan Update Confirmation

Hi {{userName}},

Your subscription plan has been updated.

Previous Plan: {{previousPlan}}
New Plan: {{newPlan}}
Effective Date: {{effectiveDate}}
{{#if newPrice}}
New Price: {{newPrice}}
{{/if}}

{{#if planFeatures}}
Your new plan includes:
{{planFeatures}}
{{/if}}

View account details: {{accountUrl}}

If you have any questions about your plan change, please contact our support team.`,
    variables: [
      { name: 'userName', description: 'Name of the user', example: 'John Smith' },
      { name: 'previousPlan', description: 'Previous plan name', example: 'Basic' },
      { name: 'newPlan', description: 'New plan name', example: 'Professional' },
      { name: 'effectiveDate', description: 'When the change takes effect', example: 'February 1, 2024' },
      { name: 'newPrice', description: 'New monthly/annual price', example: '$49/month' },
      { name: 'planFeatures', description: 'List of plan features (HTML)', example: '<li>Unlimited users</li><li>Priority support</li>' },
      { name: 'accountUrl', description: 'URL to account page', example: 'https://app.example.com/account' },
      { name: 'companyName', description: 'Company/MSP name', example: 'Acme IT Support' },
    ],
  },
];

async function seed() {
  console.log('Seeding email templates...');

  for (const template of templates) {
    const existing = await prisma.emailTemplate.findFirst({
      where: {
        name: template.name,
        tenantId: null,
      },
    });

    if (existing) {
      // Update existing system template
      await prisma.emailTemplate.update({
        where: { id: existing.id },
        data: {
          displayName: template.displayName,
          description: template.description,
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          variables: template.variables,
          isSystem: true,
          isActive: true,
        },
      });
      console.log(`Updated: ${template.name}`);
    } else {
      // Create new system template
      await prisma.emailTemplate.create({
        data: {
          tenantId: null,
          name: template.name,
          displayName: template.displayName,
          description: template.description,
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          variables: template.variables,
          isSystem: true,
          isActive: true,
        },
      });
      console.log(`Created: ${template.name}`);
    }
  }

  console.log('Seeding complete!');
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
