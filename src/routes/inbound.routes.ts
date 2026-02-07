import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createInboundService } from '../services/inbound.service';
import crypto from 'crypto';

const router = Router();

/**
 * Verify Resend webhook signature using Svix format
 * Resend uses Svix for webhook delivery which includes specific headers
 */
function verifyWebhookSignature(
  payload: string | Buffer,
  svixId: string | undefined,
  svixTimestamp: string | undefined,
  svixSignature: string | undefined
): boolean {
  // Use separate secret for inbound email webhooks
  const webhookSecret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;

  // Debug logging
  console.log('[InboundRoutes] === Webhook Signature Verification Debug ===');
  console.log(`[InboundRoutes] RESEND_INBOUND_WEBHOOK_SECRET set: ${!!webhookSecret}`);
  console.log(`[InboundRoutes] Svix headers present - id: ${!!svixId}, timestamp: ${!!svixTimestamp}, signature: ${!!svixSignature}`);

  const payloadString = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  console.log(`[InboundRoutes] Payload type: ${typeof payload}, isBuffer: ${Buffer.isBuffer(payload)}, length: ${payloadString.length}`);
  console.log(`[InboundRoutes] Payload preview: ${payloadString.substring(0, 100)}...`);

  if (!webhookSecret) {
    console.warn('[InboundRoutes] RESEND_INBOUND_WEBHOOK_SECRET not configured, skipping signature verification');
    return true; // Allow in development
  }

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.error('[InboundRoutes] Missing Svix headers for signature verification');
    console.error(`[InboundRoutes] svix-id: ${svixId}`);
    console.error(`[InboundRoutes] svix-timestamp: ${svixTimestamp}`);
    console.error(`[InboundRoutes] svix-signature: ${svixSignature}`);
    return false;
  }

  try {
    // Svix signature format: v1,signature (space-separated if multiple)
    const signatureParts = svixSignature.split(' ');
    const signatures = signatureParts.map(part => {
      const [version, sig] = part.split(',');
      return { version, signature: sig };
    });
    console.log(`[InboundRoutes] Provided signatures: ${JSON.stringify(signatures)}`);

    // Build the signed payload
    const signedPayload = `${svixId}.${svixTimestamp}.${payloadString}`;
    console.log(`[InboundRoutes] Signed payload prefix: ${signedPayload.substring(0, 150)}...`);

    // Decode the secret (Svix secrets are base64 encoded with whsec_ prefix)
    const secretKey = webhookSecret.startsWith('whsec_')
      ? Buffer.from(webhookSecret.slice(6), 'base64')
      : Buffer.from(webhookSecret, 'base64');
    console.log(`[InboundRoutes] Secret has whsec_ prefix: ${webhookSecret.startsWith('whsec_')}`);

    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(signedPayload)
      .digest('base64');
    console.log(`[InboundRoutes] Calculated signature: ${expectedSignature}`);

    // Check if any of the provided signatures match
    const matched = signatures.some(sig => sig.signature === expectedSignature);
    console.log(`[InboundRoutes] Signature match: ${matched}`);
    console.log('[InboundRoutes] === End Debug ===');

    return matched;
  } catch (error) {
    console.error('[InboundRoutes] Webhook signature verification error:', error);
    return false;
  }
}

