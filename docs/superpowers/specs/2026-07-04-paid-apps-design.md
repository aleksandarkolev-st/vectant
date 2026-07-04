# Paid Apps — Marketplace Billing Control Plane (Design)

- **Date:** 2026-07-04
- **Status:** Proposed — awaiting approval before implementation
- **Branch:** `feat/docker-sysbox-engine`
- **Scope:** Let a published app be **paid**. This repo owns the *control plane* — pricing, entitlement, the paywall at install/launch, the buy hand-off, and a signed webhook that grants/revokes access. Actual card processing + publisher payouts live in the **existing payments app (separate repo)**; this repo never touches card data.

## Problem

Every published app is free to install today. `canPublish` already reserves a seam for a paywall (`entitlements.js`), but there is no notion of a price, of who has bought what, or of gating install/launch on a purchase. We need a billing control plane that:

1. Lets a publisher set a **one-time price** on their app.
2. Records **who is entitled** to a paid app.
3. **Gates install (and re-checks launch)** on entitlement.
4. Learns about purchases/refunds from the payments app via a **signed webhook**.
5. Supports a **marketplace with publisher payouts** (platform take-rate; the payout itself is executed by the payments app).

## Decisions (locked in clarification)

- **Pricing model v1: one-time purchase.** Buy once → entitled forever. Subscriptions / usage-based are out of scope for v1 (the schema leaves room — see Non-goals).
- **Marketplace with payouts.** Publishers set prices and earn revenue; the platform takes a configurable cut. This repo stores the publisher's **payout-account reference** (an opaque id owned by the payments app) and the **take-rate**, and exposes an earnings read-model. It does **not** move money.
- **Boundary = signed webhook → we store entitlement.** The payments app posts a signed, idempotent webhook on `purchase`/`refund`; we persist/revoke an `Entitlement`. Enforcement reads our local store (resilient to the payments app being briefly unavailable).
- **Publishing stays free.** The paywall gates *buying/installing*, never publishing. `canPublish` is untouched; a new `canInstall` gate carries the entitlement check.

## Boundary — who owns what

| Concern | Owner |
|---|---|
| Card entry, checkout UI, PCI scope | Payments app (other repo) |
| Charging the buyer, issuing refunds | Payments app |
| Paying out publishers, tax/1099, reconciliation | Payments app |
| Price / currency / take-rate **of an app** | **This repo** (`ProgramPricing`) |
| Who is entitled to an app | **This repo** (`Entitlement`) |
| Paywall at install/launch | **This repo** |
| Buy hand-off (start checkout) | **This repo** initiates → payments app completes |
| Purchase/refund truth | Payments app → **this repo** via webhook |

The contract is two edges only: (a) an outbound **checkout hand-off** (we send `programId`, buyer, price, publisher payout ref, a signed `reference`), and (b) an inbound **signed webhook** (`purchase`/`refund` for a `reference`). Everything else stays inside each repo.

## Data model (new)

```prisma
model ProgramPricing {
  id            String   @id @default(cuid())
  programId     String   @unique              // MarketplaceProgram.id
  model         String   @default("one_time") // one_time (v1); subscription/usage later
  priceCents    Int                            // >= 0; 0 is allowed (free but "priced")
  currency      String   @default("usd")
  active        Boolean  @default(true)        // publisher can unlist the price
  payoutAccountRef String?                      // opaque id in the payments app (publisher's payout account)
  takeRateBps   Int      @default(3000)         // platform cut, basis points (env default)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  program MarketplaceProgram @relation(fields: [programId], references: [id], onDelete: Cascade)
}

model Entitlement {
  id            String   @id @default(cuid())
  programId     String
  subjectType   String   @default("user")      // user | workspace (v1 = user)
  subjectId     String                          // userId (or workspaceSlug when workspace-scoped)
  status        String   @default("active")     // active | revoked
  source        String                          // purchase | grant | trial
  reference     String   @unique                // idempotency key = the checkout reference
  priceCents    Int?                            // captured at purchase (audit)
  currency      String?
  grantedAt     DateTime @default(now())
  revokedAt     DateTime?
  program MarketplaceProgram @relation(fields: [programId], references: [id], onDelete: Cascade)
  @@unique([programId, subjectType, subjectId])  // one live entitlement per subject+app
  @@index([programId]) @@index([subjectId])
}

model PaymentWebhookEvent {   // idempotency + audit for inbound webhooks
  id          String   @id @default(cuid())
  eventId     String   @unique                  // provider event id — dedupe
  type        String                            // purchase | refund
  reference   String
  payloadJson String
  processedAt DateTime @default(now())
}
```

