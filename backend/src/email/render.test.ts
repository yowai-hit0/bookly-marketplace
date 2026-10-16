import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import en from '../i18n/locales/en.json' with { type: 'json' };
import { EMAIL_TEMPLATES, OUTBOX_KINDS } from '../outbox/enqueue.js';
import {
  ADMIN_ALERT_VARIANTS,
  EMAIL_FIXTURES,
  type EmailFixture,
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_CONFIRM_TOKEN,
  FIXTURE_REFERENCE,
  FIXTURE_RESET_TOKEN,
  FIXTURE_SECOND_ACCESS_TOKEN,
  FIXTURE_SECOND_REFERENCE,
  FIXTURE_WEB_ORIGIN,
  emailFixture,
} from '../test/email-fixtures.js';
import { escapeHtml } from './layout.js';
import { TEMPLATES, renderEmail } from './render.js';
import { adminAlert } from './templates/admin-alert.js';
import { paymentReceipt } from './templates/payment-receipt.js';
import { reschedule } from './templates/reschedule.js';
import { EmailPayloadError } from './templates/shared.js';

/**
 * Rendering (plan.md Task 15, spec §4.1): all nine templates and every
 * admin_alert variant from fixtures, snapshot-tested, with Kigali times and
 * integer RWF read against the same docs/fixtures/format.json the frontend
 * asserts. No database: rendering is a pure function of template and payload.
 */

const formatFixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/fixtures/format.json'), 'utf8'),
) as {
  formatDateTime: { case: string; input: string; expected: string }[];
  formatTime: { case: string; input: string; expected: string }[];
  formatDate: { case: string; input: string; expected: string }[];
  formatMoney: { case: string; input: number; expected: string }[];
  formatMoneyRejects: { case: string; input: number }[];
};

type Payload = Record<string, unknown>;

function render(template: string, payload: unknown, locale?: string | null) {
  return renderEmail(template, payload, { webOrigin: FIXTURE_WEB_ORIGIN, locale });
}

function renderFixture(fixture: EmailFixture) {
  return render(fixture.template, fixture.payload);
}

function withPayload(name: string, changes: Payload): { template: string; payload: Payload } {
  const fixture = emailFixture(name);
  return { template: fixture.template, payload: { ...(fixture.payload as Payload), ...changes } };
}

function renderWith(name: string, changes: Payload) {
  const { template, payload } = withPayload(name, changes);
  return render(template, payload);
}

function payloadError(run: () => unknown): EmailPayloadError {
  try {
    run();
  } catch (error) {
    if (error instanceof EmailPayloadError) return error;
    throw new Error(`Expected EmailPayloadError, got ${String(error)}`);
  }
  throw new Error('Expected EmailPayloadError, nothing was thrown');
}

/** The Kigali calendar date of an instant, computed independently of the code under test. */
function kigaliDate(instant: string): string {
  return new Date(Date.parse(instant) + 2 * 60 * 60_000).toISOString().slice(0, 10);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));
}

function urlsIn(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0].replaceAll('&amp;', '&'));
}

// --- Every template ------------------------------------------------------------

describe('the fixtures', () => {
  it('cover every template and every admin_alert variant', () => {
    expect([...new Set(EMAIL_FIXTURES.map((fixture) => fixture.template))].sort()).toEqual([...EMAIL_TEMPLATES].sort());

    const variants = EMAIL_FIXTURES.filter((fixture) => fixture.template === 'admin_alert').map(
      (fixture) => (fixture.payload as Payload).variant,
    );
    expect([...variants].sort()).toEqual([...ADMIN_ALERT_VARIANTS].sort());

    // And the template accepts no variant the fixtures do not cover.
    const union = adminAlert.payload as unknown as { options: { shape: { variant: { value: string } } }[] };
    expect(union.options.map((option) => option.shape.variant.value).sort()).toEqual([...ADMIN_ALERT_VARIANTS].sort());
  });

  it('includes the four admin_alert situations the plan names: payment received, retries exhausted, login lockout, refund due', () => {
    for (const variant of ['payment_received', 'retries_exhausted', 'login_lockout', 'refund_due']) {
      expect(ADMIN_ALERT_VARIANTS).toContain(variant);
    }
  });
});

describe.each(EMAIL_FIXTURES.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
  it('renders without error to a subject, an HTML body and a text body', () => {
    const email = renderFixture(fixture);

    expect(email.subject.length).toBeGreaterThan(5);
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html.startsWith('<!doctype html>')).toBe(true);
    expect(email.html).toContain(`<title>${escapeHtml(email.subject)}</title>`);
    expect(email.text.length).toBeGreaterThan(20);
    expect(email.text).toContain('Bookly, Kigali. All times are Kigali time (UTC+2).');
  });

  it('leaves no placeholder, missing translation key or undefined value behind', () => {
    const email = renderFixture(fixture);
    const sections = Object.keys(en.email);

    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]|\b(email|common):[a-z]/);
      for (const section of sections) expect(part).not.toContain(`${section}.`);
    }
  });

  it('matches its snapshot', () => {
    const email = renderFixture(fixture);

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });
});

// --- Kigali time and integer RWF ----------------------------------------------------

