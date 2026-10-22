import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import en from '../i18n/locales/en.json' with { type: 'json' };
import { EMAIL_TEMPLATES, OUTBOX_KINDS, RESERVED_EMAIL_TEMPLATES, SENDABLE_EMAIL_TEMPLATES } from '../outbox/enqueue.js';
import { connect, firstRow } from '../test/database.js';
import { TEMPLATES } from './render.js';

/**
 * Every `template` value the outbox CHECK allows is either sendable, with a
 * template file, or reserved for a later phase, with none yet; and every
 * template file is a value the CHECK allows (plan.md Task 15,
 * marketplace-data-model.md §2.14 and §5). Five lists must agree: the CHECK,
 * `EMAIL_TEMPLATES`, its split into `SENDABLE_EMAIL_TEMPLATES` and
 * `RESERVED_EMAIL_TEMPLATES`, the `TEMPLATES` registry and the files in
 * `templates/`. Read-only against the database; nothing is truncated.
 */

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

let db: pg.Client;

beforeAll(async () => {
  db = connect();
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

async function checkValues(constraint: string): Promise<string[]> {
  const result = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = 'outbox'::regclass`,
    [constraint],
  );
  const values = [...firstRow(result).def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '');
  expect(values.length).toBeGreaterThan(0);
  return values.sort();
}

function templateFiles(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith('.ts') && name !== 'shared.ts' && !name.endsWith('.test.ts'))
    .sort();
}

const kebabToSnake = (file: string) => file.replace(/\.ts$/, '').replaceAll('-', '_');
const snakeToKebab = (template: string) => `${template.replaceAll('_', '-')}.ts`;

describe('outbox_template_allowed and the templates', () => {
  it('the CHECK allows exactly EMAIL_TEMPLATES', async () => {
    expect(await checkValues('outbox_template_allowed')).toEqual([...EMAIL_TEMPLATES].sort());
  });

  it('every CHECK value but the reserved ones has a template file, and no reserved one has', async () => {
    const files = new Set(templateFiles());
    const reserved = new Set<string>(RESERVED_EMAIL_TEMPLATES);
    for (const template of await checkValues('outbox_template_allowed')) {
      expect(files.has(snakeToKebab(template)), `${template}: file present while reserved, or missing while sendable`).toBe(!reserved.has(template));
    }
  });

  it('every template file is a CHECK value', async () => {
    const allowed = new Set(await checkValues('outbox_template_allowed'));
    for (const file of templateFiles()) {
      expect(allowed.has(kebabToSnake(file)), `${file} is not in the CHECK`).toBe(true);
    }
  });

  it('the registry holds exactly the sendable CHECK values', async () => {
    const reserved = new Set<string>(RESERVED_EMAIL_TEMPLATES);
    const sendable = (await checkValues('outbox_template_allowed')).filter((template) => !reserved.has(template));
    expect(Object.keys(TEMPLATES).sort()).toEqual(sendable);
    expect([...SENDABLE_EMAIL_TEMPLATES].sort()).toEqual(sendable);
  });

  it('each registry entry is the definition its own file exports', async () => {
    for (const file of templateFiles()) {
      const module = (await import(pathToFileURL(join(TEMPLATES_DIR, file)).href)) as Record<string, unknown>;
      const template = kebabToSnake(file) as keyof typeof TEMPLATES;
      expect(Object.values(module), `${file} does not export TEMPLATES.${template}`).toContain(TEMPLATES[template]);
    }
  });

  it('there are twenty-four files: the thirteen before the marketplace, with admin_alert split in two, the three account emails, the three moderation emails, payout_sent and the three subscription emails', () => {
    // 13 - admin_alert + photographer_alert + platform_alert + account_password_reset + account_security_alert;
    // admin_new_booking is renamed photographer_new_booking. Phase 2 makes
    // photographer_approved and photographer_suspended sendable (decision 7),
    // then account_verify_email (decision 3) and photographer_application_received (decision 4).
    // Phase 4 makes payout_sent sendable (R4.4); Phase 5 subscription_reminder,
    // subscription_receipt and subscription_expired (R5.3, R5.4): the CHECK's whole vocabulary.
    expect(templateFiles()).toHaveLength(24);
    expect(EMAIL_TEMPLATES).toHaveLength(24);
    expect(RESERVED_EMAIL_TEMPLATES).toHaveLength(0);
  });

  it('no longer has an admin_alert or admin_new_booking, in the CHECK or on disk', async () => {
    const allowed = await checkValues('outbox_template_allowed');
    for (const retired of ['admin_alert', 'admin_new_booking']) {
      expect(allowed).not.toContain(retired);
      expect(templateFiles()).not.toContain(snakeToKebab(retired));
    }
  });
});

describe('outbox_kind_allowed', () => {
  it('allows exactly OUTBOX_KINDS', async () => {
    expect(await checkValues('outbox_kind_allowed')).toEqual([...OUTBOX_KINDS].sort());
  });

  it.each([
    ['photographer_alert', en.email.adminAlert.retriesExhausted.messages],
    ['platform_alert', en.email.platformAlert.retriesExhausted.messages],
  ])('every template and every kind has retries_exhausted copy in the %s', (_alert, copy) => {
    const messages = Object.keys(copy);
    // `email` itself too: an email row with no template still fails, and its alert
    // must name the message in words, never as a translation key. Reserved names
    // included: a row a later phase wrote must still be named if it fails.
    for (const name of [...EMAIL_TEMPLATES, ...OUTBOX_KINDS]) expect(messages, name).toContain(name);
  });

  it('the platform copy names only what the CHECK allows: it has no retired lines', () => {
    expect(Object.keys(en.email.platformAlert.retriesExhausted.messages).sort()).toEqual([...EMAIL_TEMPLATES, ...OUTBOX_KINDS].sort());
  });
});
