/**
 * Option A wiring: the Solana rail retains the signed wire transaction, then chain-verifies the
 * seller's receipt reference into the fulfillment row. Real @solana/mpp signing, offline; the seller
 * co-signs as fee payer, and getTransaction is a stub that returns what the seller "broadcast".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { Credential } from "mppx";
import {
  createSolanaMppFetch,
  solanaChargeDeps,
  SOLANA_DEVNET_USDC_MINT,
  type SolanaMppFetchOptions,
} from "./mpp-solana-fetch.js";
import type { MppIntegration } from "./mpp-gate.js";
import type { MppFulfillmentRecord } from "./mpp-fulfillment-record.js";
import {
  createReceiptChainVerifier,
  InMemoryReceiptReferenceIndex,
  type ReceiptChainVerify,
  type ReceiptChainVerifyInput,
  type RpcTransaction,
} from "./receipt-chain-verify.js";

const DEAD_RPC = "http://127.0.0.1:1";
const URL_ = "https://devnet.fixture.invalid/v1/chat/completions";
type Party = Awaited<ReturnType<typeof generateKeyPairSigner>>;

async function fixture(opts: { finalizeAfter?: number; rpcTimeoutMs?: number } = {}) {
  const buyer = await generateKeyPairSigner();
  const payee = await generateKeyPairSigner();
  const sponsor = await generateKeyPairSigner();
  const request = {
    amount: "750",
    currency: SOLANA_DEVNET_USDC_MINT,
    recipient: payee.address,
    methodDetails: {
      network: "devnet",
      decimals: 6,
      feePayer: true,
      feePayerKey: sponsor.address,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      recentBlockhash: "11111111111111111111111111111111",
    },
  };
  const header = (id: string) =>
    `Payment id="${id}", realm="fixture", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(request)).toString("base64url")}"`;

  const broadcast = new Map<string, string>();
  const retainedByBuyer: string[] = [];
  /** When set, the seller returns this reference instead of its own settlement. */
  let replayReference: string | undefined;
  let challengeId = "challenge-1";
  const seller = vi.fn(async (input: RequestInfo | URL) => {
    const authorization = (input as Request).headers.get("authorization");
    if (!authorization)
      return new Response("", {
        status: 402,
        headers: { "www-authenticate": header(challengeId) },
      });
    const proof = Credential.deserialize<{ type: string; transaction: string }>(authorization);
    retainedByBuyer.push(proof.payload.transaction);
    const decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(proof.payload.transaction),
    );
    const full = await partiallySignTransaction([sponsor.keyPair], decoded);
    const reference = getBase58Decoder().decode(full.signatures[sponsor.address]!);
    broadcast.set(reference, getBase64EncodedWireTransaction(full));
    const receipt = Buffer.from(
      JSON.stringify({
        method: "solana",
        reference: replayReference ?? reference,
        status: "success",
        timestamp: new Date().toISOString(),
      }),
    ).toString("base64url");
    return new Response(JSON.stringify({ model: "m", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json", "payment-receipt": receipt },
    });
  }) as unknown as typeof fetch;

  let lookups = 0;
  let hold: Promise<void> | undefined;
  const getTransaction = vi.fn(
    async (
      signature: string,
      _options?: { signal?: AbortSignal },
    ): Promise<RpcTransaction | null> => {
      lookups += 1;
      if (hold) await hold;
      if (opts.finalizeAfter !== undefined && lookups <= opts.finalizeAfter) return null;
      const wire = broadcast.get(signature);
      if (!wire) return null;
      return {
        slot: 777,
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, innerInstructions: [] },
        transaction: [wire, "base64"],
      };
    },
  );
  const real = createReceiptChainVerifier({
    cluster: "devnet",
    getTransaction,
    index: new InMemoryReceiptReferenceIndex(),
    ...(opts.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: opts.rpcTimeoutMs }),
  });
  const inputs: ReceiptChainVerifyInput[] = [];
  const verify: ReceiptChainVerify = Object.assign(
    async (input: ReceiptChainVerifyInput) => {
      inputs.push(input);
      return real(input);
    },
    { cluster: real.cluster },
  );

  const rows: MppFulfillmentRecord[] = [];
  const integration: MppIntegration = {
    twzrdMppIntegration: true,
    gate: async () => ({ disposition: "allow" }),
    onFulfillment: async (row) => {
      rows.push(row);
    },
    flush: async () => {},
  };
  const rail = (over: Partial<SolanaMppFetchOptions> = {}) =>
    createSolanaMppFetch({
      signer: buyer,
      rpcUrl: DEAD_RPC,
      network: "devnet",
      integration,
      fetch: seller,
      receiptVerification: { verify },
      ...over,
    });
  return {
    buyer: buyer as Party,
    rail,
    rows,
    inputs,
    retainedByBuyer,
    broadcast,
    getTransaction,
    verify,
    setChallengeId: (id: string) => (challengeId = id),
    replay: (reference: string) => (replayReference = reference),
    holdLookups: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

const send = (pay: Awaited<ReturnType<typeof createSolanaMppFetch>>) =>
  pay(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"model":"m"}',
  });