describe('times in Africa/Kigali and integer RWF, against docs/fixtures/format.json', () => {
  it.each(formatFixture.formatDateTime)('shows a payment instant as the fixture does: $case', ({ input, expected }) => {
    const receipt = renderWith('payment_receipt', { paidAt: input });
    expect(receipt.text).toContain(`Paid on: ${expected} (Kigali time)`);
    expect(receipt.html).toContain(`${expected} (Kigali time)`);

    const alert = renderWith('admin_alert payment_received', { paidAt: input });
    expect(alert.text).toContain(`Paid on: ${expected} (Kigali time)`);

    const lockout = renderWith('admin_alert login_lockout', { lockedUntil: input });
    expect(lockout.text).toContain(`locked until ${expected} (Kigali time)`);

    const reset = renderWith('admin_alert password_reset', { expiresAt: input });
    expect(reset.text).toContain(`until ${expected} (Kigali time)`);
  });

  it.each(formatFixture.formatTime)('shows a shoot time as the fixture does: $case', ({ input, expected }) => {
    const endsAt = new Date(Date.parse(input) + 60 * 60_000).toISOString();

    const email = renderWith('booking_confirmation', { startsAt: input, endsAt });

    expect(email.text).toMatch(new RegExp(`When: [A-Za-z]+, \\d{1,2} [A-Za-z]+ \\d{4}, ${expected} to \\d{2}:\\d{2} \\(Kigali time\\)`));
  });

  it('dates a shoot by its Kigali calendar day, as formatDate in the fixture does', () => {
    let matched = 0;
    for (const { input } of formatFixture.formatTime) {
      const dateCase = formatFixture.formatDate.find((c) => c.input === kigaliDate(input));
      if (dateCase === undefined) continue;
      matched += 1;
      const endsAt = new Date(Date.parse(input) + 60 * 60_000).toISOString();

      const email = renderWith('booking_confirmation', { startsAt: input, endsAt });

      expect(email.subject).toContain(dateCase.expected);
      expect(email.text).toContain(`When: ${dateCase.expected}, `);
    }
    expect(matched).toBeGreaterThanOrEqual(2);
  });

  it('rolls the date and year forward when UTC is still on the day before', () => {
    // 22:00Z on 31 December is 00:00 on 1 January in Kigali (format.json).
    const email = renderWith('booking_confirmation', { startsAt: '2026-12-31T22:00:00Z', endsAt: '2026-12-31T23:00:00Z' });

    expect(email.subject).toContain('Friday, 1 January 2027');
    expect(email.text).toContain('Friday, 1 January 2027, 00:00 to 01:00 (Kigali time)');
    expect(email.text).not.toContain('2026');

    const calendar = renderWith('admin_new_booking', { startsAt: '2026-12-31T22:00:00Z', endsAt: '2026-12-31T23:00:00Z' });
    expect(hrefs(calendar.html)).toContain(`${FIXTURE_WEB_ORIGIN}/admin/calendar?view=day&date=2027-01-01`);
  });

  it.each(formatFixture.formatDate)('states a delivery expiry as the fixture does: $case', ({ input, expected }) => {
    const email = renderWith('photo_delivery', { expiresOn: input });

    expect(email.text).toContain(`until the end of ${expected} (Kigali time)`);
    expect(email.html).toContain(escapeHtml(`Download your photos by ${expected}.`));
  });

  it.each(formatFixture.formatMoney)('shows an amount as the fixture does: $case', ({ input, expected }) => {
    const confirmation = renderWith('booking_confirmation', { paidRwf: input, outstandingRwf: input });
    expect(confirmation.text).toContain(`Paid: ${expected}`);
    expect(confirmation.text).toContain(`Still to pay: ${expected}`);

    const request = renderWith('session_fee_request', { amountRwf: input });
    expect(request.text).toContain(`Amount due: ${expected}`);

    const newBooking = renderWith('admin_new_booking', { totalRwf: input, addons: [{ name: 'Prints', priceRwf: input }] });
    expect(newBooking.text).toContain(`Total: ${expected}`);
    expect(newBooking.text).toContain(`Prints: ${expected}`);

    const refund = renderWith('admin_alert refund_due', { amountRwf: input });
    expect(refund.subject).toContain(`Refund due: ${expected}`);
  });

  it.each(formatFixture.formatMoneyRejects)('refuses an amount the fixture refuses: $case', ({ input }) => {
    for (const [name, field] of [
      ['booking_confirmation', 'paidRwf'],
      ['session_fee_request', 'amountRwf'],
      ['payment_receipt', 'outstandingRwf'],
      ['cancellation (by admin)', 'refundRwf'],
      ['admin_alert refund_due', 'amountRwf'],
    ] as const) {
      const { template, payload } = withPayload(name, { [field]: input });
      expect(payloadError(() => render(template, payload)).message).toContain(field);
    }
  });

  it('renders identically whatever the process time zone', async () => {
    const baseline = EMAIL_FIXTURES.map((fixture) => renderFixture(fixture));
    const originalTz = process.env.TZ;
    const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const originalOffset = new Date('2026-01-01T12:00:00Z').getTimezoneOffset();
    try {
      for (const [zone, offset] of [
        ['Pacific/Kiritimati', -840],
        ['America/Los_Angeles', 480],
        ['UTC', 0],
      ] as const) {
        process.env.TZ = zone;
        // The switch really happened, or this test would prove nothing.
        expect(new Date('2026-01-01T12:00:00Z').getTimezoneOffset()).toBe(offset);
        vi.resetModules();
        const fresh = await import('./render.js');
        const again = EMAIL_FIXTURES.map((fixture) =>
          fresh.renderEmail(fixture.template, fixture.payload, { webOrigin: FIXTURE_WEB_ORIGIN }),
        );
        expect(again).toEqual(baseline);
      }
    } finally {
      // Deleting TZ does not make Node re-read the system zone, so set it back first.
      process.env.TZ = originalTz ?? originalZone;
      if (originalTz === undefined) delete process.env.TZ;
      vi.resetModules();
    }
    expect(new Date('2026-01-01T12:00:00Z').getTimezoneOffset()).toBe(originalOffset);
  });
});

// --- booking_confirmation -----------------------------------------------------------