`MarketplaceProgram` gains a back-relation to `ProgramPricing` (`pricing ProgramPricing?`) and `entitlements Entitlement[]`. No columns removed. A program with no `ProgramPricing` (or `active:false`, or `priceCents:0`) is **free** — behavior is identical to today.

## Flows

**Set price (publisher).** Owner/admin `POST /workspace/:slug/programs/:packageId/pricing` `{ priceCents, currency, payoutAccountRef }` → upsert `ProgramPricing`. Validated: non-negative integer cents, known currency, take-rate from env unless admin overrides. Free ⇔ no active pricing.

**Buy (buyer).** `POST /workspace/:slug/programs/:packageId/checkout` → if already entitled, `{ entitled: true }` (no-op). Else create a signed `reference`, return `{ checkoutUrl }` pointing at the payments app with `programId`, buyer, `priceCents`, `payoutAccountRef`, `reference`, and an HMAC signature. **Price is server-authoritative** — never trust a client-supplied amount.

**Confirm (webhook).** Payments app → `POST /api/internal/payments/webhook` with a signed body `{ eventId, type: purchase|refund, reference, ... }`. Verify signature (fail-closed), dedupe on `eventId` (`PaymentWebhookEvent`), then: `purchase` → upsert `Entitlement(active)`; `refund` → mark `revoked`. Idempotent and replay-safe.

**Install (paywall).** `install/route.js` calls `canInstall({ userId, program })`: free app → allow; paid app → allow only if an `active` `Entitlement` exists for the subject. On miss → `402 payment_required` with `{ priceCents, currency, checkoutUrl? }` so the UI shows Buy.

**Launch (re-check).** `[installId]/launch` (and the MCP launch path) re-check entitlement so a refund/revoke takes effect on next launch even if already installed.

## Security invariants (fail-closed)

- **Webhook signature verified** with a shared secret (`PAYMENTS_WEBHOOK_SECRET`); bad/missing signature → `401`, nothing written.
- **Idempotent**: `eventId` dedupe + unique `reference`; a replayed webhook is a no-op.
- **Server-authoritative price**: the charged amount is derived from `ProgramPricing`, never from the client. The hand-off `reference` binds `programId`+`subject`+`priceCents` under HMAC.
- **Entitlement is per-subject and unique**; a second purchase can't create a duplicate live grant.
- **Refund → revoke**; launch re-check enforces it.
- **Redaction**: `payoutAccountRef`, `takeRateBps`, and raw webhook payloads are never returned on public/member responses (allow-list serialization, same posture as scan/AI reports). Buyers see only `priceCents`/`currency`/`entitled`.
- **Fail-closed on config**: if a program is paid but billing env (`PAYMENTS_*`) is unset, install is denied (not silently free).

## Non-goals (v1)

Subscriptions, usage/metered billing, free trials, per-workspace/team licensing, multi-currency conversion, tax handling, proration, chargeback disputes. The `model` field + session metering hooks (`ProgramSession` start/end already recorded) leave room for these later without a rewrite.

## Testing strategy

Pure/unit (vitest, injected prisma) for: pricing validation, `canInstall` truth table (free vs paid × entitled/not/revoked), webhook verify+dedupe+grant/revoke idempotency, HMAC reference round-trip, redaction allow-list. Route tests for `pricing` / `checkout` / `webhook` / gated `install` + `launch`. No live payments dependency in tests.
