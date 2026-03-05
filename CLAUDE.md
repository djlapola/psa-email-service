# Email Service — Project Context

## What This Service Does

Standalone microservice handling all email operations for the Skyrack platform:
- **Outbound email delivery** via SendGrid (template-based and raw HTML, with queue + retry)
- **Inbound email-to-ticket routing** via SendGrid Inbound Parse (parses incoming emails, matches to tickets, creates/comments via PSA API)
- **Email domain provisioning** (SendGrid domain auth + Cloudflare DNS for tenant subdomains)
- **BYOD custom domain authentication** (tenants bring their own sending domains)
- **Template management** (14 system templates + per-tenant custom overrides)

---

## Related Services

| Service | Location | Contracts |
|---------|----------|-----------|
| **Control Plane** | `/opt/control-plane/` | See `/opt/control-plane/service-contracts.md` |
| **PSA Service** | External (not in these repos) | See `service-contracts.md` in this repo |

- **Control Plane**: Calls this service to send emails (welcome, alerts, invoices), provision/deprovision domains, and manage template overrides. Authenticates with `x-api-key` header.
- **PSA Service**: This service calls PSA's internal API to create tickets and add comments from inbound emails. Authenticates with `X-Control-Plane-API-Key` header.

---

## Architecture

```
   ┌──────────────┐     ┌──────────────┐
   │ Control Plane│     │ PSA Service   │
   │ (port 4000)  │     │ (port 3000)   │
   └──────┬───────┘     └───────▲───────┘
          │ x-api-key           │ X-Control-Plane-API-Key
   ┌──────▼─────────────────────┴───────┐
   │          Email Service              │  Express (port 4001)
   │  ┌──────────────────────────────┐  │
   │  │ PostgreSQL (Prisma ORM)      │  │  Shared DB instance with CP
   │  └──────────────────────────────┘  │
   │  ┌──────────┐  ┌───────────────┐  │
   │  │ Queue    │  │ Template      │  │
   │  │ Service  │  │ Engine        │  │
   │  └────┬─────┘  └───────────────┘  │
   └───────┼────────────┬───────────────┘
           │            │
   ┌───────▼────┐  ┌────▼───────────┐
   │ SendGrid   │  │ Cloudflare DNS │
   │ (SMTP +    │  │ (domain setup) │
   │ Domain Auth│  │                │
   │ + Inbound  │  └────────────────┘
   │   Parse)   │
   └────────────┘
```

### Auth Patterns
- **Control Plane → Email Service**: `x-api-key` header validated against `EMAIL_SERVICE_API_KEY`
- **Email Service → PSA**: `X-Control-Plane-API-Key` header with `PSA_INTERNAL_API_KEY`
- **SendGrid Inbound Parse → Email Service**: No auth (public webhook at `/api/inbound/sendgrid`)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (Alpine) |
| Framework | Express 4.18 |
| ORM | Prisma 5.7 + PostgreSQL (shared instance with CP) |
| Email sending | @sendgrid/mail 8.1, @sendgrid/client 8.1 |
| DNS management | Cloudflare API (via axios) |
| File uploads | multer 2.0 (inbound email attachments) |
| Template engine | Custom `{{variable}}` + `{{#if}}` interpolation |
| Queue | In-memory with retry logic (3 attempts, exponential backoff) |

---

## Build & Deploy

### Local Development
```bash
npm run dev                        # ts-node-dev with hot-reload (port 4001)
```

### Build Commands
```bash
npm run build                      # tsc → dist/
npm start                          # node dist/server.js
npx prisma generate               # Generate Prisma client
npm run seed:templates             # Seed 14 system email templates
```

### Type Checking
```bash
npx tsc --noEmit
```

### Database Migrations
```bash
npm run prisma:migrate             # prisma migrate deploy
npm run prisma:migrate:dev         # prisma migrate dev (creates new migrations)
```

### Docker
```bash
docker compose up --build          # port 4001, joins control-plane_cp-network
```

The Email Service Docker Compose connects to CP's external network (`control-plane_cp-network`) and uses the shared PostgreSQL instance (`cp-postgres`).

---

## Key Patterns

### Template System
- 14 system templates seeded via `npm run seed:templates` (stored with `isSystem=true`, `tenantId=null`)
- Tenants can create custom overrides (same template name, different `tenantId`)
- Lookup priority: tenant-specific → system default
- Interpolation: `{{variable}}` for values, `{{#if variable}}...{{/if}}` for conditionals
- System templates: `ticket-created`, `ticket-assigned`, `ticket-updated`, `ticket-resolved`, `ticket-closed`, `ticket-comment`, `tenant-welcome`, `operator-welcome`, `welcome`, `password-reset`, `verify-email`, `plan-change`, `alert-notification`

### Email Queue
- In-memory queue with 1-second processing interval
- Template rendered at enqueue time
- Retry: 3 attempts with exponential backoff (1s, 5s, 30s)
- Failed emails trigger webhook notifications to CP and PSA
- Pending/in-progress emails reloaded from DB on startup

### From Address Resolution
When sending an email, the `from` address is resolved in order:
1. BYOD custom domain (if tenant has a verified custom domain matching the requested `from` email domain)
2. Tenant subdomain config (`support@{subdomain}.skyrack.com` if domain is verified in `tenant_email_configs`)
3. Default `EMAIL_FROM` env var