describe('booking_confirmation', () => {
  const link = `${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`;

  it('contains the reference, date and time, location, amount paid, amount outstanding and the access link', () => {
    const email = renderFixture(emailFixture('booking_confirmation'));

    for (const body of [email.text, email.html]) {
      expect(body).toContain(FIXTURE_REFERENCE);
      expect(body).toContain('Wednesday, 7 October 2026, 09:30 to 10:30 (Kigali time)');
      expect(body).toContain('Kigali Heights, KG 7 Ave');
      expect(body).toContain('18,000 RWF');
      expect(body).toContain('27,000 RWF');
      expect(body).toContain(link);
    }
    expect(email.text).toContain('Paid: 18,000 RWF');
    expect(email.text).toContain('Still to pay: 27,000 RWF');
    expect(hrefs(email.html)).toContain(link);
    expect(email.subject).toContain(FIXTURE_REFERENCE);
  });

  it('puts the token in the path of a link on the site, never in a query string', () => {
    const email = renderFixture(emailFixture('booking_confirmation'));
    const url = new URL(hrefs(email.html).find((href) => href.includes(FIXTURE_ACCESS_TOKEN)) ?? '');

    expect(url.origin).toBe(FIXTURE_WEB_ORIGIN);
    expect(url.pathname).toBe(`/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it.each(
    EMAIL_FIXTURES.filter((fixture) => 'accessToken' in fixture.payload).map((fixture) => [fixture.name, fixture] as const),
  )('%s carries the raw token nowhere except inside the booking link', (_name, fixture) => {
    const email = renderFixture(fixture);

    expect(email.subject).not.toContain(FIXTURE_ACCESS_TOKEN);
    for (const body of [email.html, email.text]) {
      expect(body).toContain(link);
      expect(body.replaceAll(link, '<link>')).not.toContain(FIXTURE_ACCESS_TOKEN);
    }
    // Every URL that carries it is exactly that link.
    for (const url of [...urlsIn(email.text), ...hrefs(email.html)].filter((u) => u.includes(FIXTURE_ACCESS_TOKEN))) {
      expect(url).toBe(link);
    }
  });

  it('password_reset carries its token only inside the reset link', () => {
    const email = renderFixture(emailFixture('admin_alert password_reset'));
    const resetUrl = `${FIXTURE_WEB_ORIGIN}/admin/reset-password#token=${FIXTURE_RESET_TOKEN}`;

    expect(email.subject).not.toContain(FIXTURE_RESET_TOKEN);
    expect(hrefs(email.html)).toContain(resetUrl);
    for (const body of [email.html, email.text]) {
      expect(body).toContain(resetUrl);
      expect(body.replaceAll(resetUrl, '<link>')).not.toContain(FIXTURE_RESET_TOKEN);
    }
  });
});

// --- Links -----------------------------------------------------------------------------

describe('links point at WEB_ORIGIN, never at the API host', () => {
  it.each(EMAIL_FIXTURES.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const email = renderFixture(fixture);
    const links = [...hrefs(email.html), ...urlsIn(email.html), ...urlsIn(email.text)];
    const delivery = fixture.template === 'photo_delivery' ? String((fixture.payload as Payload).deliveryUrl) : null;

    for (const url of links) {
      expect(url).not.toMatch(/:4000|\/api(\/|$)|localhost/);
      if (url === delivery) continue;
      expect(url.startsWith(`${FIXTURE_WEB_ORIGIN}/`), url).toBe(true);
    }
  });

  it('gives every email with an action a link, so the check above is not vacuous', () => {
    const withoutLinks = EMAIL_FIXTURES.filter((fixture) => hrefs(renderFixture(fixture).html).length === 0).map(
      (fixture) => fixture.name,
    );
    expect(withoutLinks.sort()).toEqual(
      [
        'admin_alert booking_cancelled',
        'admin_alert retries_exhausted',
        'cancellation (by admin)',
        'cancellation (by client)',
        // To the old address after an email change: it must not get a way into the booking.
        'email_changed_notice',
        // A photographer's note: no token plaintext exists to link with.
        'client_note',
      ].sort(),
    );
  });

  it('follows WEB_ORIGIN in development too, never the API port', () => {
    const webOrigin = 'http://localhost:5173';
    for (const fixture of EMAIL_FIXTURES) {
      const payload =
        fixture.name === 'admin_alert password_reset'
          ? { ...(fixture.payload as Payload), resetUrl: `${webOrigin}/admin/reset-password#token=${FIXTURE_RESET_TOKEN}` }
          : fixture.payload;
      const email = renderEmail(fixture.template, payload, { webOrigin });
      for (const url of [...hrefs(email.html), ...urlsIn(email.text)]) {
        if (fixture.template === 'photo_delivery' && url.startsWith('https://photos.')) continue;
        expect(url.startsWith(`${webOrigin}/`), `${fixture.name}: ${url}`).toBe(true);
      }
    }
  });

  it.each([
    ['the API host', 'http://localhost:4000/api/admin/reset-password#token=abc'],
    ['another site', 'https://evil.example/admin/reset-password#token=abc'],
    ['a look-alike subdomain', 'https://bookly.example.evil.example/admin/reset-password#token=abc'],
    ['userinfo trickery', 'https://bookly.example@evil.example/admin/reset-password#token=abc'],
    ['plain http on the same host', 'http://bookly.example/admin/reset-password#token=abc'],
    ['a javascript: URL', 'javascript:alert(document.cookie)'],
    ['not a URL at all', 'reset-password#token=abc'],
  ])('refuses a password_reset link on %s', (_case, resetUrl) => {
    const { template, payload } = withPayload('admin_alert password_reset', { resetUrl });

    const error = payloadError(() => render(template, payload));
    expect(error.message).not.toContain('abc');
    expect(error.message).not.toContain('evil');
  });
});

// --- Escaping ------------------------------------------------------------------------

