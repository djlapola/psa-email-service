import { escapeHtml } from './html-escape';

export type RenderMode = 'html' | 'subject' | 'text';

/**
 * Variable names whose substituted value is inserted into the HTML body WITHOUT
 * HTML-escaping.
 *
 * This set is EMPTY by design. Callers control the `data` map, so any name added
 * here is a stored-XSS / HTML-injection hole unless that value is proven to be
 * built exclusively from already-escaped parts at EVERY call site. A name may only
 * be added after that proof — never "to make a template render some HTML".
 */
export const TRUSTED_HTML_VARS: ReadonlySet<string> = new Set<string>([]);

/**
 * Pure, single-pass renderer for the `{{var}}` + `{{#if var}}...{{/if}}` mini-language.
 *
 * Single-pass semantics are load-bearing for safety: the `{{#if}}` pass runs first
 * over the template text, then the `{{var}}` pass runs over the result. A value that
 * a `{{var}}` substitution produces is the REPLACEMENT returned by String.replace and
 * is never re-scanned, so a value that happens to contain `{{y}}` (or `{{#if}}`) is
 * emitted literally and cannot be re-expanded.
 *
 * Per-mode handling of a substituted value `v = String(value)`:
 *   - html:    escapeHtml(v), unless varName is in TRUSTED_HTML_VARS (currently none).
 *   - subject: v with every CR/LF run collapsed to a single space (header hardening).
 *   - text:    v raw.
 *
 * Missing/empty values:
 *   - unknown var (undefined): keep the literal `{{var}}` (unchanged legacy behaviour).
 *   - null: render the empty string (behaviour change — previously a null printed the
 *     literal `{{var}}` into customer email).
 */
export function renderTemplateString(
  template: string,
  data: Record<string, unknown>,
  mode: RenderMode,
): string {
  let result = template;

  // Handle {{#if variable}}content{{/if}} blocks — identical to the original interpolate().
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (match, varName, content) => {
      const value = data[varName];
      if (value !== undefined && value !== null && value !== '' && value !== false && value !== 0) {
        return content;
      }
      return '';
    },
  );

  // Handle simple {{variable}} replacements.
  result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = data[varName];
    if (value === undefined) {
      return match; // unknown var: keep the literal {{var}}, as today
    }
    if (value === null) {
      return ''; // null now renders empty instead of printing the literal {{var}}
    }
    const v = String(value);
    switch (mode) {
      case 'html':
        return TRUSTED_HTML_VARS.has(varName) ? v : escapeHtml(v);
      case 'subject':
        return v.replace(/[\r\n]+/g, ' ');
      case 'text':
        return v;
    }
  });

  return result;
}