afterEach(() => vi.useRealTimers());

describe("Solana rail: receipt reference chain verification (fulfillment v3)", () => {
  it("retains the signed wire transaction and records a verified, accepted reference", async () => {
    const f = await fixture();
    const before = Math.floor(Date.now() / 1000);
    const pay = await f.rail();
    const res = await send(pay);
    expect(res.status).toBe(200);
    await pay.flush();
    expect(f.rows).toHaveLength(1);
    const [row] = f.rows;
    expect(row).toMatchObject({
      schema: "twzrd.mpp.fulfillment.v3",
      payment_method: "solana",
      receipt_state: "valid_format",
      receipt_reference_chain_verified: true,
      receipt_reference_finalized_slot: 777,
      receipt_reference_mismatch: null,
      receipt_reference_unverified_reason: null,
      receipt_reference_purchase_bound: null,
      receipt_reference_purchase_bound_reason: "no_buyer_nonce",
      receipt_reference_local_acceptance: "accepted",
      receipt_reference_refusal_reason: null,
    });
    const [input] = f.inputs;
    // What the rail retained is exactly what the buyer sent, not the seller's co-signed bytes.
    expect(input.signedTransaction).toBe(f.retainedByBuyer[0]);
    expect(input.signedTransaction).not.toBe(f.broadcast.get(row.receipt_reference!));
    expect(input.signedAtUnix).toBeGreaterThanOrEqual(before);
    expect(input.signedAtUnix).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(input).toMatchObject({
      reference: row.receipt_reference,
      method: "solana",
      network: "devnet",
      asset: SOLANA_DEVNET_USDC_MINT,
      amountAtomic: "750",
      payer: f.buyer.address,
      hasSplits: false,
      purchaseId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("refuses a second purchase that is answered with an earlier purchase's reference", async () => {
    const f = await fixture();
    const pay = await f.rail();
    await send(pay);
    await pay.flush();
    const first = f.rows[0].receipt_reference!;
    // Same terms under a new challenge id: the SDK signs a byte-identical message (design doc,
    // "B1 alone is not unique"), so chain facts verify, and only the reference index can refuse.
    f.setChallengeId("challenge-2");
    f.replay(first);
    await send(pay);
    await pay.flush();
    expect(f.inputs[0].purchaseId).not.toBe(f.inputs[1].purchaseId);
    expect(f.rows[1]).toMatchObject({
      receipt_reference: first,
      receipt_reference_chain_verified: true,
      receipt_reference_mismatch: null,
      receipt_reference_local_acceptance: "refused",
      receipt_reference_refusal_reason: "reference_reused",
    });
  });

  it("treats every send of one credential as one purchase", async () => {
    const f = await fixture();
    const pay = await f.rail();
    await Promise.all([send(pay), send(pay)]);
    await pay.flush();
    expect(f.rows).toHaveLength(2);
    expect(f.inputs[0].purchaseId).toBe(f.inputs[1].purchaseId);
    expect(f.rows.map((r) => r.receipt_reference_local_acceptance)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("records null/not_finalized with the default zero finality wait", async () => {
    const f = await fixture({ finalizeAfter: 5 });
    const pay = await f.rail();
    await send(pay);
    await pay.flush();
    expect(f.getTransaction).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({
      receipt_reference_chain_verified: null,
      receipt_reference_unverified_reason: "not_finalized",
      receipt_reference_purchase_bound_reason: "chain_unverified",
      receipt_reference_local_acceptance: null,
    });
  });

  it("re-checks a not-yet-finalized reference within finalityWaitMs", async () => {
    const f = await fixture({ finalizeAfter: 2 });
    const pay = await f.rail({
      receiptVerification: { verify: f.verify, finalityWaitMs: 1000, finalityPollMs: 5 },
    });
    await send(pay);
    await pay.flush();
    expect(f.getTransaction).toHaveBeenCalledTimes(3);
    expect(f.rows[0]).toMatchObject({
      receipt_reference_chain_verified: true,
      receipt_reference_local_acceptance: "accepted",
    });
  });

  it("delivers the response before verification finishes; flush waits for the row", async () => {
    const f = await fixture();
    const release = f.holdLookups();
    const pay = await f.rail();
    const res = await send(pay);
    expect(await res.json()).toEqual({ model: "m", choices: [] });
    await vi.waitFor(() => expect(f.getTransaction).toHaveBeenCalledTimes(1));
    expect(f.rows).toHaveLength(0);
    const flushed = pay.flush();
    release();
    await flushed;
    expect(f.rows[0].receipt_reference_chain_verified).toBe(true);
  });

  it("a lookup that never answers still lands the row as rpc_unavailable; the response is untouched", async () => {
    const f = await fixture({ rpcTimeoutMs: 25 });
    f.holdLookups(); // never released: the RPC hangs
    const pay = await f.rail({
      receiptVerification: { verify: f.verify, finalityWaitMs: 1000, finalityPollMs: 5 },
    });
    const res = await send(pay);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: "m", choices: [] });
    await pay.flush();
    expect(f.getTransaction).toHaveBeenCalledTimes(1);
    expect(f.getTransaction.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      receipt_reference_chain_verified: null,
      receipt_reference_finalized_slot: null,
      receipt_reference_mismatch: null,
      receipt_reference_unverified_reason: "rpc_unavailable",
      receipt_reference_purchase_bound_reason: "chain_unverified",
      receipt_reference_local_acceptance: null,
    });
  });

  it("refuses a verifier built for another cluster, or bad finality settings, at construction", async () => {
    const f = await fixture();
    const mainnet = createReceiptChainVerifier({
      cluster: "mainnet",
      index: new InMemoryReceiptReferenceIndex(),
    });
    await expect(f.rail({ receiptVerification: { verify: mainnet } })).rejects.toThrow(
      /built for mainnet, but the rail network is devnet/,
    );
    await expect(f.rail({ network: "localnet" })).rejects.toThrow(/rail network is localnet/);
    await expect(
      f.rail({ receiptVerification: { verify: (async () => ({})) as never } }),
    ).rejects.toThrow(/built for undefined/);
    await expect(
      f.rail({ receiptVerification: { verify: f.verify, finalityWaitMs: -1 } }),
    ).rejects.toThrow(/finalityWaitMs/);
    await expect(
      f.rail({ receiptVerification: { verify: f.verify, finalityPollMs: 0 } }),
    ).rejects.toThrow(/finalityPollMs/);
    await expect(f.rail({ receiptVerification: { verify: "nope" as never } })).rejects.toThrow(
      /createReceiptChainVerifier/,
    );
  });

  it("passes no signed transaction when the method never emits a signed event", async () => {
    const f = await fixture();
    const realLoad = solanaChargeDeps.load;
    const sdk = await realLoad();
    solanaChargeDeps.load = async () => ({
      ...sdk,
      charge: (params) => sdk.charge({ ...params, onProgress: undefined }),
    });
    try {
      const pay = await f.rail();
      await send(pay);
      await pay.flush();
    } finally {
      solanaChargeDeps.load = realLoad;
    }
    expect(f.inputs[0].signedTransaction).toBeNull();
    expect(f.inputs[0].signedAtUnix).toBeNull();
    expect(f.getTransaction).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({
      receipt_reference_chain_verified: null,
      receipt_reference_unverified_reason: "no_signed_transaction",
    });
  });

  it("leaves verification fields null when receiptVerification is omitted", async () => {
    const f = await fixture();
    const pay = await f.rail({ receiptVerification: undefined });
    await send(pay);
    await pay.flush();
    expect(f.getTransaction).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({
      receipt_reference_chain_verified: null,
      receipt_reference_unverified_reason: null,
      receipt_reference_local_acceptance: null,
    });
  });
});