describe('escaping', () => {
  const HOSTILE = `<script>alert("x")</script> & <img src=x onerror='y'>`;
  const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=&#39;y&#39;&gt;';

  const fields: [fixture: string, field: string, value: unknown][] = [
    ['booking_confirmation', 'clientName', HOSTILE],
    ['booking_confirmation', 'serviceName', HOSTILE],
    ['booking_confirmation', 'packageName', HOSTILE],
    ['booking_confirmation', 'locationText', HOSTILE],
    ['admin_new_booking', 'clientName', HOSTILE],
    ['admin_new_booking', 'specialRequests', HOSTILE],
    ['admin_new_booking', 'addons', [{ name: HOSTILE, priceRwf: 5000 }]],
    ['session_fee_request', 'clientName', HOSTILE],
    ['payment_receipt', 'paymentReference', HOSTILE],
    ['photo_delivery', 'note', HOSTILE],
    ['photo_delivery', 'clientName', HOSTILE],
    ['cancellation (by admin)', 'reason', HOSTILE],
    ['cancellation (by client)', 'clientName', HOSTILE],
    ['reschedule', 'locationText', HOSTILE],
    ['access_link_resend', 'serviceName', HOSTILE],
    ['booking_links', 'clientName', HOSTILE],
    ['email_change_confirm', 'newEmail', HOSTILE],
    ['email_changed_notice', 'newEmail', HOSTILE],
    ['client_note', 'body', HOSTILE],
    ['admin_alert payment_received', 'clientName', HOSTILE],
    ['admin_alert retries_exhausted', 'lastError', HOSTILE],
    ['admin_alert refund_due', 'paymentReference', HOSTILE],
    ['admin_alert booking_cancelled', 'clientName', HOSTILE],
  ];

  it.each(fields)('%s: %s is escaped in HTML and literal in text', (name, field, value) => {
    const email = renderWith(name, { [field]: value });

    expect(email.html).not.toMatch(/<script|<img/i);
    expect(email.html).toContain(ESCAPED);
    expect(email.text).toContain(HOSTILE);
  });

  it('keeps a visitor’s own line breaks, as <br> in HTML and as newlines in text', () => {
    const email = renderFixture(emailFixture('admin_new_booking'));

    expect(email.html).toContain('Outdoor shots if the weather allows.<br>Please bring a reflector.');
    expect(email.text).toContain('Outdoor shots if the weather allows.\nPlease bring a reflector.');
  });

  it.each([
    ['admin_new_booking', 'clientName'],
    ['booking_confirmation', 'serviceName'],
    ['admin_alert payment_received', 'clientName'],
    ['admin_alert refund_due', 'clientName'],
    ['admin_alert booking_cancelled', 'clientName'],
  ])('%s: CR/LF in %s cannot inject a header through the subject', (name, field) => {
    for (const value of ['Eve\r\nBcc: attacker@evil.example', 'Eve\nBcc: attacker@evil.example', 'Eve\rBcc: attacker@evil.example']) {
      const email = renderWith(name, { [field]: value });

      expect(email.subject).not.toMatch(/[\r\n]/);
      expect(email.subject).toContain('Eve Bcc: attacker@evil.example');
      expect(email.html).not.toMatch(/<title>[^<]*[\r\n]/);
    }
  });

  it.each([
    ['admin_alert booking_cancelled', 'clientName', '{{reference}}'],
    ['admin_alert payment_received', 'clientName', '{{reference}}'],
    ['admin_new_booking', 'clientName', '{{date}}'],
    ['booking_confirmation', 'serviceName', '{{reference}}'],
    ['admin_alert booking_cancelled', 'clientName', '$t(email:common.footer)'],
    ['admin_alert booking_cancelled', 'clientName', '$& $1 $$'],
  ])('%s: interpolation syntax in %s (%s) is shown literally, not interpreted', (name, field, value) => {
    const fixture = emailFixture(name);
    const email = renderWith(name, { [field]: value });
    const baseline = renderFixture(fixture);
    const original = String((fixture.payload as Payload)[field]);

    // Exactly the baseline with the original value swapped for the typed one.
    expect(email.subject).toBe(baseline.subject.replace(original, () => value));
    expect(email.text).toBe(baseline.text.replaceAll(original, () => value));
  });
});

// --- Validation ------------------------------------------------------------------------

describe('payload validation', () => {
  it('names every missing field, and nothing else', () => {
    const { payload } = withPayload('booking_confirmation', {});
    delete payload.accessToken;
    delete payload.locationText;

    const error = payloadError(() => render('booking_confirmation', payload));

    expect(error.message).toBe('The booking_confirmation payload is invalid at: locationText, accessToken');
  });

  it('never repeats an offending value: not a token, an address or a name', () => {
    const cases: [string, Payload, string, string][] = [
      ['booking_confirmation', { accessToken: 'SECRET-token-with-illegal-characters!!' }, 'accessToken', 'SECRET-token'],
      ['admin_new_booking', { clientEmail: 'not-an-address-private-person' }, 'clientEmail', 'private-person'],
      ['booking_confirmation', { clientName: 'x'.repeat(201) + 'PRIVATE' }, 'clientName', 'PRIVATE'],
      ['admin_alert password_reset', { resetUrl: 'not a url PRIVATE-TOKEN' }, 'resetUrl', 'PRIVATE-TOKEN'],
      ['photo_delivery', { deliveryUrl: 'http://drive.example/PRIVATE-share' }, '', 'PRIVATE-share'],
    ];
    for (const [name, changes, path, secret] of cases) {
      const { template, payload } = withPayload(name, changes);
      const error = payloadError(() => render(template, payload));
      expect(error.message).toContain(path);
      expect(error.message).not.toContain(secret);
    }
  });

  it.each([
    ['a fraction', 18_000.5],
    ['a negative amount', -1],
    ['a numeric string', '18000'],
    ['NaN', Number.NaN],
    ['an unsafe integer', 2 ** 60],
  ])('rejects %s as an amount', (_case, amount) => {
    const error = payloadError(() => renderWith('booking_confirmation', { paidRwf: amount }));
    expect(error.message).toBe('The booking_confirmation payload is invalid at: paidRwf');
  });

  it('names nested paths', () => {
    const error = payloadError(() => renderWith('admin_new_booking', { addons: [{ name: 'Prints', priceRwf: 1.5 }] }));
    expect(error.message).toBe('The admin_new_booking payload is invalid at: addons.0.priceRwf');
  });

  it.each(['http://photos.example-host.com/s/abc', 'javascript:alert(1)', 'ftp://photos.example-host.com/abc', 'not a url'])(
    'rejects a delivery link that is not https: %s',
    (deliveryUrl) => {
      expect(() => renderWith('photo_delivery', { deliveryUrl })).toThrow(EmailPayloadError);
    },
  );

  it.each([
    ['a date that does not exist', { expiresOn: '2026-02-30' }, 'photo_delivery'],
    ['an instant for a date', { expiresOn: '2027-01-01T00:00:00Z' }, 'photo_delivery'],
    ['a local time without an offset', { startsAt: '2026-10-07T09:30:00' }, 'booking_confirmation'],
    ['prose for an instant', { startsAt: '7 October 2026' }, 'booking_confirmation'],
    ['a short token', { accessToken: 'abc' }, 'booking_confirmation'],
    ['an unknown cancelledBy', { cancelledBy: 'system' }, 'cancellation (by client)'],
    ['an unknown payment kind', { kind: 'tip' }, 'payment_receipt'],
    ['an unknown refund reason', { reason: 'goodwill' }, 'admin_alert refund_due'],
    ['an unknown provider', { provider: 'stripe' }, 'admin_alert refund_due'],
    ['an unknown message kind', { messageKind: 'sms' }, 'admin_alert retries_exhausted'],
    ['a zero lockout count', { failedLoginCount: 0 }, 'admin_alert login_lockout'],
    ['an empty reference', { reference: '   ' }, 'session_fee_request'],
  ])('rejects %s', (_case, changes, name) => {
    expect(() => renderWith(name, changes)).toThrow(EmailPayloadError);
  });

  it('rejects an unknown admin_alert variant, or none, naming variant', () => {
    expect(payloadError(() => render('admin_alert', { variant: 'weekly_digest' })).message).toContain('variant');
    expect(payloadError(() => render('admin_alert', { failedLoginCount: 5 })).message).toContain('variant');
  });

  it.each([null, undefined, 'a string', 42, []])('rejects a payload that is not an object: %s', (payload) => {
    expect(payloadError(() => render('booking_confirmation', payload)).message).toContain('booking_confirmation');
  });

  it.each(['booking_invite', '', '__proto__', 'constructor', 'toString'])('rejects an unknown template: "%s"', (template) => {
    expect(() => render(template, {})).toThrow(EmailPayloadError);
  });

  it.each(['fr', 'xx', '', null, undefined, 'EN', 'en-GB'])('falls back to English for locale %s', (locale) => {
    for (const fixture of EMAIL_FIXTURES) {
      expect(render(fixture.template, fixture.payload, locale)).toEqual(renderFixture(fixture));
    }
  });

  it('defaults the optional admin_new_booking fields', () => {
    const { payload } = withPayload('admin_new_booking', {});
    delete payload.partySize;
    delete payload.specialRequests;
    delete payload.addons;

    const email = render('admin_new_booking', payload);

    expect(email.text).toContain('People: Not given');
    expect(email.text).toContain('Special requests: Not given');
  });
});

