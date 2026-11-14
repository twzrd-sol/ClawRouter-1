/**
 * The receipt chain verifier against two real Solana MPP charges on mainnet
 * (test/fixtures/mainnet-mpp-receipts.json).
 *
 * Offline by default: the fixture is the recorded finalized getTransaction result. Set
 * CLAWROUTER_MPP_LIVE_RPC to a Solana mainnet RPC URL to re-fetch both transactions and check
 * that the chain still returns the recorded bytes and that the verifier accepts them live.
 *
 * Neither payment retained the buyer's signed wire transaction, so this test rebuilds it from
 * the chain: the on-chain wire with the sponsor's fee-payer signature cleared, which is what the
 * buyer held before the seller co-signed. The message comparison (B1) therefore proves nothing
 * about what the buyer signed here; every transfer check (finalized, no error, one transferChecked,
 * trusted mint and decimals, payee ATA, amount, authority, source ATA) runs against real bytes.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import {
  createReceiptChainVerifier,
  InMemoryReceiptReferenceIndex,
  type ReceiptChainVerifyInput,
  type RpcTransaction,
} from "./receipt-chain-verify.js";
import { PostgresReceiptReferenceIndex } from "./replay-store.js";

type FixtureReceipt = {
  reference: string;
  paid_at: string;
  terms: {
    method: string;
    network: string;
    asset: string;
    payTo: string;
    amountAtomic: string;
    feePayerKey: string;
  };
  payer: string;
  getTransaction: RpcTransaction & { meta: NonNullable<RpcTransaction["meta"]> };
};

const fixture = JSON.parse(
  readFileSync(new URL("../test/fixtures/mainnet-mpp-receipts.json", import.meta.url), "utf8"),
) as { rpc_params: Record<string, unknown>; receipts: FixtureReceipt[] };

const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** The buyer's pre-co-sign copy: the on-chain wire with the fee payer's signature slot empty. */
function buyerRetainedWire(receipt: FixtureReceipt): string {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(receipt.getTransaction.transaction[0]),
  );
  const signatures = { ...decoded.signatures };
  const feePayer = receipt.terms.feePayerKey as Address;
  if (!(feePayer in signatures)) throw new Error("fixture fee payer is not a signer");
  signatures[feePayer] = null;
  return getBase64EncodedWireTransaction({ ...decoded, signatures });
}

function inputFor(receipt: FixtureReceipt, over: Partial<ReceiptChainVerifyInput> = {}) {
  return {
    reference: receipt.reference,
    method: receipt.terms.method,
    network: receipt.terms.network,
    asset: receipt.terms.asset,
    payTo: receipt.terms.payTo,
    amountAtomic: receipt.terms.amountAtomic,
    payer: receipt.payer,
    signedTransaction: buyerRetainedWire(receipt),
    signedAtUnix: receipt.getTransaction.blockTime,
    purchaseId: `purchase-${receipt.reference.slice(0, 8)}`,
    ...over,
  } satisfies ReceiptChainVerifyInput;
}

function verifierFrom(lookup: (sig: string) => Promise<RpcTransaction | null>) {
  return createReceiptChainVerifier({
    cluster: "mainnet",
    getTransaction: lookup,
    index: new InMemoryReceiptReferenceIndex(),
  });
}

const recorded = async (sig: string) =>
  fixture.receipts.find((r) => r.reference === sig)?.getTransaction ?? null;