/**
 * POST /api/inbound/webhook
 * Handle incoming email events from Resend
 *
 * Resend sends email.received events when emails are received on domains
 * with receiving enabled.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const prisma: PrismaClient = req.app.locals.prisma;
    const inboundService = createInboundService(prisma);

    // Get raw body for signature verification
    // express.raw() gives us a Buffer, but it might be parsed JSON if middleware order is wrong
    let rawBody: string;
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else {
      // If it's already parsed as JSON, we need to stringify it back
      // This may cause signature verification to fail due to formatting differences
      console.warn('[InboundRoutes] req.body is not a Buffer or string, it may have been pre-parsed as JSON');
      rawBody = JSON.stringify(req.body);
    }

    console.log(`[InboundRoutes] req.body type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}`);

    // Verify webhook signature
    const svixId = req.headers['svix-id'] as string | undefined;
    const svixTimestamp = req.headers['svix-timestamp'] as string | undefined;
    const svixSignature = req.headers['svix-signature'] as string | undefined;

    if (!verifyWebhookSignature(rawBody, svixId, svixTimestamp, svixSignature)) {
      console.error('[InboundRoutes] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse the event from raw body
    const event = JSON.parse(rawBody);

    console.log(`[InboundRoutes] Received webhook event: ${event.type}`);

    // Only process email.received events
    if (event.type !== 'email.received') {
      console.log(`[InboundRoutes] Ignoring event type: ${event.type}`);
      return res.status(200).json({ received: true, ignored: true });
    }

    // Extract email data from the event
    const emailData = event.data;

    console.log('[InboundRoutes] emailData.to:', JSON.stringify(emailData.to));
    console.log('[InboundRoutes] emailData.cc:', JSON.stringify(emailData.cc));
    console.log('[InboundRoutes] emailData.envelope:', JSON.stringify(emailData.envelope));
    console.log('[InboundRoutes] Full emailData keys:', Object.keys(emailData || {}));
    console.log('[InboundRoutes] emailData.text present:', !!emailData?.text, 'length:', emailData?.text?.length || 0);
    console.log('[InboundRoutes] emailData.html present:', !!emailData?.html, 'length:', emailData?.html?.length || 0);

    if (!emailData) {
      console.error('[InboundRoutes] No email data in event');
      return res.status(400).json({ error: 'No email data in event' });
    }

    // Resend webhooks don't include email body - fetch it via API
    let emailText = emailData.text || '';
    let emailHtml = emailData.html || '';

    if (!emailText && !emailHtml && emailData.email_id) {
      try {
        console.log(`[InboundRoutes] Fetching email content for: ${emailData.email_id}`);
        const resendResponse = await fetch(`https://api.resend.com/emails/receiving/${emailData.email_id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          },
        });

        if (resendResponse.ok) {
          const fullEmail = await resendResponse.json() as { text?: string; html?: string; to?: string[]; cc?: string[]; headers?: Record<string, string> };
          emailText = fullEmail.text || '';
          emailHtml = fullEmail.html || '';

          // Log the full email data to see what's available
          console.log('[InboundRoutes] Full email data keys:', Object.keys(fullEmail));
          console.log('[InboundRoutes] Full email TO:', JSON.stringify(fullEmail.to));
          console.log('[InboundRoutes] Full email CC:', JSON.stringify(fullEmail.cc));
          console.log('[InboundRoutes] Full email headers:', JSON.stringify(fullEmail.headers));
          console.log(`[InboundRoutes] Fetched email content - text: ${emailText.length} chars, html: ${emailHtml.length} chars`);
        } else {
          console.error(`[InboundRoutes] Failed to fetch email content: ${resendResponse.status}`);
        }
      } catch (err: any) {
        console.error(`[InboundRoutes] Error fetching email content:`, err.message);
      }
    }

    // Build the email object for processing
    const email = {
      from: emailData.from || emailData.envelope?.from || '',
      to: Array.isArray(emailData.to) ? emailData.to.join(', ') : (emailData.to || emailData.envelope?.to?.[0] || ''),
      cc: Array.isArray(emailData.cc) ? emailData.cc.join(', ') : (emailData.cc || ''),
      subject: emailData.subject || '',
      text: emailText,
      html: emailHtml,
      headers: extractHeaders(emailData.headers),
      attachments: emailData.attachments?.map((att: any) => ({
        filename: att.filename || att.name || 'attachment',
        content: att.content || '',
        contentType: att.contentType || att.content_type || 'application/octet-stream',
      })) || [],
    };

    console.log(`[InboundRoutes] Processing email from: ${email.from} to: ${email.to} subject: ${email.subject}`);
    console.log('[InboundRoutes] Email headers:', JSON.stringify(email.headers, null, 2));

    // Process the inbound email
    const result = await inboundService.processInboundEmail(email);

    if (result.success) {
      console.log(`[InboundRoutes] Successfully processed email -> ticket: ${result.ticketId} (new: ${result.isNew})`);
      res.status(200).json({
        received: true,
        processed: true,
        ticketId: result.ticketId,
        isNew: result.isNew,
      });
    } else {
      console.error(`[InboundRoutes] Failed to process email: ${result.error}`);
      // Return 200 to acknowledge receipt even if processing failed
      // This prevents Resend from retrying
      res.status(200).json({
        received: true,
        processed: false,
        error: result.error,
      });
    }
  } catch (error: any) {
    console.error('[InboundRoutes] Webhook processing error:', error);
    // Return 200 to acknowledge receipt
    res.status(200).json({
      received: true,
      processed: false,
      error: error.message,
    });
  }
});

/**
 * Extract headers from Resend's header format
 * Headers can come as an array of objects or as a plain object
 */
function extractHeaders(headers: any): Record<string, string> {
  if (!headers) return {};

  // If headers is already a plain object
  if (!Array.isArray(headers)) {
    return headers;
  }

  // Convert array format to object
  const result: Record<string, string> = {};
  for (const header of headers) {
    if (header.name && header.value) {
      result[header.name.toLowerCase()] = header.value;
    }
  }
  return result;
}

/**
 * GET /api/inbound/health
 * Health check endpoint for the inbound service
 */
router.get('/health', async (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'inbound-email',
    receivingEnabled: !!process.env.RESEND_INBOUND_WEBHOOK_SECRET,
  });
});

export default router;