### Domain Provisioning Flow (Skyrack Subdomains)
1. Create domain auth in SendGrid → get DNS records (CNAME for SPF, TXT for DKIM)
2. Create DNS records in Cloudflare
3. Add MX record for inbound email receiving
4. Register SendGrid Inbound Parse webhook
5. Store config in `tenant_email_configs` table (includes Cloudflare record IDs for cleanup)
6. Schedule verification after 30 seconds

### Inbound Email → Ticket Routing
1. Email arrives at `support@{tenant}.skyrack.com`
2. SendGrid Inbound Parse POSTs multipart/form-data to `/api/inbound/sendgrid`
3. Parse tenant subdomain from "to" address
4. Match to existing ticket via 4 methods (in order):
   - `In-Reply-To` header → `EmailMessageId` table lookup
   - `References` header → `EmailMessageId` table lookup
   - `[TKT-XXXXXX]` pattern in subject → PSA API lookup
   - `[TKT-XXXXXX]` pattern in body → PSA API lookup
5. If matched: add comment via PSA Internal API
6. If not matched: create new ticket via PSA Internal API
7. Store `Message-ID` in `EmailMessageId` table for future threading
8. Quoted reply text is stripped before creating ticket/comment

### BYOD Custom Domain Authentication
- Tenants can authenticate their own sending domains (e.g., `acme.com`)
- Creates SendGrid domain auth, returns DNS records (CNAME) tenant must configure
- Verification checks DNS record validity via SendGrid API
- Verified BYOD domains are automatically used for `from` address when email domain matches

### Outbound Webhooks
- Sends notifications to CP and PSA for: `email.bounced`, `email.complained`, `email.failed`
- Includes HMAC-SHA256 signature in `X-Email-Service-Signature` header
- 3 retries with exponential backoff, tracked in `webhook_deliveries` table

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `EmailLog` | Tracks all email sends (to, subject, template, status, messageId, attempts, error, sentAt) |
| `WebhookDelivery` | Tracks outbound webhook deliveries to CP/PSA (url, event, payload, status, attempts) |
| `tenant_email_configs` | Tenant subdomain email config (fromEmail, domain, domainVerified, sendgridDomainId, cloudflareDnsRecordIds, receivingEnabled) |
| `EmailTemplate` | System + custom templates, unique on (tenantId, name). Variables stored as JSON array |
| `tenant_email_domains` | BYOD custom domain auth records (domain, status, sendgridDomainId, dnsRecords, verifiedAt) |
| `EmailMessageId` | Maps Message-ID headers to tenantId + ticketId + commentId for email threading |

---

## Route Files

| File | Mount | Purpose |
|------|-------|---------|
| `email.routes.ts` | `/api` | Send, bulk send, status, logs, stats, template CRUD, preview |
| `domain.routes.ts` | `/api/domains` | Subdomain provisioning, verification, status, deprovision |
| `domain-auth.routes.ts` | `/api/domains` | BYOD custom domain auth, verification, DNS records |
| `inbound.routes.ts` | `/api/inbound` | SendGrid Inbound Parse webhook (public, no auth) |

## Service Files

| Service | Purpose |
|---------|---------|
| `sendgrid.service.ts` | SendGrid API: send email, resolve tenant from address, check BYOD domains |
| `template.service.ts` | Template CRUD, rendering (`{{var}}` + `{{#if}}`), system/custom lookup |
| `queue.service.ts` | In-memory email queue, batch processing, retry with backoff, DB persistence |
| `domain.service.ts` | Full domain provisioning workflow, SendGrid + Cloudflare orchestration |
| `inbound.service.ts` | Inbound email parsing, ticket matching (4 methods), PSA API calls |
| `cloudflare.service.ts` | Cloudflare DNS record CRUD, batch create/delete |
| `webhook.service.ts` | Outbound webhook delivery to CP/PSA with retry and HMAC signing |

---

## Environment Variables

### Required
| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SENDGRID_API_KEY` | SendGrid API key for sending + domain auth |
| `EMAIL_SERVICE_API_KEY` | API key for authenticating inbound requests from CP |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for DNS management |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID for the base domain |
| `BASE_DOMAIN` | Base domain for tenant subdomains (e.g., `skyrack.com`) |
| `PSA_INTERNAL_API_URL` | PSA API base for inbound email → ticket creation |
| `PSA_INTERNAL_API_KEY` | PSA auth key for inbound email routing |

### Optional
| Variable | Purpose |
|----------|---------|
| `PORT` | Express port (default: 4001) |
| `EMAIL_FROM` | Default from address (e.g., `noreply@skyrack.com`) |
| `EMAIL_FROM_NAME` | Default from name (e.g., `Skyrack PSA`) |
| `INBOUND_PARSE_URL` | Public URL for SendGrid Inbound Parse webhook registration |
| `CONTROL_PLANE_WEBHOOK_URL` | CP webhook URL for bounce/failure notifications |
| `PSA_WEBHOOK_URL` | PSA webhook URL for bounce/failure notifications |

---

## Post-Production Checklist
- [ ] Configure SendGrid Inbound Parse → `https://<email-service-domain>/api/inbound/sendgrid` for `*.skyrack.com` MX
- [ ] Seed system templates: `npm run seed:templates`