// --- Content rules ---------------------------------------------------------------------

describe('content rules', () => {
  it('a client cancellation says the booking fee is non-refundable, and shows no reason', () => {
    const email = renderWith('cancellation (by client)', { reason: 'I changed my mind' });

    expect(email.text).toContain('the booking fee of 18,000 RWF is non-refundable');
    expect(email.html).toContain('non-refundable');
    expect(email.text).not.toContain('Reason:');
    expect(email.text).not.toContain('I changed my mind');
    expect(email.text).not.toMatch(/refund of/);
  });

  it('a client cancellation after a paid session fee also promises that refund', () => {
    const email = renderWith('cancellation (by client)', { refundRwf: 27_000 });

    expect(email.text).toContain('non-refundable');
    expect(email.text).toContain('We owe you a refund of 27,000 RWF');
  });

  // The payload `cancel.ts` enqueues when a client cancels a booking whose session
  // fee had already been collected (plan.md Task 18, spec §6.10).
  it('a client cancellation with a session fee to refund (plan.md Task 18) matches its snapshot', () => {
    const email = renderWith('cancellation (by client)', { refundRwf: 27_000, bookingFeeRwf: 18_000 });

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });

  it('a client cancellation names the fee it forfeits and the refund it owes as two different sums', () => {
    const email = renderWith('cancellation (by client)', { refundRwf: 27_000, bookingFeeRwf: 18_000 });

    expect(email.text).toContain('the booking fee of 18,000 RWF is non-refundable');
    expect(email.text).toContain('We owe you a refund of 27,000 RWF');
    expect(email.html).toContain('27,000 RWF');
    expect(email.html).toContain('18,000 RWF');
  });

  it('an admin cancellation shows the reason and the refund, and never calls the fee non-refundable', () => {
    const email = renderFixture(emailFixture('cancellation (by admin)'));

    expect(email.text).toContain('Reason: The photographer is unwell.');
    expect(email.text).toContain('We owe you a refund of 18,000 RWF');
    expect(email.text).not.toMatch(/non-refundable/i);
    // The system never moves money (spec §6.16): a promise to arrange, not a refund made.
    expect(email.text).not.toMatch(/(have|has been) refunded/i);
  });

  it('photo_delivery states the expiry date as text', () => {
    const email = renderFixture(emailFixture('photo_delivery'));

    expect(email.text).toContain('The download link works until the end of Friday, 1 January 2027 (Kigali time).');
    expect(email.html).toContain('Friday, 1 January 2027');
    expect(hrefs(email.html)).toContain('https://photos.example-host.com/s/abc123');
  });

  it('payment_receipt says paid in full only when nothing is outstanding', () => {
    expect(renderWith('payment_receipt', { outstandingRwf: 0 }).text).toContain('paid in full');
    const partial = renderWith('payment_receipt', { outstandingRwf: 5_000, paidRwf: 40_000 });
    expect(partial.text).not.toMatch(/paid in full/i);
    expect(partial.html).not.toMatch(/paid in full/i);
  });

  it('booking_confirmation says paid in full only when nothing is outstanding', () => {
    expect(renderWith('booking_confirmation', { outstandingRwf: 0 }).text).toContain('paid in full');
    expect(renderFixture(emailFixture('booking_confirmation')).text).not.toMatch(/paid in full/i);
  });

  it('booking_links lists every booking with its own link, each token only inside its own link (2026-09-25)', () => {
    const email = renderFixture(emailFixture('booking_links'));
    const links = [FIXTURE_ACCESS_TOKEN, FIXTURE_SECOND_ACCESS_TOKEN].map((token) => `${FIXTURE_WEB_ORIGIN}/booking/${token}`);

    expect(email.subject).not.toMatch(new RegExp(`${FIXTURE_ACCESS_TOKEN}|${FIXTURE_SECOND_ACCESS_TOKEN}`));
    for (const body of [email.text, email.html]) {
      expect(body).toContain(FIXTURE_REFERENCE);
      expect(body).toContain(FIXTURE_SECOND_REFERENCE);
      let rest = body;
      for (const link of links) {
        expect(rest).toContain(link);
        rest = rest.replaceAll(link, '<link>');
      }
      expect(rest).not.toContain(FIXTURE_ACCESS_TOKEN);
      expect(rest).not.toContain(FIXTURE_SECOND_ACCESS_TOKEN);
    }
    for (const url of [...urlsIn(email.text), ...hrefs(email.html)].filter((u) => u.includes('/booking/'))) {
      expect(links).toContain(url);
    }
    expect(email.text).toContain('Any link we sent you before no longer works.');
  });

  it('booking_links refuses a payload with no bookings, or a token that is not one', () => {
    const fixture = emailFixture('booking_links');
    expect(() => renderEmail('booking_links', { ...fixture.payload, bookings: [] }, { webOrigin: FIXTURE_WEB_ORIGIN })).toThrow(EmailPayloadError);
    const [first] = (fixture.payload as { bookings: Record<string, unknown>[] }).bookings;
    expect(() =>
      renderEmail('booking_links', { ...fixture.payload, bookings: [{ ...first, accessToken: 'short' }] }, { webOrigin: FIXTURE_WEB_ORIGIN }),
    ).toThrow(EmailPayloadError);
  });

  it('email_change_confirm carries its token only inside its own link, and no booking link (2026-09-25)', () => {
    const email = renderFixture(emailFixture('email_change_confirm'));
    const link = `${FIXTURE_WEB_ORIGIN}/email-confirm/${FIXTURE_CONFIRM_TOKEN}`;

    expect(email.subject).not.toContain(FIXTURE_CONFIRM_TOKEN);
    for (const body of [email.text, email.html]) {
      expect(body).toContain(link);
      expect(body).toContain('aline.new@example.com');
      expect(body.replaceAll(link, '<link>')).not.toContain(FIXTURE_CONFIRM_TOKEN);
      expect(body).not.toContain('/booking/');
    }
  });

  it('email_changed_notice names the new address and carries no link at all', () => {
    const email = renderFixture(emailFixture('email_changed_notice'));

    expect(email.text).toContain('aline.new@example.com');
    expect(hrefs(email.html)).toEqual([]);
  });

  it('access_link_resend says older links no longer work', () => {
    expect(renderFixture(emailFixture('access_link_resend')).text).toContain('Any link we sent you before no longer works.');
  });

  it('reschedule shows both the old and the new time', () => {
    const email = renderFixture(emailFixture('reschedule'));

    expect(email.text).toContain('Was: Wednesday, 7 October 2026, 09:30 to 10:30 (Kigali time)');
    expect(email.text).toContain('Now: Friday, 9 October 2026, 11:00 to 12:00 (Kigali time)');
  });

  it('refund_due tells the photographer the system does not move money', () => {
    const email = renderFixture(emailFixture('admin_alert refund_due'));

    expect(email.text).toContain('The system does not move money. Refund the client through MTN MoMo');
  });

  it.each([
    ['admin_cancelled', 'You cancelled this booking'],
    ['late_payment_slot_taken', 'booked by someone else'],
    ['duplicate_payment', 'The client paid the booking fee twice. The booking stands on the first payment; this one is owed back.'],
    ['session_fee_after_client_cancel', 'cancelled after paying the session fee'],
  ])('refund_due explains the reason %s in words (plan.md Tasks 17, 19)', (reason, words) => {
    const email = renderWith('admin_alert refund_due', { reason });

    expect(email.text).toContain(words);
    expect(email.html).toContain(escapeHtml(words));
    expect([email.subject, email.text, email.html].join('\n')).not.toMatch(/reasons\.|\{\{|undefined/);
  });

  it('refund_due for a duplicate booking fee (plan.md Task 17) matches its snapshot', () => {
    const email = renderWith('admin_alert refund_due', { reason: 'duplicate_payment', paymentReference: '4100000123' });

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });

  it('no template mentions a processing fee', () => {
    expect(JSON.stringify(en.email)).not.toMatch(/processing fee|transaction fee|service charge/i);
    for (const fixture of EMAIL_FIXTURES) {
      const email = renderFixture(fixture);
      expect([email.subject, email.text, email.html].join('\n')).not.toMatch(/processing fee|transaction fee|service charge/i);
    }
  });

  it.each([
    ...EMAIL_TEMPLATES.map((template) => ['email', template] as const),
    ...OUTBOX_KINDS.filter((kind) => kind !== 'email').map((kind) => [kind, null] as const),
    ['email', null] as const,
  ])('a retries_exhausted alert for %s %s names the message in words, not a translation key', (messageKind, template) => {
    const email = render('admin_alert', {
      variant: 'retries_exhausted',
      messageKind,
      template,
      bookingReference: null,
      attempts: 8,
      lastError: 'Error: boom',
    });

    const line = email.text.split('\n').find((l) => l.startsWith('Message: ')) ?? '';
    expect(line).toMatch(/^Message: [A-Z][a-z]+( [A-Za-z]+)+$/);
    expect(email.text).not.toContain('retriesExhausted');
  });
});

// --- The reschedule email's link (plan.md Task 19) ---------------------------------

/**
 * A reschedule issues no new token and the plaintext of the existing one was
 * never stored (data-model_v2.md §5.9), so `accessToken` is nullable: null
 * points the client at the link they already have, and a resend (spec §6.21) is
 * how a lost one is replaced. The button must disappear with it -- a "view
 * booking" link with no token would 404 the client on their own booking.
 */
describe('reschedule with and without an access token', () => {
  const NO_TOKEN = { accessToken: null };

  it('shows the booking-link button when a plaintext token is given', () => {
    const email = renderFixture(emailFixture('reschedule'));

    expect(hrefs(email.html)).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(email.text).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(email.html).toContain('View your booking');
    expect(email.text).not.toContain('Your booking link has not changed');
  });

  it('says the link has not changed when there is no token, and offers none', () => {
    const email = renderWith('reschedule', NO_TOKEN);

    expect(email.text).toContain('Your booking link has not changed: the one in your confirmation email still opens this booking.');
    expect(email.html).toContain(escapeHtml('Your booking link has not changed'));
    expect(email.html).not.toContain('View your booking');
    // No booking link of any kind: the only URLs left are the site's own footer.
    expect(hrefs(email.html).filter((href) => href.includes('/booking/'))).toEqual([]);
    expect(urlsIn(email.text).filter((url) => url.includes('/booking/'))).toEqual([]);
  });

  it('carries no token anywhere in the subject, the text or the HTML', () => {
    const email = renderWith('reschedule', NO_TOKEN);

    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain(FIXTURE_ACCESS_TOKEN);
      expect(part).not.toMatch(/accessToken|access_token/i);
      expect(part).not.toContain('null');
    }
  });

  it('still shows both the old time and the new one without a token', () => {
    const email = renderWith('reschedule', NO_TOKEN);

    expect(email.text).toContain('Was: Wednesday, 7 October 2026, 09:30 to 10:30 (Kigali time)');
    expect(email.text).toContain('Now: Friday, 9 October 2026, 11:00 to 12:00 (Kigali time)');
    expect(email.html).toContain('Wednesday, 7 October 2026');
    expect(email.html).toContain('Friday, 9 October 2026');
    expect(email.subject).toContain(FIXTURE_REFERENCE);
  });

  it('defaults a missing accessToken to null, so the payload admin-actions.ts enqueues parses', () => {
    const { payload } = withPayload('reschedule', {});
    const { accessToken: _dropped, ...withoutToken } = payload;

    const parsed = reschedule.payload.parse(withoutToken) as { accessToken: unknown };

    expect(parsed.accessToken).toBeNull();
    expect(render('reschedule', withoutToken).text).toContain('Your booking link has not changed');
  });

  it('refuses an accessToken that is neither a token nor null', () => {
    expect(payloadError(() => renderWith('reschedule', { accessToken: 'has spaces in it' }))).toBeInstanceOf(EmailPayloadError);
    expect(payloadError(() => renderWith('reschedule', { accessToken: 42 }))).toBeInstanceOf(EmailPayloadError);
  });

  it('renders both shapes with no placeholder or missing translation left behind', () => {
    for (const email of [renderFixture(emailFixture('reschedule')), renderWith('reschedule', NO_TOKEN)]) {
      expect([email.subject, email.text, email.html].join('\n')).not.toMatch(
        /\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]|\b(email|common):[a-z]/,
      );
    }
  });

  it('matches its snapshot without a token', () => {
    const email = renderWith('reschedule', NO_TOKEN);

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });
});

