# Account Payments and Receipt — Page Design

> **Project:** Bookly · **Routes:** `/account/payments`, `/account/payments/:ourRef/receipt` · **Files:** `frontend/src/pages/account/AccountPayments.tsx` (list, `MoneyBack`), `AccountReceipt.tsx`, the print block at the end of `frontend/src/index.css`
> **Written:** 2026-10-27, Phase 8 (marketplace spec R8.2, T8.1). Built inside `client-front.md`.
> **API:** `GET /api/account/payments?page` → `{ payments, total, page, pageSize: 20, pageCount }`; `GET /api/account/payments/:ourRef` → `{ receipt }` | `409 no_receipt { payment: { status } }` | `404`.

## The list

`main` (`container`, `pageY`, `flex-col gap-8`), under the account nav, Payments current. Head: eyebrow "Account", `h1` "Payments", lead "Every payment on your bookings, newest first."

`ul[aria-label="Payments"]`, one hairline panel per payment (`p-5 sm:p-6`, `gap-4`):

- **Top row:** `h2` the kind ("Booking fee" / "Session fee", 18px / 500), the amount under it (mono 24px / 600); the **payment status badge** on the right.
- **Payment status badge** (`PaymentStatusBadge`, console shapes from `admin-console.md` §5, the word always shown): Paid = filled check on the success tint; Waiting for approval (and Started) = clock, dashed `--input` edge; Did not go through = cross on the danger tint; Refund due = clock on the warning tint; Refunded = outlined check, hairline edge.
- **Facts** `dl`, two columns from `sm`, mono labels: **Booking** (full width: "Portraits, Standard" as a link to `/account/bookings/:reference`, then the photographer as a link to `/p/:handle`, the reference in mono and the shoot's Kigali date, `·`-separated); **Date** (mono, `settledAt` else `createdAt`, Kigali); **Method** ("MTN MoMo", "Airtel Money", "Card", "Paid to the photographer" for cash they recorded; no row when none was recorded); **Payment reference** (full width, mono 13px, the `ourRef`).
- **Failure** (failed only): a danger line with `CircleAlert`, the public words: "It was declined on the phone, or not approved in time." / "Mobile Money could not be reached at the time."
- **Money back** (`MoneyBack`, shared with the receipt): an accent-soft box (info, never success) with an `Undo2` line each for "20,000 RWF is owed back to you.", "20,000 RWF was refunded on Saturday, 3 October 2026." plus "Transfer reference: MOMO-TX-778", and an overpayment, "5,000 RWF more than was asked was paid. It is being sent back to you." / "…, and was refunded on …". Nothing when there is none.
- **View receipt** (outline `sm`, `ReceiptText`, trailing arrow), a hairline above, **only when `hasReceipt`**.

Pager as on the dashboard (`?page=2`). States: loading skeletons; failed + Try again; empty "No payments yet" with one line and no link.

## The receipt

`main` (`max-w-3xl`): the back link "All payments"; the head (eyebrow `ReceiptText` "Receipt", `h1` "Payment receipt") with an outline **Print** button (`Printer`) on the right, which calls `window.print()` (through `printer.print`, so a test can see it). No PDF library.

The receipt is an `article[data-receipt]`, a hairline panel `p-5 sm:p-8`:

1. **Top:** the wordmark text (`common:appName`, 20px / 600) left; "Receipt number" (mono label) and the `ourRef` (mono) right; a hairline under.
2. **Facts** `dl`, two columns from `sm` and in print: Billed to (the name on the booking, as booked), Photographer, Booking reference (mono), Service, Session (full width, Kigali time), Payment for (the kind), Method, Paid on (mono), Status (in words, no badge: it prints).
3. **Booking price:** mono label, then a `table` of `th[scope=row]` / mono amount rows: the package, each add-on ("Prints × 3" when more than one, with "Added after the shoot" under a post-shoot one), and, muted, "Of which the booking fee, paid when booking". **No total line**: the receipt answer carries none, and nothing is added up here.
4. **Amount paid**, a hairline above: 16px / 500 label, mono 24px / 600 amount.
5. **Refund** (only with a refund or an overpayment): mono label and `MoneyBack`.
6. "All times are Kigali time." 13px muted.

### Print (`@media print`, only while `[data-receipt]` is on the page)

- Hidden: the shell's `header` and `footer`, the account nav (`[data-account-nav]`), the skip link, and every control (`print:hidden` on the back link and Print).
- **Black on white in either theme:** the tokens are reset under `:root:has([data-receipt])` (canvas `#fff`, text `#000`, muted `#333`, secondary `#222`, hairlines `#999`, every tint `#fff`), so a dark-theme visitor prints the same page as a light one.
- **One page:** `@page { margin: 14mm }`, the panel's edge and padding drop (`print:border-0 print:p-0`), 11pt type, `break-inside: avoid` on the receipt, its sections, lists and rows. Checked with Chromium's print emulation at A4.

### Receipt states

| State | What shows |
|---|---|
| loading | "Loading the receipt…" `role="status"` |
| failed | destructive callout + Try again |
| `409 no_receipt`, pending or started | `ReceiptText` tile, `h1` "No receipt for this payment", "This payment is still waiting for approval. Its receipt appears here once the money arrives." |
| `409 no_receipt`, failed | the same `h1`, "This payment did not go through, so no money was taken and there is no receipt." |
| `404` (not the account's, a subscription payment, unknown) | `SearchX` tile, `h1` "Receipt not found", "There is no payment with that reference on this account." No amount, no button. |

## Do not

- Never the provider's name or reference, the failure text, or a cash payment's note: the API sends none, and the page invents none.
- No "success" colour for money owed back.
- No sums.
