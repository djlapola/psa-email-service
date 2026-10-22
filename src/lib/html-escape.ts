/**
 * Escape the five HTML-significant characters so a substituted value cannot break
 * out of text content or an attribute value into markup.
 *
 * `&` MUST be replaced first, otherwise the `&` introduced by the later entities
 * would itself be doubly-escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