describe("receipt chain verifier on recorded mainnet MPP charges", () => {
  it("the fixture holds two distinct finalized, successful charges", () => {
    expect(fixture.receipts).toHaveLength(2);
    expect(new Set(fixture.receipts.map((r) => r.reference)).size).toBe(2);
    for (const r of fixture.receipts) {
      expect(r.getTransaction.meta.err).toBeNull();
      expect(Array.isArray(r.getTransaction.meta.innerInstructions)).toBe(true);
    }
  });

  for (const receipt of fixture.receipts) {
    describe(receipt.reference.slice(0, 8), () => {
      it("verifies and accepts the receipt against the challenge terms", async () => {
        const verify = verifierFrom(recorded);
        const out = await verify(inputFor(receipt));
        expect(out).toEqual({
          receipt_reference_chain_verified: true,
          receipt_reference_finalized_slot: receipt.getTransaction.slot,
          receipt_reference_mismatch: null,
          receipt_reference_unverified_reason: null,
          receipt_reference_purchase_bound: null,
          receipt_reference_purchase_bound_reason: "no_buyer_nonce",
          receipt_reference_local_acceptance: "accepted",
          receipt_reference_refusal_reason: null,
        });
      });

      it("token balances on the same transaction agree: payer -amount, payee +amount", () => {
        const { preTokenBalances, postTokenBalances } = receipt.getTransaction.meta as unknown as {
          preTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[];
          postTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[];
        };
        const delta = (owner: string) => {
          const pick = (list: typeof preTokenBalances) =>
            BigInt(
              list.find((b) => b.owner === owner && b.mint === receipt.terms.asset)?.uiTokenAmount
                .amount ?? "0",
            );
          return pick(postTokenBalances) - pick(preTokenBalances);
        };
        const amount = BigInt(receipt.terms.amountAtomic);
        expect(delta(receipt.payer)).toBe(-amount);
        expect(delta(receipt.terms.payTo)).toBe(amount);
      });

      const refusals: [string, Partial<ReceiptChainVerifyInput>, string][] = [
        ["a different amount", { amountAtomic: "1001" }, "amount_mismatch"],
        ["a different payee", { payTo: fixture.receipts[0].terms.feePayerKey }, "payee_mismatch"],
        ["another trusted mint", { asset: USDT }, "mint_mismatch"],
        ["a devnet challenge", { network: "devnet", asset: DEVNET_USDC }, "wrong_network"],
        ["a payer that did not sign", { payer: receipt.terms.payTo }, "buyer_signature_missing"],
      ];
      for (const [label, over, mismatch] of refusals) {
        it(`refuses ${label}: ${mismatch}`, async () => {
          const out = await verifierFrom(recorded)(inputFor(receipt, over));
          expect(out.receipt_reference_chain_verified).toBe(false);
          expect(out.receipt_reference_mismatch).toBe(mismatch);
          expect(out.receipt_reference_local_acceptance).toBeNull();
        });
      }

      it("refuses the other charge's transaction under this reference: signature_mismatch", async () => {
        const other = fixture.receipts.find((r) => r.reference !== receipt.reference)!;
        const out = await verifierFrom(async () => other.getTransaction)(inputFor(receipt));
        expect(out.receipt_reference_mismatch).toBe("signature_mismatch");
      });

      it("refuses a retained copy whose message differs: message_mismatch", async () => {
        const other = fixture.receipts.find((r) => r.reference !== receipt.reference)!;
        const out = await verifierFrom(recorded)(
          inputFor(receipt, { signedTransaction: buyerRetainedWire(other) }),
        );
        expect(out.receipt_reference_mismatch).toBe("message_mismatch");
      });

      it("a second purchase cannot reuse the same reference", async () => {
        const verify = verifierFrom(recorded);
        expect((await verify(inputFor(receipt))).receipt_reference_local_acceptance).toBe(
          "accepted",
        );
        const again = await verify(inputFor(receipt, { purchaseId: "another-purchase" }));
        expect(again.receipt_reference_chain_verified).toBe(true);
        expect(again.receipt_reference_local_acceptance).toBe("refused");
        expect(again.receipt_reference_refusal_reason).toBe("reference_reused");
      });

      it("stays unverified, not accepted, when the RPC has not finalized it", async () => {
        const out = await verifierFrom(async () => null)(inputFor(receipt));
        expect(out.receipt_reference_chain_verified).toBeNull();
        expect(out.receipt_reference_unverified_reason).toBe("not_finalized");
        expect(out.receipt_reference_local_acceptance).toBeNull();
      });
    });
  }
});

describe("a durable index keeps a real receipt bound across a restart", () => {
  it("accepts once, then refuses another purchase after the database reopens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawrouter-mpp-ref-"));
    let db = new PGlite(dir);
    try {
      const query = (text: string, params: unknown[]) => db.query(text, params);
      const receipt = fixture.receipts[0];
      const index = new PostgresReceiptReferenceIndex({ query });
      await index.ensureSchema();
      const before = createReceiptChainVerifier({
        cluster: "mainnet",
        getTransaction: recorded,
        index,
      });
      expect((await before(inputFor(receipt))).receipt_reference_local_acceptance).toBe("accepted");

      await db.close();
      db = new PGlite(dir);
      const after = createReceiptChainVerifier({
        cluster: "mainnet",
        getTransaction: recorded,
        index: new PostgresReceiptReferenceIndex({ query }),
      });
      const reused = await after(inputFor(receipt, { purchaseId: "a-later-purchase" }));
      expect(reused.receipt_reference_chain_verified).toBe(true);
      expect(reused.receipt_reference_local_acceptance).toBe("refused");
      expect(reused.receipt_reference_refusal_reason).toBe("reference_reused");
      const same = await after(inputFor(receipt));
      expect(same.receipt_reference_local_acceptance).toBe("accepted");
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const LIVE_RPC = process.env.CLAWROUTER_MPP_LIVE_RPC;

describe.skipIf(!LIVE_RPC)("receipt chain verifier against a live mainnet RPC", () => {
  const live = async (sig: string, opts?: { signal?: AbortSignal }) => {
    const res = await fetch(LIVE_RPC!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [sig, fixture.rpc_params],
      }),
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
    const body = (await res.json()) as { result?: RpcTransaction | null; error?: unknown };
    if (body.error) throw new Error("rpc error");
    return body.result ?? null;
  };

  for (const receipt of fixture.receipts) {
    it(`${receipt.reference.slice(0, 8)}: chain bytes match the fixture and verify live`, async () => {
      const tx = await live(receipt.reference);
      expect(tx).not.toBeNull();
      expect(tx!.slot).toBe(receipt.getTransaction.slot);
      expect(tx!.transaction[0]).toBe(receipt.getTransaction.transaction[0]);
      const out = await verifierFrom(live)(inputFor(receipt));
      expect(out.receipt_reference_chain_verified).toBe(true);
      expect(out.receipt_reference_local_acceptance).toBe("accepted");
    }, 30_000);
  }
});
