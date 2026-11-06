# Echo Protocol for Solana MPP

The buyer sends fresh entropy and a cooperating seller reflects it in the signed challenge.
The existing `@solana/mpp` 0.7.0 client writes `request.externalId` as an SPL Memo; no unsolicited
instruction or SDK modification is needed. This PR implements the buyer only. A seller must
implement reflection separately; no production endpoint is changed by this work.

## Enable on the buyer

```ts
const payFetch = await createSolanaMppFetch({
  signer,
  rpcUrl,
  network: "devnet",
  integration,
  echo: { requireBinding: true },
  receiptVerification: { verify },
});
```

Omitting `echo` preserves existing behavior, including sellers that issue their own `externalId`.
`echo: {}` enables reflection with an unbound fallback; `requireBinding` defaults to false within
Echo mode. Requiring reflection is a pre-sign check, not a substitute for enabling receipt
verification. Neither option verifies a model or computation.

Each call generates 16 cryptographically random bytes, represented by 32 lowercase hex characters,
and sends them as `X-Buyer-Nonce`. It replaces any caller-provided nonce while preserving the other
request headers. The same nonce travels with the authenticated retry. Concurrent calls have
separate expectations and cannot share a cached credential across nonces.

## Seller reflection

Read `X-Buyer-Nonce` on the request that earns the 402. If it matches `^[0-9a-fA-F]{32}$`, set
`challenge.request.externalId` to `twzrd:p:<exact-header-value>` before issuing/signing the challenge.
Preserve the value's case. Missing or invalid headers must not be reflected; the seller may omit
`externalId`. A seller-issued unrelated `externalId` is incompatible with Echo mode and is refused.

For example, the challenge request includes:

```json
{
  "amount": "750",
  "currency": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "recipient": "<seller-wallet>",
  "methodDetails": { "network": "devnet", "decimals": 6 },
  "externalId": "twzrd:p:4f8a7e2b1c3d0e9f8a7b6c5d4e3f2a10"
}
```

The SDK creates the memo requested by that challenge and the seller's existing instruction
allowlist can validate it. This is Solana-only; infer-mpp's Tempo route is not implemented here.

## Two checks

Before signing, an exact reflected `externalId` is accepted. A missing value proceeds unbound
unless `requireBinding` is true (`REJECTED_UNBOUND_CHALLENGE`). Any present mismatch, including an
empty string, produces `SECURITY_VIOLATION` with zero signatures. Existing gate and spending
checks still apply before signing.

After a finalized receipt passes all chain checks, including equality with the retained buyer
message, the verifier inspects the message's top-level SPL Memo instructions:

| Condition                                                | purchase_bound | reason           |
| -------------------------------------------------------- | -------------- | ---------------- |
| One memo exactly matching the retained buyer expectation | true           | null             |
| No buyer expectation or no memo                          | null           | no_buyer_nonce   |
| Different bytes, malformed UTF-8, or multiple memos      | false          | nonce_mismatch   |
| Chain not verified                                       | null           | chain_unverified |

The decoder rejects malformed UTF-8 and preserves a leading BOM so it cannot silently make
different bytes match. The memo program is `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.

Chain facts, purchase binding, and local acceptance remain separate fields. The reference index
still enforces local reuse policy and must be durable and atomic across workers if required.
`purchase_bound: true` ties a payment message to buyer-generated call entropy. It does not prove
the model identity, execution, or response correctness. Response hashing and inclusion anchoring
remain separate evidence. No live payment or seller deployment is part of this PR.
