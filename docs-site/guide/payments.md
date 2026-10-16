# Payments: fees, cash and refunds

The golden rule: **Bookly never moves money.** It records what happened. Mobile
Money moves money on its own rails; cash moves in your hand; refunds you send by
Mobile Money or bank. Bookly keeps the record straight and the booking in step.

## The booking fee is collected for you

When a client pays the booking fee, their provider confirms it and Bookly does
the rest automatically: the booking becomes **confirmed**, the slot is locked,
the client gets their confirmation email with their private link, and **you get
a new-booking alert**. You don't do anything to "accept" it.

If a booking-fee payment arrives too late (the hold had already expired and the
slot was taken), Bookly keeps the booking expired, marks that payment as
**owed back**, and emails you so you can refund it.

## Asking for the session fee

After the shoot, open the booking and **request the session fee**. Bookly emails
the client a request for exactly what's outstanding, and they pay it online from
their booking page. (This button is only available when online payments are
configured.)

If the client pays online, it's collected automatically like the booking fee,
and you get a payment-received alert.

## Recording a cash payment

When a client pays you in cash, open the booking and **record a cash payment**:

- Enter any amount **up to what's outstanding** (Bookly refuses more than is
  owed).
- If an online payment for that booking might still be in flight, Bookly refuses
  the cash entry until that settles — so the same money can't be taken twice.
- Recording cash **voids any open online request** for that booking, so the
  client's "pay now" button can't then collect the same money.
- Recording cash emails nobody; it's your private bookkeeping entry.

"Completed" means paid. You can only mark a booking **completed** once nothing is
outstanding — if a balance remains, Bookly tells you rather than completing it.

## Refunds

Bookly can't send money, so a refund is two steps:

1. **You send it** — by Mobile Money or bank, outside Bookly.
2. **You record it** — open the payment and record the refund with the Mobile
   Money or bank reference you used.

When you cancel a confirmed booking, Bookly marks its booking fee as **owed
back** (refund due) and emails the client that it was cancelled; actually sending
and recording the refund is the deliberate second step above. The bookings list
flags anything with money owed back so it doesn't slip.

## What the payment states mean

| State | Meaning |
|---|---|
| **pending** | Started; waiting for the provider to confirm. Mobile Money can take a minute. |
| **succeeded** | The money arrived. |
| **failed** | The attempt didn't go through (declined, timed out, bad number). Nothing was charged. |
| **refund due** | Money arrived but is owed back (a cancellation, a duplicate, or a late payment). Refund it, then record it. |
| **refunded** | You've recorded that the refund was sent. |

If a client is ever charged twice, or pays more than the booking is worth, Bookly
records the money as received, flags the extra as **refund due**, and alerts you
— the client is never silently overcharged.

---

*Developers: the webhook, reconciler and refund internals are in the
[Payments](/developers/payments) developer page.*
