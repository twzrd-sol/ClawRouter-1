# PAYMENT_SETTLED_NO_COMPLETION — buyer-side recovery runbook

Audience: anyone whose agent or service signed an MPP payment (Tempo or Solana) and then
saw the call end without a completion. This is the `PaymentSettledNoCompletionError` path.

## What just happened

The MPP charge settles _before_ the upstream runs the model (Tempo), or the seller submits
the signed transaction itself (Solana). If the request ends badly **after** the payment was
signed:

- the rail throws `MppPaidNoCompletionError` (`error.name === "PaymentSettledNoCompletionError"`).
  It is never retried and never falls back to another model — a second call could pay twice.
- the proxy answers HTTP 502 `payment_settled_no_completion`. If the failure is detected
  in-stream after HTTP 200 headers were sent, the SSE stream ends with a
  `payment_settled_no_completion` marker instead (an in-stream error, not a new 502).
- the spend ledger keeps the spend with a note:
  `signed, no completion (HTTP <status>) ref mpp-<16 hex>`.
- the error carries `reference` (`mpp-<16 hex>`) — a hash of the signed payload, for disputes.

A broken or unfinished native streaming body is handled the same way: one credit row is
recorded and the stream ends with the marker. A healthy HTTP 200 response with a provider
error hidden inside is caught by `onNoCompletion` on the rail: one credit row, then the same
terminal error. Unsigned responses keep ordinary fallback behavior.

## Evidence tuple — keep this, not the response

```jsonc
{
  "reference": "mpp-<16 hex>", // sha256(signed payload); NOT a chain transaction hash
  "payer": "<wallet, or the tx signature you retained>",
  "challengeId": "<if your host retains it>",
  "amount": "<original base-unit integer string>",
  "ts": "<ISO-8601>",
  "reason": "http_<status> | transport_error | in_200_provider_error | stream_broken",
  "response_bytes": 0, // null if the body could not be read within the 1 MiB cap
  "body_sha256": "...", // null with response_bytes null
}
```

Solana rails with `receiptVerification` enabled also carry on the fulfillment row:
`receipt_reference_chain_verified`, `receipt_reference_finalized_slot`,
`receipt_reference_mismatch`, `receipt_reference_unverified_reason`,
`receipt_reference_local_acceptance`. A verified row proves **chain settlement**, not
content quality or delivery correctness — it is one more field for your dispute, not a
refund signal.

Tempo receipts are **not verified** by this package. The reference is a payload hash;
chain evidence exists only if the seller shares the settlement transaction hash, or a Tempo
RPC lookup (many nodes restrict queries) shows a payment to the recipient in the expected
block window. Absence of independent verification is not evidence of non-payment.

## Decision tree

1. **You control the seller** (integration you run, e.g. a TWZRD reference seller).
   The seller's own failure path owns reconciliation: the one-shot charge route records an
   owed credit (`data/credits.jsonl`) and returns 502; the session route attempts an
   idempotent channel credit and records an owed credit if that cannot be confirmed. Find
   your request in your client logs (request id / challenge id), then reconcile against
   those records — the credit owes you one request unit, not necessarily a refund.
2. **The seller is third-party.**
   You hold a payment reference and, at best, a chain record. There is no automatic
   recovery: contact the seller with `reference`, `challengeId`, `amount`, and any
   transaction signature; ask for a credit or refund. Expect silence more often than a
   refund — the ledger note is your receipt of the loss. Do not counter-pay to open
   negotiation.
3. **It was a test with a dummy or empty wallet.**
   Nothing to reconcile. Confirm the wallet shows no movement before closing the ticket.
4. **The task can be dropped.**
   Stop, record the tuple, and move on. This is the correct outcome more often than
   retry/spam.

## What you MUST NOT do

- Do not retry the same request — that is how one lost payment becomes two.
- Do not route the same request to a fallback model ("try sonnet instead"): the proxy will
  not, and your glue code must not either.
- Do not treat `reference` as settlement. `signed, sent`. `settled, verified` is a separate
  fact on Solana (opt-in), nonexistent on Tempo today.
- Do not log or persist raw receipt headers, challenge ids, or credentials while debugging —
  log the tuple only.
- Do not attempt to refund yourself from the seller's wallet through any automated path.

## Agent-side guard

```ts
if (error?.name === "PaymentSettledNoCompletionError") {
  store({ reference: error.reference /* …tuple… */ });
  surfaceToHuman({ reference /* … */ }); // never retry this request
}
```

## Related

- `packages/clawrouter-mpp/README.md` — "Credits for signed calls with no completion"
- `docs/echo-protocol.md` — opt-in Solana purchase binding (#21)
- `twzrd-x402-gate` — pre-sign refusals (`POLICY_MAX_AMOUNT` et al); the pre-sign twin of this
  path; both keep the buyer from paying when the decision is known bad
- `.twzrd/decisions.jsonl` / spend ledger notes — the buyer-side record you should retain

## Known limitations (as of 0.5.0)

- Both rails' credit and index ledgers are in-memory, one process, reset on restart.
- No cross-process dedup or durable replay index is supplied; callers needing one must
  supply durable, atomic storage.
- Tempo settlement verification is not implemented.
- Solana receipt verification is opt-in (`receiptVerification`), not the default.
- A verified settlement proves funds moved; it cannot prove what the model returned, or that
  the seller's delivery was honest. For delivery evidence, see the fulfillment rows
  (`twzrd.mpp.fulfillment.v3`, `response_bytes`, `body_sha256`).
