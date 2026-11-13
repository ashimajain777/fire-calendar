# ADR-010: Telegram alerts with deep-link subscriptions (low priority)

**Status:** Accepted, low priority (after the cut line)
**Date:** 2026-11-14

## Context
Alerts must really send. With no server, there's no backend to store subscriptions or to send mail.

## Decision
- A Telegram bot.
- The app builds `t.me/<bot>?start=<payload>`, where the payload is base64url of the bbox (2 dp), the percentile threshold and the period. It fits in 64 characters.
- The daily Action reads `getUpdates`, stores subscriptions as chat ID + payload in `alerts/subscriptions.json`, evaluates month-to-date percentiles with the same definitions as the app, and sends messages.
- Anti-spam: at most 1 message per subscription per 7 days unless the percentile rises by 5 or more points. `/stop` unsubscribes.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| Telegram (chosen) | Free; instant; bot API needs only a token; no address storage | Users need Telegram; some networks block it; polygon becomes a bbox |
| Email (Resend/SMTP) | Universal | Needs a provider account and domain verification, plus somewhere to store addresses safely |

## Consequences
- Telegram chat IDs are personal identifiers. In a public repo they must not be committed in plain text: store `subscriptions.json` encrypted with a repo secret, or keep the repo private and publish Pages from it. Document whichever is chosen.
- Revisit email once a backend exists.
