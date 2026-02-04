/**
 * Base HTML email layout - responsive, professional, mobile-friendly
 */

export interface BaseLayoutOptions {
  title: string;
  preheader?: string;
  content: string;
  footerText?: string;
  companyName?: string;
  companyLogo?: string;
  primaryColor?: string;
  accentColor?: string;
}

export function baseHtmlLayout(options: BaseLayoutOptions): string {
  const {
    title,
    preheader = '',
    content,
    footerText = 'This email was sent by {{companyName}}',
    companyName = 'Skyrack PSA',
    companyLogo = '',
    primaryColor = '#2563eb',
    accentColor = '#1e40af',
  } = options;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset styles */
    body, table, td, p, a, li, blockquote {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    table, td {
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }
    img {
      -ms-interpolation-mode: bicubic;
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
    }
    body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      background-color: #f4f4f5;
    }

    /* Main styles */
    .email-wrapper {
      width: 100%;
      background-color: #f4f4f5;
      padding: 40px 0;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }
    .email-header {
      background-color: ${primaryColor};
      padding: 24px 40px;
      text-align: center;
    }
    .email-header img {
      max-height: 40px;
      width: auto;
    }
    .email-header h1 {
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 20px;
      font-weight: 600;
      margin: 0;
    }
    .email-body {
      padding: 40px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      color: #374151;
    }
    .email-body h2 {
      color: #111827;
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 16px 0;
    }
    .email-body p {
      margin: 0 0 16px 0;
    }
    .email-body a {
      color: ${primaryColor};
    }

    /* Button styles */
    .button-wrapper {
      text-align: center;
      margin: 24px 0;
    }
    .button {
      display: inline-block;
      background-color: ${primaryColor};
      color: #ffffff !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 6px;
      transition: background-color 0.2s;
    }
    .button:hover {
      background-color: ${accentColor};
    }
    .button-secondary {
      background-color: #6b7280;
    }
    .button-secondary:hover {
      background-color: #4b5563;
    }

    /* Info box styles */
    .info-box {
      background-color: #f3f4f6;
      border-radius: 6px;
      padding: 20px;
      margin: 20px 0;
    }
    .info-box-blue {
      background-color: #eff6ff;
      border-left: 4px solid ${primaryColor};
    }
    .info-box-yellow {
      background-color: #fefce8;
      border-left: 4px solid #eab308;
    }
    .info-box-green {
      background-color: #f0fdf4;
      border-left: 4px solid #22c55e;
    }
    .info-row {
      display: flex;
      margin-bottom: 8px;
    }
    .info-label {
      font-weight: 600;
      color: #6b7280;
      width: 120px;
      min-width: 120px;
    }
    .info-value {
      color: #111827;
    }

    /* Table styles for ticket info */
    .info-table {
      width: 100%;
      border-collapse: collapse;
    }
    .info-table td {
      padding: 8px 0;
      vertical-align: top;
    }
    .info-table .label {
      font-weight: 600;
      color: #6b7280;
      width: 120px;
    }
    .info-table .value {
      color: #111827;
    }

    /* Priority/Status badges */
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-low { background-color: #dbeafe; color: #1e40af; }
    .badge-medium { background-color: #fef3c7; color: #92400e; }
    .badge-high { background-color: #fee2e2; color: #991b1b; }
    .badge-critical { background-color: #991b1b; color: #ffffff; }
    .badge-open { background-color: #dbeafe; color: #1e40af; }
    .badge-in-progress { background-color: #fef3c7; color: #92400e; }
    .badge-resolved { background-color: #d1fae5; color: #065f46; }
    .badge-closed { background-color: #e5e7eb; color: #374151; }

    /* Footer */
    .email-footer {
      padding: 24px 40px;
      background-color: #f9fafb;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      color: #6b7280;
    }
    .email-footer a {
      color: #6b7280;
      text-decoration: underline;
    }

    /* Preheader (hidden preview text) */
    .preheader {
      display: none !important;
      visibility: hidden;
      opacity: 0;
      color: transparent;
      height: 0;
      width: 0;
      max-height: 0;
      max-width: 0;
      overflow: hidden;
      mso-hide: all;
    }

    /* Responsive */
    @media only screen and (max-width: 620px) {
      .email-container {
        width: 100% !important;
        border-radius: 0 !important;
      }
      .email-header, .email-body, .email-footer {
        padding-left: 24px !important;
        padding-right: 24px !important;
      }
      .button {
        display: block !important;
        width: 100% !important;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <!-- Preheader text (shows in email preview) -->
  <div class="preheader">${preheader}</div>

  <div class="email-wrapper">
    <div class="email-container">
      <!-- Header -->
      <div class="email-header">
        ${companyLogo ? `<img src="${companyLogo}" alt="${companyName}">` : `<h1>${companyName}</h1>`}
      </div>

      <!-- Body -->
      <div class="email-body">
        ${content}
      </div>

      <!-- Footer -->
      <div class="email-footer">
        <p>${footerText}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Helper to create a CTA button
 */
export function ctaButton(text: string, url: string, secondary = false): string {
  return `<div class="button-wrapper">
  <a href="${url}" class="button${secondary ? ' button-secondary' : ''}">${text}</a>
</div>`;
}

/**
 * Helper to create an info box
 */
export function infoBox(content: string, variant: 'default' | 'blue' | 'yellow' | 'green' = 'default'): string {
  const variantClass = variant === 'default' ? '' : ` info-box-${variant}`;
  return `<div class="info-box${variantClass}">${content}</div>`;
}

/**
 * Helper to create a ticket info table
 */
export function ticketInfoTable(rows: { label: string; value: string }[]): string {
  const rowsHtml = rows
    .map(row => `<tr><td class="label">${row.label}</td><td class="value">${row.value}</td></tr>`)
    .join('\n');
  return `<table class="info-table">${rowsHtml}</table>`;
}

/**
 * Helper to create a priority/status badge
 */
export function badge(text: string, type: string): string {
  const normalizedType = type.toLowerCase().replace(/\s+/g, '-');
  return `<span class="badge badge-${normalizedType}">${text}</span>`;
}
