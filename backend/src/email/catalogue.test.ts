import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import en from '../i18n/locales/en.json' with { type: 'json' };
import { EMAIL_TEMPLATES, OUTBOX_KINDS } from '../outbox/enqueue.js';
import { connect, firstRow } from '../test/database.js';
import { TEMPLATES } from './render.js';

/**
 * Every `template` value the outbox CHECK allows has a template file, and every
 * template file is a value the CHECK allows (plan.md Task 15). Four lists must
 * agree: the CHECK, `EMAIL_TEMPLATES`, the `TEMPLATES` registry and the files in
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

  it('every CHECK value has a template file', async () => {
    const files = new Set(templateFiles());
    for (const template of await checkValues('outbox_template_allowed')) {
      expect(files.has(snakeToKebab(template)), `no file for ${template}`).toBe(true);
    }
  });

  it('every template file is a CHECK value', async () => {
    const allowed = new Set(await checkValues('outbox_template_allowed'));
    for (const file of templateFiles()) {
      expect(allowed.has(kebabToSnake(file)), `${file} is not in the CHECK`).toBe(true);
    }
  });

  it('the registry holds exactly the CHECK values', async () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(await checkValues('outbox_template_allowed'));
  });

  it('each registry entry is the definition its own file exports', async () => {
    for (const file of templateFiles()) {
      const module = (await import(pathToFileURL(join(TEMPLATES_DIR, file)).href)) as Record<string, unknown>;
      const template = kebabToSnake(file) as keyof typeof TEMPLATES;
      expect(Object.values(module), `${file} does not export TEMPLATES.${template}`).toContain(TEMPLATES[template]);
    }
  });

  it('there are thirteen: the nine of spec §4.1 and the four client-access emails (2026-09-25)', () => {
    expect(templateFiles()).toHaveLength(13);
    expect(EMAIL_TEMPLATES).toHaveLength(13);
  });
});

describe('outbox_kind_allowed', () => {
  it('allows exactly OUTBOX_KINDS', async () => {
    expect(await checkValues('outbox_kind_allowed')).toEqual([...OUTBOX_KINDS].sort());
  });

  it('every template and every kind has retries_exhausted copy', () => {
    const messages = Object.keys(en.email.adminAlert.retriesExhausted.messages).sort();
    // `email` itself too: an email row with no template still fails, and its alert
    // must name the message in words, never as a translation key.
    expect(messages).toEqual([...EMAIL_TEMPLATES, ...OUTBOX_KINDS].sort());
  });
});