describe('the registry', () => {
  it('holds one definition per template, each with a schema and a composer', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...EMAIL_TEMPLATES].sort());
    for (const definition of Object.values(TEMPLATES)) {
      expect(typeof definition.payload.safeParse).toBe('function');
      expect(typeof definition.compose).toBe('function');
    }
  });
});

// --- The receipt's link, and the request that asks for money (plan.md Task 20) ------------

/**
 * A session fee's receipt is enqueued by the webhook, which has no plaintext
 * token to give it: the client's own was never stored (data-model_v2.md §5.9),
 * and minting a new one would kill the link they are already using. So
 * `accessToken` is nullable, and null means "the link you have still works"
 * with no button and no URL anywhere in the email -- a "view booking" link with
 * no token would 404 the client on their own booking.
 *
 * The session-fee request is the opposite case: it exists to be paid, so it
 * always carries a token and always shows the button (spec §3.5 step 3).
 */
describe('payment_receipt with and without an access token', () => {
  const NO_TOKEN = { accessToken: null };

  it('shows the booking-link button when a plaintext token is given', () => {
    const email = renderFixture(emailFixture('payment_receipt'));

    expect(hrefs(email.html)).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(email.text).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(email.html).toContain('View your booking');
    expect(email.text).not.toContain('Your booking link has not changed');
  });

  it('says the link has not changed when there is no token, and offers none', () => {
    const email = renderWith('payment_receipt', NO_TOKEN);

    expect(email.text).toContain('Your booking link has not changed: the one in your confirmation email still opens this booking.');
    expect(email.html).toContain(escapeHtml('Your booking link has not changed'));
    expect(email.html).not.toContain('View your booking');
    expect(hrefs(email.html).filter((href) => href.includes('/booking/'))).toEqual([]);
    expect(urlsIn(email.text).filter((url) => url.includes('/booking/'))).toEqual([]);
  });

  it('carries no token anywhere in the subject, the text or the HTML', () => {
    const email = renderWith('payment_receipt', NO_TOKEN);

    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain(FIXTURE_ACCESS_TOKEN);
      expect(part).not.toMatch(/accessToken|access_token/i);
      expect(part).not.toContain('null');
    }
  });

  it('still receipts the payment in full without a token: amount, reference, date and totals', () => {
    const email = renderWith('payment_receipt', NO_TOKEN);

    expect(email.subject).toContain(FIXTURE_REFERENCE);
    expect(email.text).toContain('27,000 RWF');
    expect(email.text).toContain('PAY-7F3K9Q');
    expect(email.text).toContain('15 Jan 2026, 23:30');
    expect(email.text).toContain('45,000 RWF');
  });

  it('defaults a missing accessToken to null, so the payload webhooks.ts enqueues parses', () => {
    const { payload } = withPayload('payment_receipt', {});
    const { accessToken: _dropped, ...withoutToken } = payload;

    const parsed = paymentReceipt.payload.parse(withoutToken) as { accessToken: unknown };

    expect(parsed.accessToken).toBeNull();
    expect(render('payment_receipt', withoutToken).text).toContain('Your booking link has not changed');
  });

  it('refuses an accessToken that is neither a token nor null', () => {
    expect(payloadError(() => renderWith('payment_receipt', { accessToken: 'has spaces in it' }))).toBeInstanceOf(EmailPayloadError);
    expect(payloadError(() => renderWith('payment_receipt', { accessToken: 42 }))).toBeInstanceOf(EmailPayloadError);
  });

  it('says paid in full only when nothing is outstanding, with a token or without one', () => {
    for (const token of [{}, NO_TOKEN]) {
      expect(renderWith('payment_receipt', { ...token, outstandingRwf: 0 }).text).toContain('paid in full');
      const partial = renderWith('payment_receipt', { ...token, outstandingRwf: 5_000, paidRwf: 40_000 });
      expect(partial.text).not.toMatch(/paid in full/i);
      expect(partial.html).not.toMatch(/paid in full/i);
      expect(partial.text).toContain('5,000 RWF');
    }
  });

  it('renders both shapes with no placeholder or missing translation left behind', () => {
    for (const email of [renderFixture(emailFixture('payment_receipt')), renderWith('payment_receipt', NO_TOKEN)]) {
      expect([email.subject, email.text, email.html].join('\n')).not.toMatch(
        /\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]|\b(email|common):[a-z]/,
      );
    }
  });

  it('matches its snapshot without a token', () => {
    const email = renderWith('payment_receipt', NO_TOKEN);

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });

  it('matches its snapshot for a part payment that leaves money outstanding', () => {
    const email = renderWith('payment_receipt', { ...NO_TOKEN, amountRwf: 20_000, paidRwf: 38_000, outstandingRwf: 7_000 });

    expect(email.subject).toMatchSnapshot('subject');
    expect(email.text).toMatchSnapshot('text');
    expect(email.html).toMatchSnapshot('html');
  });
});

