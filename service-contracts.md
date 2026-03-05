# Email Service — Service Contracts

Every API endpoint the Email Service exposes and every outbound call it makes. Endpoints tagged with **[PSA-DEPENDENCY]** are consumed by or send to the PSA service — changing them would break PSA integration.

---

## Table of Contents

1. [Email Sending API](#1-email-sending-api)
2. [Template Management API](#2-template-management-api)
3. [Domain Provisioning API (Skyrack Subdomains)](#3-domain-provisioning-api)
4. [BYOD Custom Domain API](#4-byod-custom-domain-api)
5. [Inbound Email Webhook](#5-inbound-email-webhook)
6. [Outbound Calls to PSA](#6-outbound-calls-to-psa)
7. [Outbound Webhooks to CP & PSA](#7-outbound-webhooks-to-cp--psa)
8. [Health & Stats](#8-health--stats)
9. [Database Schema](#9-database-schema)

---

## Auth

All endpoints (except inbound webhook and health) require `x-api-key` header validated against `EMAIL_SERVICE_API_KEY`. The `authorization: Bearer <key>` header is also accepted.

---

## 1. Email Sending API

### POST `/api/send`
Send a single email. Template-based emails are queued; raw HTML emails with `html`+`subject` are sent directly.

**Request (template-based)**:
```json
{
  "to": "user@acme.com",
  "template": "tenant-welcome",
  "data": {
    "companyName": "Acme Inc",
    "loginUrl": "https://acme-inc.skyrack.com",
    "adminEmail": "admin@acme.com",
    "tempPassword": "Auto123!",
    "adminFirstName": "John"
  },
  "tenantId": "psa-tenant-uuid",
  "source": "control-plane",
  "from": "support@acme.skyrack.com",
  "replyTo": "ap@company.com",
  "customArgs": { "tenantId": "psa-tenant-uuid" }
}
```

**Request (raw HTML with attachments)**:
```json
{
  "to": ["billing@acme.com"],
  "html": "<html>Invoice HTML...</html>",
  "subject": "Invoice #INV-2024-001",
  "text": "Plain text fallback",
  "data": {},
  "source": "control-plane",
  "from": "billing@skyrack.com",
  "replyTo": "ap@company.com",
  "headers": { "In-Reply-To": "<msg-id>", "References": "<msg-id>" },
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "tags": ["invoice", "billing"],
  "attachments": [
    {
      "content": "base64-encoded-pdf...",
      "filename": "INV-2024-001.pdf",
      "type": "application/pdf"
    }
  ],
  "customArgs": { "tenantId": "psa-uuid", "invoice_id": "invoice-uuid" }
}
```

**Response** `200`:
```json
{ "success": true, "message": "Email queued successfully", "emailId": "uuid" }
```

**From address resolution** (in order):
1. BYOD custom domain (if tenant has verified domain matching `from` email domain)
2. Tenant subdomain config (`support@{subdomain}.skyrack.com` if domain verified)
3. Default `EMAIL_FROM` env var

---

### POST `/api/send/bulk`
Queue multiple emails (max 100 per request).

**Request**:
```json
{
  "emails": [
    {
      "to": "user1@acme.com",
      "template": "ticket-created",
      "data": { "ticketNumber": "TKT-000001" },
      "tenantId": "psa-uuid",
      "from": "support@acme.skyrack.com",
      "replyTo": "support@acme.skyrack.com"
    }
  ]
}
```

**Response** `200`:
```json
{
  "success": true,
  "message": "2 emails queued",
  "results": [
    { "to": "user1@acme.com", "emailId": "uuid" },
    { "to": "user2@acme.com", "error": "Invalid template" }
  ]
}
```

---

### GET `/api/status/:emailId`
Check delivery status.

**Response** `200`:
```json
{
  "id": "uuid",
  "to": "user@acme.com",
  "subject": "Welcome to Skyrack",
  "template": "tenant-welcome",
  "status": "delivered",
  "messageId": "sendgrid-msg-id",
  "tenantId": "psa-uuid",
  "attempts": 1,
  "error": null,
  "sentAt": "2024-03-15T10:30:00Z",
  "createdAt": "2024-03-15T10:29:55Z"
}
```

**Statuses**: `queued` → `sending` → `sent` → `delivered` | `bounced` | `complained` | `failed`

---

### GET `/api/logs`
Query email logs.

**Query params**: `tenantId`, `status`, `template`, `limit` (default 50), `offset` (default 0)

**Response** `200`:
```json
{ "logs": [{ /* EmailLog objects */ }], "total": 150, "limit": 50, "offset": 0 }
```

---

## 2. Template Management API

### GET `/api/templates`
List system + tenant-specific templates.

**Query params**: `tenantId` (optional — includes tenant overrides alongside system defaults)

**Response** `200`:
```json
{
  "templates": [
    {
      "id": "uuid",
      "name": "ticket-created",
      "displayName": "Ticket Created",
      "description": "Sent when a new ticket is created",
      "isSystem": true,
      "tenantId": null,
      "variables": [
        { "name": "ticketNumber", "description": "Ticket number", "example": "TKT-000001" }
      ],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

**System templates** (14):

| Name | Purpose |
|------|---------|
| `ticket-created` | New ticket notification (contact) |
| `ticket-assigned` | Ticket assignment (contact) |
| `ticket-updated` | Ticket status change (contact) |
| `ticket-resolved` | Ticket resolved (contact) |
| `ticket-closed` | Ticket closed (contact) |
| `ticket-comment` | New comment on ticket (all parties) |
| `tenant-welcome` | Tenant admin welcome after provisioning |
| `operator-welcome` | Operator account creation |
| `welcome` | Generic user welcome |
| `password-reset` | Password reset link |
| `verify-email` | Email verification |
| `plan-change` | Subscription plan change notification |
| `alert-notification` | Operator alert emails |

---

### GET `/api/templates/:name`
Get template by name. Checks tenant-specific first, falls back to system default.

**Query params**: `tenantId` (optional)

**Response** `200`:
```json
{
  "id": "uuid",
  "name": "ticket-created",
  "displayName": "Ticket Created",
  "description": "...",
  "subject": "New Ticket: {{ticketNumber}} - {{subject}}",
  "htmlBody": "<html>...</html>",
  "textBody": "Plain text...",
  "variables": [{ "name": "ticketNumber", "description": "...", "example": "..." }],
  "isSystem": true,
  "tenantId": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

### POST `/api/templates`
Create a custom tenant-specific template.

**Request**:
```json
{
  "tenantId": "psa-uuid",
  "name": "ticket-created",
  "displayName": "Custom Ticket Created",
  "description": "Our custom ticket notification",
  "subject": "{{companyName}} - New Ticket #{{ticketNumber}}",
  "htmlBody": "<html>custom body...</html>",
  "textBody": "Plain text...",
  "variables": [{ "name": "ticketNumber", "description": "...", "example": "..." }]
}
```

---

### PUT `/api/templates/:id`
Update a custom template (cannot modify system templates).

**Request**: Partial update of `displayName`, `description`, `subject`, `htmlBody`, `textBody`, `variables`, `isActive`.

---

### DELETE `/api/templates/:id`
Delete a custom template (cannot delete system templates).

---

### POST `/api/templates/:name/preview`
Preview rendered template with sample data.

**Request**:
```json
{ "tenantId": "psa-uuid", "data": { "ticketNumber": "TKT-000001", "subject": "Test" } }
```

**Response** `200`:
```json
{
  "template": "ticket-created",
  "subject": "New Ticket: TKT-000001 - Test",
  "html": "<html>rendered...</html>",
  "text": "rendered plain text...",
  "sampleData": { /* auto-generated if data not provided */ }
}
```

**Template interpolation**: `{{variable}}` for values, `{{#if variable}}...{{/if}}` for conditionals.

---

## 3. Domain Provisioning API

For Skyrack subdomain email domains (`{tenant}.skyrack.com`).

### POST `/api/domains/provision`
Full domain provisioning: SendGrid domain auth + Cloudflare DNS (CNAME, TXT, MX) + Inbound Parse webhook registration.

**Request**:
```json
{ "tenantId": "psa-tenant-uuid", "subdomain": "acme-inc" }
```

**Response** `200`:
```json
{ "success": true, "domain": "acme-inc.skyrack.com", "sendgridDomainId": "12345", "status": "pending" }
```

**Side effects**: Creates CNAME/TXT/MX DNS records in Cloudflare, registers Inbound Parse in SendGrid, stores config in `tenant_email_configs`, schedules verification in 30s.

---

### POST `/api/domains/:tenantId/verify`
Trigger domain verification against SendGrid.

**Response** `200`:
```json
{ "success": true, "status": "verified" }
```

---

### GET `/api/domains/:tenantId/status`
Get domain provisioning and verification status.

**Response** `200`:
```json
{
  "tenantId": "psa-uuid",
  "domain": "acme-inc.skyrack.com",
  "sendgridDomainId": "12345",
  "status": "verified",
  "dnsRecordsCreated": true,
  "lastChecked": "2024-03-15T10:30:00Z",
  "receivingEnabled": true,
  "receivingVerified": true
}
```

---

### POST `/api/domains/:tenantId/enable-receiving`
Enable inbound email receiving (sets up SendGrid Inbound Parse if not already configured).

---

### DELETE `/api/domains/:tenantId`
Deprovision tenant domain. Removes Inbound Parse + domain auth from SendGrid, deletes DNS records from Cloudflare, deletes config from DB.

**Response** `200`:
```json
{ "success": true }
```

---

## 4. BYOD Custom Domain API

For tenants authenticating their own sending domains (e.g., `acme.com`).

### POST `/api/domains/authenticate`
Start custom domain authentication.

**Request**:
```json
{ "tenantId": "psa-uuid", "domain": "acme.com" }
```

**Response** `200`:
```json
{
  "success": true,
  "domain": "acme.com",
  "sendgridDomainId": "67890",
  "status": "pending",
  "dnsRecords": [
    { "type": "CNAME", "host": "em1234.acme.com", "value": "u1234.wl.sendgrid.net", "valid": false },
    { "type": "CNAME", "host": "s1._domainkey.acme.com", "value": "s1.domainkey.u1234.wl.sendgrid.net", "valid": false },
    { "type": "CNAME", "host": "s2._domainkey.acme.com", "value": "s2.domainkey.u1234.wl.sendgrid.net", "valid": false }
  ],
  "message": "Add these DNS records to verify domain ownership"
}
```

---

### POST `/api/domains/verify`
Verify custom domain DNS records.

**Request**:
```json
{ "tenantId": "psa-uuid", "domain": "acme.com" }
```

**Response** `200`:
```json
{
  "success": true,
  "domain": "acme.com",
  "status": "verified",
  "valid": true,
  "validationResults": [
    { "type": "CNAME", "host": "em1234.acme.com", "valid": true },
    { "type": "CNAME", "host": "s1._domainkey.acme.com", "valid": true },
    { "type": "CNAME", "host": "s2._domainkey.acme.com", "valid": true }
  ]
}
```

---

### GET `/api/domains/:tenantId`
List all custom domains for a tenant.

**Response** `200`:
```json
{
  "tenantId": "psa-uuid",
  "domains": [
    { "id": "uuid", "domain": "acme.com", "status": "verified", "dnsRecords": [...], "verifiedAt": "...", "lastVerifiedAt": "...", "createdAt": "..." }
  ]
}
```

---

### GET `/api/domains/:tenantId/:domain/dns-records`
Get DNS records for a specific custom domain.

---

### DELETE `/api/domains/:tenantId/:domain`
Remove custom domain authentication (removes from SendGrid + DB).

---

## 5. Inbound Email Webhook

### **[PSA-DEPENDENCY]** POST `/api/inbound/sendgrid`
**No authentication** — public endpoint for SendGrid Inbound Parse.

Receives multipart/form-data when email arrives at `*@{tenant}.skyrack.com`.

**SendGrid POST fields**:
- `from`, `to`, `cc`, `subject` — email headers
- `text`, `html` — email body
- `envelope` — JSON string with sender/recipients
- `headers` — raw email headers
- `attachments` — attachment count
- `attachment1`, `attachment2`, ... — attachment files

**Processing flow**:
1. Parse tenant subdomain from "to" address
2. Look up tenant by subdomain
3. Match to existing ticket (4 methods in order):
   - `In-Reply-To` header → `EmailMessageId` table
   - `References` header → `EmailMessageId` table
   - `[TKT-XXXXXX]` in subject → PSA API lookup
   - `[TKT-XXXXXX]` in body → PSA API lookup
4. If matched: add comment via PSA API
5. If not matched: create new ticket via PSA API
6. Store `Message-ID` for future threading
7. Strip quoted reply text before creating content

**Response**: Always `200 "OK"` (prevents SendGrid retries).

---

### GET `/api/inbound/health`
Health check for inbound service.

**Response** `200`:
```json
{ "status": "ok", "service": "inbound", "provider": "sendgrid" }
```

---

## 6. Outbound Calls to PSA

Auth: `X-Control-Plane-API-Key` header with `PSA_INTERNAL_API_KEY`.
Also sends `X-Tenant-Id` header for tenant-scoped requests.
Base URL: `PSA_INTERNAL_API_URL` (default `http://localhost:3000/api/internal/v1`).

---

### **[PSA-DEPENDENCY]** POST `/tickets/from-email`
Create a ticket from an inbound email.

**Request**:
```json
{
  "tenantSubdomain": "acme-inc",
  "fromEmail": "customer@gmail.com",
  "fromName": "John Customer",
  "subject": "Help with login",
  "bodyText": "I can't log in...",
  "bodyHtml": "<p>I can't log in...</p>",
  "messageId": "<unique-msg-id@gmail.com>",
  "inReplyTo": null,
  "references": null,
  "attachments": [
    {
      "filename": "screenshot.png",
      "content": "base64-data...",
      "mimeType": "image/png",
      "contentId": "cid:image001",
      "fileSize": 45000
    }
  ]
}
```

**Response**: `{ "ticketId": "uuid" }` or `{ "id": "uuid" }`

---

### **[PSA-DEPENDENCY]** POST `/tickets/:ticketId/comments/from-email`
Add a comment to an existing ticket from an inbound email reply.

**Request**:
```json
{
  "tenantId": "psa-uuid",
  "tenantSubdomain": "acme-inc",
  "fromEmail": "customer@gmail.com",
  "fromName": "John Customer",
  "bodyText": "Thanks, that worked!",
  "bodyHtml": "<p>Thanks, that worked!</p>",
  "messageId": "<reply-msg-id@gmail.com>",
  "attachments": []
}
```

**Response**: `{ "commentId": "uuid" }` or `{ "id": "uuid" }`

---

### **[PSA-DEPENDENCY]** GET `/tickets/by-number/:ticketNumber`
Look up a ticket by display number (e.g., `TKT-000001`) for email matching.

**Response**: `{ "ticketId": "uuid" }` or `{ "id": "uuid" }` or `404`

---

## 7. Outbound Webhooks to CP & PSA

The Email Service sends webhook notifications for email delivery events.

**Target URLs** (from env): `CONTROL_PLANE_WEBHOOK_URL`, `PSA_WEBHOOK_URL`

**Events**: `email.bounced`, `email.complained`, `email.failed`

**Headers**: `X-Email-Service-Event`, `X-Email-Service-Signature` (HMAC-SHA256)

**Payload**:
```json
{
  "event": "email.bounced",
  "emailId": "uuid",
  "to": "recipient@example.com",
  "tenantId": "psa-uuid",
  "template": "ticket-created",
  "reason": "bounced",
  "error": "550 User not found"
}
```

**Retry**: 3 attempts with exponential backoff (2s, 4s, 8s). Tracked in `webhook_deliveries` table.

---

## 8. Health & Stats

### GET `/health`
Service health check. Returns `200` if available.

### GET `/api/stats`
Email statistics and aggregation.

**Query params**: `tenantId?`, `since?` (ISO date)

**Response** `200`:
```json
{
  "total": 5000,
  "byStatus": { "queued": 5, "sent": 100, "delivered": 4800, "failed": 50, "bounced": 30, "complained": 15 },
  "byTemplate": [{ "template": "ticket-created", "count": 2500 }]
}
```

---

## 9. Database Schema

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `EmailLog` | to, subject, template, status, sendgridMessageId, tenantId, attempts, error, sentAt | Tracks all email sends |
| `WebhookDelivery` | emailLogId, targetUrl, event, payload, status, attempts | Outbound webhook delivery tracking |
| `tenant_email_configs` | tenantId (unique), fromEmail, domain, domainVerified, sendgridDomainId, cloudflareDnsRecordIds, receivingEnabled | Subdomain email config |
| `EmailTemplate` | tenantId + name (unique), subject, htmlBody, textBody, variables, isSystem | System + custom templates |
| `tenant_email_domains` | tenantId + domain (unique), status, sendgridDomainId, dnsRecords, verifiedAt | BYOD custom domain records |
| `EmailMessageId` | tenantId, ticketId, commentId, messageId | Email threading (Message-ID → ticket mapping) |

### Email Statuses
`queued` → `sending` → `sent` → `delivered` | `bounced` | `complained` | `failed`

### Domain Statuses
`pending` | `verified` | `failed` | `not_provisioned`
