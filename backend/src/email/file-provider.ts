import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailMessage, MailProvider, MailSendResult } from './provider.js';

/**
 * Development delivery: each email is written to a folder as an `.html` file
 * and a `.txt` file instead of being sent, so its links can be clicked without
 * an email account (`MAIL_OUTPUT_DIR`, default `.mail/`, git-ignored because the
 * files hold live access links). Never used when `RESEND_API_KEY` or `BREVO_API_KEY` is set, and
 * refused in production by `env.ts`.
 */
export class FileMailProvider implements MailProvider {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    await mkdir(this.#directory, { recursive: true });
    // Named by time and key, so a retry of one row overwrites rather than piles up.
    const id = createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 12);
    const base = join(this.#directory, `${new Date().toISOString().slice(0, 10)}-${id}`);
    const header = `To: ${message.to}\nSubject: ${message.subject}\n\n`;
    await writeFile(`${base}.html`, `<!-- ${commentSafe(header)}-->\n${message.html}`, 'utf8');
    await writeFile(`${base}.txt`, `${header}${message.text}`, 'utf8');
    return { providerMessageId: `file:${id}` };
  }
}

/**
 * Text that cannot end the HTML comment it sits in. A comment closes at `--`
 * followed by `>` or `!>`, so every run of two or more hyphens is spaced out --
 * `--->` in a visitor's name becomes `- - ->` -- while a single hyphen, as in a
 * booking reference, stays as it is.
 */
function commentSafe(value: string): string {
  return value.replace(/-{2,}/g, (run) => run.split('').join(' '));
}
