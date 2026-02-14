import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createInboundService } from '../services/inbound.service';
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

    console.log('[InboundRoutes:SendGrid] Received inbound email');
    console.log('[InboundRoutes:SendGrid] Fields:', Object.keys(body));

    // Parse envelope to get all recipients
    let envelope: { to?: string[]; from?: string } = {};
    try {
      envelope = JSON.parse(body.envelope || '{}');
    } catch (e) {
      console.warn('[InboundRoutes:SendGrid] Could not parse envelope:', body.envelope);
    }

    console.log('[InboundRoutes:SendGrid] From:', body.from);
    console.log('[InboundRoutes:SendGrid] To:', body.to);
    console.log('[InboundRoutes:SendGrid] CC:', body.cc);
    console.log('[InboundRoutes:SendGrid] Envelope:', JSON.stringify(envelope));
    console.log('[InboundRoutes:SendGrid] Subject:', body.subject);

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

          console.log(`[InboundRoutes:SendGrid] Attachment: ${file.originalname} (${file.mimetype}, ${file.size} bytes, cid: ${contentId || 'none'})`);
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
    };

    console.log(`[InboundRoutes:SendGrid] Processing email from: ${email.from} to: ${email.to} subject: ${email.subject}`);

    // Process the inbound email
    const result = await inboundService.processInboundEmail(email);

    if (result.success) {
      console.log(`[InboundRoutes:SendGrid] Successfully processed email -> ticket: ${result.ticketId} (new: ${result.isNew})`);
    } else {
      console.error(`[InboundRoutes:SendGrid] Failed to process email: ${result.error}`);
    }

    // Always return 200 to SendGrid to acknowledge receipt
    res.status(200).send('OK');
  } catch (error: any) {
    console.error('[InboundRoutes:SendGrid] Webhook processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).send('OK');
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
