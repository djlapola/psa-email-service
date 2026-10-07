import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createInboundService } from '../services/inbound.service';
import { PSA_API_KEY_HEADER } from '../lib/psa-auth';
import multer from 'multer';

const router = Router();
const upload = multer();

/**
 * POST /api/inbound/sendgrid
 * Handle incoming email events from SendGrid Inbound Parse
 *
 * SendGrid sends multipart/form-data with these fields:
 * - from: sender email
 * - to: recipient email(s)
 * - cc: CC recipients
 * - subject: email subject
 * - text: plain text body
 * - html: HTML body
 * - envelope: JSON string with {"to":["email1","email2"],"from":"sender"}
 * - headers: raw email headers
 * - attachments: number of attachments
 * - attachment1, attachment2, etc: attachment files
 */
router.post('/sendgrid', upload.any(), async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const inboundService = createInboundService(prisma);

    const body = req.body;
    const receivedAt = new Date().toISOString();

    console.log('[InboundRoutes:SendGrid] Received inbound email');

    // Parse envelope to get all recipients
    let envelope: { to?: string[]; from?: string } = {};
    try {
      envelope = JSON.parse(body.envelope || '{}');
    } catch (e) {
      console.warn('[InboundRoutes:SendGrid] Could not parse envelope');
    }

    // Routing metadata only — never log bodies or attachment content.
    console.log(`[InboundRoutes:SendGrid] From: ${body.from} | To: ${body.to} | Subject: ${body.subject}`);

    // Parse headers if present
    const headers = parseEmailHeaders(body.headers || '');

    // Extract attachments from multipart files
    const attachments: Array<{ filename: string; content: string; contentType: string; contentId?: string; size: number }> = [];
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files as Express.Multer.File[]) {
        // SendGrid attachment fields are named 'attachment1', 'attachment2', etc.
        if (file.fieldname.startsWith('attachment')) {
          // Get content-id from attachment-info JSON
          let contentId: string | undefined;

          const attachmentInfoKey = 'attachment-info';
          if (body[attachmentInfoKey]) {
            try {
              const attachmentInfo = JSON.parse(body[attachmentInfoKey]);
              const info = attachmentInfo[file.fieldname];
              if (info && info['content-id']) {
                contentId = info['content-id'].replace(/[<>]/g, '');
              }
            } catch (e) {
              console.warn('[InboundRoutes:SendGrid] Could not parse attachment-info');
            }
          }

          attachments.push({
            filename: file.originalname || 'attachment',
            content: file.buffer.toString('base64'),
            contentType: file.mimetype || 'application/octet-stream',
            contentId: contentId,
            size: file.size,
          });
        }
      }
    }
    console.log(`[InboundRoutes:SendGrid] Total attachments: ${attachments.length}`);

    // Build email object matching InboundEmail interface
    const email = {
      from: body.from || envelope.from || '',
      to: body.to || (envelope.to ? envelope.to.join(', ') : ''),
      cc: body.cc || '',
      subject: body.subject || '',
      text: body.text || '',
      html: body.html || '',
      headers: headers,
      attachments: attachments,
      envelope: envelope,
      receivedAt,
    };

    // Forward to PSA (PSA owns classification + failure tracking).
    const result = await inboundService.processInboundEmail(email);

    // Map the forward outcome to the SendGrid response:
    //   - PSA 2xx                      -> 200 (acknowledged)
    //   - PSA client error (400/403/404 etc) / tenant not resolvable
    //                                  -> 200 + one log line (retrying won't help)
    //   - PSA 5xx / 408 / 429          -> 5xx (ask SendGrid to retry)
    //   - timeout                      -> 504
    //   - network error                -> 502
    switch (result.kind) {
      case 'psa-success':
        return res.status(200).send('OK');
      case 'tenant-unresolved':
        console.warn(`[InboundRoutes:SendGrid] Acknowledged without forwarding — tenant not resolvable (${result.reason})`);
        return res.status(200).send('OK');
      case 'psa-client-error':
        console.warn(`[InboundRoutes:SendGrid] PSA rejected payload (${result.status}) — acknowledging, retry would not help`);
        return res.status(200).send('OK');
      case 'psa-server-error': {
        // Always surface a 5xx so SendGrid retries; echo PSA's 5xx, else 503.
        const status = result.status >= 500 && result.status <= 599 ? result.status : 503;
        if (result.status === 401) {
          // Not bad mail — this service's PSA credential is wrong/stale. Name the
          // likely cause so the on-call fixes config rather than hunting the email.
          console.error(
            `[InboundRoutes:SendGrid] PSA returned 401 Unauthorized — likely a PSA API key/header mismatch ` +
              `(header '${PSA_API_KEY_HEADER}' from EMAIL_SERVICE_TO_PSA_API_KEY/PSA_INTERNAL_API_KEY). ` +
              `Returning ${status} so SendGrid retries until the credential is corrected.`,
          );
        } else {
          console.error(`[InboundRoutes:SendGrid] PSA upstream error (${result.status}) — returning ${status} so SendGrid retries`);
        }
        return res.status(status).send('Upstream error');
      }
      case 'timeout':
        console.error('[InboundRoutes:SendGrid] PSA timed out — returning 504 so SendGrid retries');
        return res.status(504).send('Upstream timeout');
      case 'network-error':
        console.error(`[InboundRoutes:SendGrid] PSA unreachable (${result.message}) — returning 502 so SendGrid retries`);
        return res.status(502).send('Upstream unreachable');
    }
  } catch (error: any) {
    // An error in our own parsing/forwarding, not PSA's. Return 5xx so the mail
    // is retried rather than silently dropped. Never log the body/attachments.
    console.error('[InboundRoutes:SendGrid] Internal webhook error:', error?.message || error);
    return res.status(500).send('Internal error');
  }
});

/**
 * Parse raw email headers string into key-value object
 */
function parseEmailHeaders(headersString: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headersString) return headers;

  // Headers are separated by newlines, with continuations starting with whitespace
  const lines = headersString.split(/\r?\n/);
  let currentKey = '';
  let currentValue = '';

  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Continuation of previous header
      currentValue += ' ' + line.trim();
    } else {
      // Save previous header if exists
      if (currentKey) {
        headers[currentKey.toLowerCase()] = currentValue;
      }
      // Parse new header
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        currentKey = line.substring(0, colonIndex).trim();
        currentValue = line.substring(colonIndex + 1).trim();
      }
    }
  }

  // Save last header
  if (currentKey) {
    headers[currentKey.toLowerCase()] = currentValue;
  }

  return headers;
}

/**
 * GET /api/inbound/health
 * Health check endpoint for the inbound service
 */
router.get('/health', async (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'inbound-email',
    provider: 'sendgrid',
  });
});

export default router;
