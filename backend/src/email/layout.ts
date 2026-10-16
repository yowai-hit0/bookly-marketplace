/**
 * The one email layout (plan.md Task 15). Templates compose a list of blocks;
 * this turns them into an HTML body and a plain-text body that say the same
 * thing.
 *
 * Escaping lives here and nowhere else. Names, locations and special requests
 * are typed by visitors, and the translation layer does not escape
 * (`escapeValue: false`), so every string is escaped as it enters the HTML --
 * a template never writes markup itself.
 */

export type Block =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  /** Label/value pairs: a reference, a date, an amount. */
  | { type: 'details'; rows: readonly { label: string; value: string }[] }
  /** The one action the email is for. */
  | { type: 'button'; label: string; href: string }
  /** Something the reader must not miss, like the non-refundable booking fee. */
  | { type: 'note'; text: string };

export type ComposedEmail = {
  subject: string;
  /** The inbox preview line. */
  preheader: string;
  blocks: readonly Block[];
};

export type RenderedEmail = { subject: string; html: string; text: string };

export type LayoutCopy = {
  appName: string;
  footer: string;
  /** Shown under a button, followed by its URL. */
  linkFallback: string;
};

const INK = '#18181b';
const MUTED = '#71717a';
const RULE = '#e4e4e7';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function renderLayout(email: ComposedEmail, copy: LayoutCopy): RenderedEmail {
  return {
    // A header value: a line break in a visitor's name must not start a new header.
    subject: singleLine(email.subject),
    html: renderHtml(email, copy),
    text: renderText(email, copy),
  };
}

function renderHtml(email: ComposedEmail, copy: LayoutCopy): string {
  const body = email.blocks.map((block) => htmlBlock(block, copy)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(singleLine(email.subject))}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(email.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:${FONT};color:${INK};">
<tr><td style="padding:24px 28px 0;font-size:14px;font-weight:600;letter-spacing:0.04em;color:${MUTED};">${escapeHtml(copy.appName)}</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.55;">
${body}
</td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(copy.footer)}</p>
</td></tr>
</table>
</body>
</html>`;
}

function htmlBlock(block: Block, copy: LayoutCopy): string {
  switch (block.type) {
    case 'heading':
      return `<h1 style="margin:12px 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(block.text)}</h1>`;
    case 'paragraph':
      return `<p style="margin:0 0 14px;">${multiline(block.text)}</p>`;
    case 'note':
      return `<p style="margin:0 0 14px;padding:10px 12px;border-left:3px solid ${INK};background:#fafafa;font-weight:600;">${multiline(block.text)}</p>`;
    case 'details':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;border-top:1px solid ${RULE};">
${block.rows
  .map(
    (row) =>
      `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid ${RULE};color:${MUTED};vertical-align:top;white-space:nowrap;">${escapeHtml(row.label)}</td><td style="padding:8px 0;border-bottom:1px solid ${RULE};text-align:right;vertical-align:top;">${multiline(row.value)}</td></tr>`,
  )
  .join('\n')}
</table>`;
    case 'button':
      return `<p style="margin:20px 0 8px;"><a href="${escapeHtml(block.href)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${INK};color:#ffffff;font-weight:600;text-decoration:none;">${escapeHtml(block.label)}</a></p>
<p style="margin:0 0 16px;font-size:12px;color:${MUTED};word-break:break-all;">${escapeHtml(copy.linkFallback)} <a href="${escapeHtml(block.href)}" style="color:${MUTED};">${escapeHtml(block.href)}</a></p>`;
  }
}

function renderText(email: ComposedEmail, copy: LayoutCopy): string {
  const lines: string[] = [];
  for (const block of email.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(block.text, '');
        break;
      case 'paragraph':
        lines.push(block.text, '');
        break;
      case 'note':
        lines.push(`** ${block.text} **`, '');
        break;
      case 'details':
        for (const row of block.rows) lines.push(`${row.label}: ${row.value}`);
        lines.push('');
        break;
      case 'button':
        lines.push(`${block.label}:`, block.href, '');
        break;
    }
  }
  lines.push('--', copy.footer);
  return lines.join('\n');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escaped, with the visitor's own line breaks kept (special requests). */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** Every line terminator, not only CR and LF: NEL and the Unicode line and paragraph separators too. */
function singleLine(value: string): string {
  return value.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
}