describe('session_fee_request asks for an amount and offers a way to pay it', () => {
  it('names the amount asked for and points the pay button at the booking link', () => {
    const email = renderFixture(emailFixture('session_fee_request'));

    expect(email.subject).toContain(FIXTURE_REFERENCE);
    expect(email.text).toContain('27,000 RWF');
    expect(email.html).toContain('27,000 RWF');
    expect(email.html).toContain('Pay the session fee');
    expect(hrefs(email.html)).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
    expect(email.text).toContain(`${FIXTURE_WEB_ORIGIN}/booking/${FIXTURE_ACCESS_TOKEN}`);
  });

  it('names the amount it was given, whatever it is', () => {
    const email = renderWith('session_fee_request', { amountRwf: 45_000 });

    expect(email.text).toContain('45,000 RWF');
    expect(email.text).not.toContain('27,000 RWF');
  });

  it('requires a token: a request for money with no way to pay it is not a request', () => {
    expect(payloadError(() => renderWith('session_fee_request', { accessToken: null }))).toBeInstanceOf(EmailPayloadError);
  });

  it('promises a receipt once the money arrives, which is the email above', () => {
    expect(renderFixture(emailFixture('session_fee_request')).text).toContain(
      'We will email you a receipt once your payment has arrived.',
    );
  });
});

