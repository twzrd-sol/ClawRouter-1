# T5: chain-verify the MPP receipt reference (design note)

Sources read: ClawRouter-1 `origin/claude/twzrd-fork` = `44faf073` (CR, `packages/clawrouter-mpp/src/`), wzrd-final `origin/main` = `659476ec` (WF, `packages/twzrd-agent-intel/src/twzrd_agent_intel/`). Money path; design only, no code.

## Goal
`receipt_reference` is copied from the seller's `Payment-Receipt` (CR `mpp-fulfillment-record.ts:309`) and documented as "not chain-verified here" (`:31`). `decodeReceiptObject` checks only shape: method, non-empty reference, `status == "success"`, timestamp (`:92-98`). When TWZRD sells, the reference is the settled Solana signature: `_settle_payment` sets `payment.settled_reference = sig` (WF `server_http.py:5781-5782`) and `_MppReceiptMiddleware` stamps it on 2xx (`:2219-2236`). Goal: an optional, fail-closed field saying whether that signature is a finalized USDC payment of the quoted amount to the quoted payee.

## Where the check runs
- **Buyer-side optional verifier hook (primary).** It is the only independent check. Asking TWZRD to confirm its own receipt is seller self-attestation.
- **TWZRD endpoint (secondary, labelled).** `GET /v1/receipts/by-tx/{sig}` (WF `server_http.py:8785`) and `/witness` (`:8639`) serve only TWZRD-ledger settlements, not a general RPC proxy (`:8645-8646`). A buyer may record its answer as `seller_attested`, never as `chain_verified`.
- Recommendation: both, with separate fields. Only the buyer's own fetch can set `receipt_reference_chain_verified`.

## Inputs
From the record and challenge (CR `mpp-gate.ts:22-43`, `mpp-fulfillment-record.ts:301-309`): `reference`, `network` (CAIP-2), `asset` (mint), `payTo` (owner wallet), `amountAtomic`, `challengeId`. Also `payer` (the buyer's own address, from `CreditFacts`, CR `mpp-paid-failure.ts:149`), needed for replay binding below.

## Checks (all must pass for `true`)
1. `reference` is base58 and decodes to 64 bytes.
2. `network` is Solana mainnet or devnet; the fetcher is for that cluster.
3. `getTransaction(reference, commitment=finalized)` returns non-null (same rule as WF `settlement_witness.py:278-279`).
4. `meta.err` is null (`settlement_witness.py:285-286`).
5. The transaction's first signature equals `reference` (same idea as `build_witness_ref`, `settlement_witness.py:115-117`).
6. Exactly one `transferChecked` instruction (outer and inner) with `mint == asset`, `destination == ATA(payTo, asset)`, and `tokenAmount.amount == amountAtomic`. Bare `transfer` is a mismatch. WF parsers accept both (`server_http.py:4488`, `aop_bind_settlement.py:174`), so this rule is stricter on purpose. ATA derivation has a WF precedent (`aop_bind_settlement.py:122`); the token program must come from the instruction, not a guess.
7. Payer binding: the matching transfer's `authority` equals the buyer's `payer`. Without it a seller can return any finalized payment of the same amount to itself.

## Output fields
- `receipt_reference_chain_verified`: `true | false | null`
- `receipt_reference_finalized_slot`: number or null (`slot` from getTransaction)
- `receipt_reference_mismatch`: null, or one of `bad_reference_format`, `wrong_network`, `signature_mismatch`, `tx_failed`, `no_matching_transfer`, `multiple_matching_transfers`, `amount_mismatch`, `mint_mismatch`, `payee_mismatch`, `payer_mismatch`, `reference_reused`
- `receipt_reference_unverified_reason`: null, or `rpc_unavailable`, `not_finalized`, `no_fetcher`, `non_solana`

Rule: an RPC failure, a timeout, a null result, no configured fetcher, or a non-Solana method gives `null` with a reason. It is never `true`. `false` only comes from a definitive on-chain answer that contradicts the inputs. This matches the WF split between "unavailable" and a definitive answer (`settlement_witness.py:189-210`). A `receipt_state` other than `valid_format` (CR `mpp-fulfillment-record.ts:28`) is never verified.

## Failure modes and replay
- **Same reference across records.** The seller dedupes by signature (`x402_payment_receipts` keyed by tx signature, WF `server_http.py:4137-4139`). The buyer has no equivalent today. The sink should keep a reference -> challengeId index: a second record with the same reference and a different challengeId gets `false/reference_reused`, even if the chain checks pass.
- **Borrowed payment.** Without check 7, another buyer's payment that matches on payee and amount would pass.
- **Local reference is not the chain reference.** `paymentReference` hashes the signed payload (`mpp-paid-failure.ts:145-147`), and the buyer signs with `broadcast: false` (`mpp-solana-fetch.ts:191`). The `mpp-<hash>` dispute reference never equals the receipt signature, so do not compare them.
- **Late finality.** The receipt can arrive before the transaction is finalized. The hook records `null/not_finalized` and leaves any retry to the caller. It must not block or delay the response (the record path is non-blocking, `mpp-fulfillment-record.ts:328-333`).

## Privacy and RPC cost
- The package ships no RPC URL and no key. The caller passes `verifyReference?: (facts) => Promise<Result>` or a `getTransaction` fetcher, matching the injectable-transport pattern (`mpp-solana-fetch.ts:4`, `:63-64`).
- Cost is one `getTransaction` per paid record, and only when the hook is configured.
- The fetch reveals interest in the signature to the buyer's RPC provider.
- WF's witness RPC selection (`settlement_witness.py:156-187`) is server-side and must not move into the package.

## Test plan
- Fixture verifier with a stub fetcher (no network). Use the mainnet x402 example in `~/ops-history/manual-checks/2026-11-06-trust-dogfood/trust.json`: tx `5Aetec1b...`, `proof.as_of_slot` 465968062, `proof.net_amount.raw` 50000, mint `EPjFWdd5...`. Capture its jsonParsed getTransaction once as a fixture. (x402, same transfer shape.)
- Cases: pass; `meta.err` set; null result -> `null/not_finalized`; fetcher throws -> `null/rpc_unavailable`; amount off by one; wrong mint; destination is the ATA of another owner; bare `transfer`; two matching transfers; first signature differs; authority is not the payer; same reference on two records -> `reference_reused`; no fetcher -> `null/no_fetcher`.
- Property: no input path gives `true` when the fetcher rejected or returned null.
- No live MPP check: it needs an operator-authorized payment.

## Open questions
1. Does the TWZRD MPP pull transaction carry the challenge `externalId` nonce on-chain (for example as a memo)? The flow comment names the nonce (WF `server_http.py:4130-4133`). If it is on-chain, matching it is a stronger binding than the payer check.
2. In pull mode the sponsor is fee payer, so the first signature is TWZRD's. Should check 5 also require the buyer's own signature to be present in `signatures`?
3. Should `transferChecked`-only be relaxed for sellers whose WF parsers accept bare `transfer`?
4. Where does the `reference_reused` index live: in the sink (caller) or in the package with a bounded in-memory map?