// --- photo_delivery: the one email that points off the site (plan.md Task 21) -----------

/**
 * The delivery email (spec §3.5 steps 6-7, §6.20, A-7). The files live on the
 * photographer's own host, so this is the only template whose button leaves the
 * site -- and the only one that must state a date the client can read without
 * following anything, because the link dies on it (§6.5). A link that is not
 * https never renders at all: the payload is refused the way the column refuses
 * it.
 */
describe('photo_delivery', () => {
  const LINK = 'https://photos.example-host.com/s/abc123';
  /** The note's own wrapper, so its absence can be asserted rather than guessed at. */
  const NOTE_PREFIX = 'A note from your photographer:';

  it('makes the external host’s link its button', () => {
    const email = renderFixture(emailFixture('photo_delivery'));

    expect(hrefs(email.html)).toContain(LINK);
    expect(email.html).toContain('Download your photos');
    expect(email.text).toContain(LINK);
  });

  it('is the only email whose links leave the site', () => {
    const email = renderFixture(emailFixture('photo_delivery'));
    const offSite = [...new Set([...hrefs(email.html), ...urlsIn(email.text)])].filter(
      (url) => !url.startsWith(`${FIXTURE_WEB_ORIGIN}/`) && url !== FIXTURE_WEB_ORIGIN,
    );

    expect(offSite).toEqual([LINK]);
  });

  it('follows the link the payload carries, whatever host it names', () => {
    const elsewhere = 'https://wetransfer.example/download/9f2c';

    const email = renderWith('photo_delivery', { deliveryUrl: elsewhere });

    expect(hrefs(email.html)).toContain(elsewhere);
    expect(email.html).not.toContain(LINK);
  });

  it('states the expiry date as text in both bodies', () => {
    const email = renderWith('photo_delivery', { expiresOn: '2027-03-15' });

    expect(email.text).toContain('The download link works until the end of Monday, 15 March 2027 (Kigali time).');
    expect(email.html).toContain('Monday, 15 March 2027');
    expect(email.subject).not.toContain('2027-03-15');
    expect(email.text).not.toContain('2027-03-15');
  });

  it('includes the photographer’s note when he wrote one', () => {
    const email = renderWith('photo_delivery', { note: 'The raw files are in the second folder.' });

    expect(email.text).toContain(`${NOTE_PREFIX} The raw files are in the second folder.`);
    expect(email.html).toContain('The raw files are in the second folder.');
  });

  it('omits that paragraph entirely when he wrote none', () => {
    const email = renderWith('photo_delivery', { note: null });

    expect(email.text).not.toContain(NOTE_PREFIX);
    expect(email.html).not.toContain(NOTE_PREFIX);
    // And the rest of the email is still whole.
    expect(hrefs(email.html)).toContain(LINK);
    expect(email.text).toContain('until the end of Friday, 1 January 2027 (Kigali time)');
  });

  it('treats a missing note as no note at all', () => {
    const { payload } = withPayload('photo_delivery', {});
    delete payload.note;

    const email = render('photo_delivery', payload);

    expect(email.text).not.toContain(NOTE_PREFIX);
  });

  it.each([
    ['plain http', 'http://photos.example-host.com/s/abc123'],
    ['http on the same host as the site', 'http://bookly.example/photos'],
    ['a javascript: URL', 'javascript:alert(document.cookie)'],
    ['an ftp URL', 'ftp://photos.example-host.com/s/abc123'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a file: URL', 'file:///C:/photos'],
    ['not a URL at all', 'photos.example-host.com/s/abc123'],
  ])('refuses to send %s rather than putting it in front of the client', (_case, deliveryUrl) => {
    const error = payloadError(() => renderWith('photo_delivery', { deliveryUrl }));

    expect(error).toBeInstanceOf(EmailPayloadError);
    // The link is the client's, and a rejection is logged: it never repeats it.
    expect(error.message).not.toContain('abc123');
  });

  it('refuses a missing link, naming the field', () => {
    const { payload } = withPayload('photo_delivery', {});
    delete payload.deliveryUrl;

    expect(payloadError(() => render('photo_delivery', payload)).message).toContain('deliveryUrl');
  });

  it('counts nothing: no download total appears anywhere in it (data-model_v2.md §5.9)', () => {
    const email = renderFixture(emailFixture('photo_delivery'));

    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/\b\d+\s+(downloads|times)\b/i);
      expect(part).not.toMatch(/downloaded\s+\d/i);
    }
  });
});

describe('admin_alert refund_due for cash (admin console fixes, item 7)', () => {
  it('names cash as the provider and says to give it back by hand', () => {
    const email = renderWith('admin_alert refund_due', { provider: 'cash' });

    expect(email.text).toContain('Cash');
    expect(email.text).toContain('This was paid in cash: give it back to the client, then record the refund on the booking.');
    expect(email.text).not.toContain('Refund the client through');
  });

  it('keeps the provider sentence for money paid online', () => {
    const email = renderWith('admin_alert refund_due', { provider: 'mtn_momo_direct' });

    expect(email.text).toContain('Refund the client through MTN MoMo, then record the refund on the booking.');
  });
});
