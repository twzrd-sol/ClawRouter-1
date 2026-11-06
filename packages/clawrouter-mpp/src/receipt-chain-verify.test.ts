import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getProgramDerivedAddress,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import {
  createReceiptChainVerifier,
  DEFAULT_RPC_TIMEOUT_MS,
  InMemoryReceiptReferenceIndex,
  LANDING_WINDOW_SECONDS,
  type ReceiptChainVerifyInput,
  type RpcTransaction,
} from "./receipt-chain-verify.js";

afterEach(() => vi.useRealTimers());

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP7VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Blockhash;
const OTHER_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" as Blockhash;
const SIGNED_AT = 1_800_000_000;
const AMOUNT = 50_000n;

const enc = getAddressEncoder();
async function ata(owner: string, mint: string, program = TOKEN): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(program)), enc.encode(address(mint))],
  });
  return pda;
}

function u64(value: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
}

type Party = Awaited<ReturnType<typeof generateKeyPairSigner>>;
type Shape = {
  amount?: bigint;
  mint?: string;
  decimals?: number;
  program?: string;
  destOwner?: string;
  authority?: Party;
  bare?: boolean;
  extraTransfer?: boolean;
  blockhash?: Blockhash;
  /** Fee payer; defaults to the sponsor. */
  feePayer?: Party;
  /** Token account the transfer debits; defaults to the authority's ATA. */
  source?: Address;
};

async function transferIx(buyer: Party, payTo: string, s: Shape): Promise<Instruction> {
  const program = s.program ?? TOKEN;
  const mint = s.mint ?? USDC;
  const authority = s.authority ?? buyer;
  const source = s.source ?? (await ata(authority.address, mint, program));
  const dest = await ata(s.destOwner ?? payTo, mint, program);
  if (s.bare) {
    return {
      programAddress: address(program),
      accounts: [
        { address: source, role: AccountRole.WRITABLE },
        { address: dest, role: AccountRole.WRITABLE },
        { address: authority.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: new Uint8Array([3, ...u64(s.amount ?? AMOUNT)]),
    };
  }
  return {
    programAddress: address(program),
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: address(mint), role: AccountRole.READONLY },
      { address: dest, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([12, ...u64(s.amount ?? AMOUNT), s.decimals ?? 6]),
  };
}

/** Buyer partially signs (sponsor slot empty); seller adds the sponsor signature and broadcasts. */
async function payment(buyer: Party, sponsor: Party, payTo: string, s: Shape = {}) {
  const ixs = [await transferIx(buyer, payTo, s)];
  if (s.extraTransfer) ixs.push(await transferIx(buyer, payTo, { ...s, amount: 1n }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer((s.feePayer ?? sponsor).address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: s.blockhash ?? BLOCKHASH, lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const compiled = compileTransaction(message);
  const feePayer = s.feePayer ?? sponsor;
  const buyerSide = [buyer, s.authority].filter((x): x is Party => !!x && x !== feePayer);
  const unique = [...new Map(buyerSide.map((x) => [x.address, x])).values()];
  const buyerSigned = unique.length
    ? await partiallySignTransaction(
        unique.map((x) => x.keyPair),
        compiled,
      )
    : compiled;
  const full = await partiallySignTransaction([feePayer.keyPair], buyerSigned);
  const sponsorSig = full.signatures[feePayer.address]!;
  return {
    // What the buyer retains is the transaction after its own signature.
    retained: getBase64EncodedWireTransaction(feePayer === buyer ? full : buyerSigned),
    onChain: getBase64EncodedWireTransaction(full),
    reference: getBase58Decoder().decode(sponsorSig),
  };
}

function rpc(onChain: string, over: Partial<RpcTransaction> = {}): RpcTransaction {
  return {
    slot: 123,
    blockTime: SIGNED_AT + 1,
    meta: { err: null, innerInstructions: [] },
    transaction: [onChain, "base64"],
    ...over,
  };
}

async function setup() {
  const buyer = await generateKeyPairSigner();
  const sponsor = await generateKeyPairSigner();
  const payTo = (await generateKeyPairSigner()).address;
  return { buyer, sponsor, payTo };
}

function input(
  buyer: Party,
  payTo: string,
  p: { retained: string; reference: string },
  over: Partial<ReceiptChainVerifyInput> = {},
): ReceiptChainVerifyInput {
  return {
    reference: p.reference,
    method: "solana",
    network: "mainnet",
    asset: "USDC",
    payTo,
    amountAtomic: AMOUNT.toString(),
    payer: buyer.address,
    signedTransaction: p.retained,
    signedAtUnix: SIGNED_AT,
    purchaseId: "purchase-1",
    ...over,
  };
}

function verifier(tx: RpcTransaction | null | Error, extra: Record<string, unknown> = {}) {
  let calls = 0;
  const verify = createReceiptChainVerifier({
    cluster: "mainnet",
    index: new InMemoryReceiptReferenceIndex(),
    getTransaction: async () => {
      calls++;
      if (tx instanceof Error) throw tx;
      return tx;
    },
    ...extra,
  });
  return { verify, calls: () => calls };
}

describe("receipt chain verification", () => {
  it("verifies an honest sponsored payment and binds it to the purchase", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const { verify } = verifier(rpc(p.onChain));
    expect(await verify(input(buyer, payTo, p))).toEqual({
      receipt_reference_chain_verified: true,
      receipt_reference_finalized_slot: 123,
      receipt_reference_mismatch: null,
      receipt_reference_unverified_reason: null,
      receipt_reference_purchase_bound: null,
      receipt_reference_purchase_bound_reason: "no_buyer_nonce",
      receipt_reference_local_acceptance: "accepted",
      receipt_reference_refusal_reason: null,
    });
  });

  it("normalizes CAIP-2 network and a literal mint", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const { verify } = verifier(rpc(p.onChain));
    const r = await verify(
      input(buyer, payTo, p, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: USDC }),
    );
    expect(r.receipt_reference_chain_verified).toBe(true);
  });

  it("rejects a historical payment by the same buyer: different message", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const current = await payment(buyer, sponsor, payTo);
    const old = await payment(buyer, sponsor, payTo, { blockhash: OTHER_BLOCKHASH });
    const { verify } = verifier(rpc(old.onChain));
    const r = await verify(
      input(buyer, payTo, { retained: current.retained, reference: old.reference }),
    );
    expect(r.receipt_reference_chain_verified).toBe(false);
    expect(r.receipt_reference_mismatch).toBe("message_mismatch");
    expect(r.receipt_reference_local_acceptance).toBeNull();
    expect(r.receipt_reference_purchase_bound_reason).toBe("chain_unverified");
  });

  it("a replayed identical message reads verified; the age policy refuses it only when old", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const fresh = verifier(rpc(p.onChain, { blockTime: SIGNED_AT - 600 }));
    const inside = await fresh.verify(input(buyer, payTo, p));
    expect(inside.receipt_reference_chain_verified).toBe(true);
    expect(inside.receipt_reference_purchase_bound).toBeNull();
    expect(inside.receipt_reference_purchase_bound_reason).toBe("no_buyer_nonce");
    expect(inside.receipt_reference_local_acceptance).toBe("accepted");

    const stale = verifier(rpc(p.onChain, { blockTime: SIGNED_AT - 601 }));
    const outside = await stale.verify(input(buyer, payTo, p));
    expect(outside.receipt_reference_chain_verified).toBe(true);
    expect(outside.receipt_reference_mismatch).toBeNull();
    expect(outside.receipt_reference_local_acceptance).toBe("refused");
    expect(outside.receipt_reference_refusal_reason).toBe("stale_by_local_clock");
  });

  it("clock offset and landing delay inside the supported assumption are accepted", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    for (const offset of [0, 30, -30, 60, -60, 601, -601]) {
      for (const landing of [0, 2, 90]) {
        if (Math.abs(offset) > 60 && !(offset === 601 && landing === 2)) continue;
        // age = signed_at - blockTime = offset - landing
        const { verify } = verifier(rpc(p.onChain, { blockTime: SIGNED_AT - offset + landing }));
        const r = await verify(input(buyer, payTo, p));
        expect(r.receipt_reference_local_acceptance, `offset ${offset} landing ${landing}`).toBe(
          "accepted",
        );
      }
    }
    const { verify } = verifier(rpc(p.onChain, { blockTime: SIGNED_AT - 605 + 2 }));
    const r = await verify(input(buyer, payTo, p));
    expect(r.receipt_reference_refusal_reason).toBe("stale_by_local_clock");
    expect(r.receipt_reference_mismatch).toBeNull();
  });

  it("a null blockTime leaves the age policy silent", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const { verify } = verifier(rpc(p.onChain, { blockTime: null }));
    expect((await verify(input(buyer, payTo, p))).receipt_reference_local_acceptance).toBe(
      "accepted",
    );
  });

  it("refuses a reference already bound to another purchase; same purchase is idempotent", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const { verify } = verifier(rpc(p.onChain));
    expect((await verify(input(buyer, payTo, p))).receipt_reference_local_acceptance).toBe(
      "accepted",
    );
    expect((await verify(input(buyer, payTo, p))).receipt_reference_local_acceptance).toBe(
      "accepted",
    );
    const second = await verify(input(buyer, payTo, p, { purchaseId: "purchase-2" }));
    expect(second.receipt_reference_chain_verified).toBe(true);
    expect(second.receipt_reference_mismatch).toBeNull();
    expect(second.receipt_reference_local_acceptance).toBe("refused");
    expect(second.receipt_reference_refusal_reason).toBe("reference_reused");
  });

  it("concurrent binds of one reference: exactly one purchase is accepted", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const { verify } = verifier(rpc(p.onChain));
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((id) => verify(input(buyer, payTo, p, { purchaseId: id }))),
    );
    expect(results.filter((r) => r.receipt_reference_local_acceptance === "accepted")).toHaveLength(
      1,
    );
    expect(results.every((r) => r.receipt_reference_chain_verified === true)).toBe(true);
  });

  it("input failures are definitive and make no RPC call", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    for (const [over, code] of [
      [{ reference: "not-base58!" }, "bad_reference_format"],
      [{ reference: "11111111111111111111111111111111" }, "bad_reference_format"],
      [{ network: "devnet" }, "wrong_network"],
      [{ network: "eip155:8453" }, "wrong_network"],
    ] as const) {
      const v = verifier(rpc(p.onChain));
      const r = await v.verify(input(buyer, payTo, p, over));
      expect(r.receipt_reference_chain_verified).toBe(false);
      expect(r.receipt_reference_mismatch).toBe(code);
      expect(v.calls()).toBe(0);
    }
  });

  it("returns null with a reason when it cannot decide", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const cases: [ReturnType<typeof verifier>, Partial<ReceiptChainVerifyInput>, string][] = [
      [verifier(rpc(p.onChain)), { method: "tempo" }, "non_solana"],
      [verifier(rpc(p.onChain)), { signedTransaction: null }, "no_signed_transaction"],
      [verifier(rpc(p.onChain)), { hasSplits: true }, "splits_unsupported"],
      [verifier(rpc(p.onChain)), { asset: "PYUSD" }, "unnormalized_terms"],
      [verifier(rpc(p.onChain)), { amountAtomic: "0.05" }, "unnormalized_terms"],
      [verifier(null), {}, "not_finalized"],
      [verifier(new Error("timeout")), {}, "rpc_unavailable"],
      [verifier(rpc(p.onChain), { getTransaction: undefined }), {}, "no_fetcher"],
    ];
    for (const [v, over, reason] of cases) {
      const r = await v.verify(input(buyer, payTo, p, over));
      expect(r.receipt_reference_chain_verified, reason).toBeNull();
      expect(r.receipt_reference_unverified_reason).toBe(reason);
      expect(r.receipt_reference_mismatch).toBeNull();
      expect(r.receipt_reference_local_acceptance).toBeNull();
    }
  });

  it("an unverified reference does not occupy the index but is refused if another purchase owns it", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const index = new InMemoryReceiptReferenceIndex();
    const fail = createReceiptChainVerifier({
      cluster: "mainnet",
      index,
      getTransaction: async () => null,
    });
    await fail.call(null, input(buyer, payTo, p, { purchaseId: "x" }));
    expect(await index.owner(p.reference)).toBeUndefined();
    const ok = createReceiptChainVerifier({
      cluster: "mainnet",
      index,
      getTransaction: async () => rpc(p.onChain),
    });
    await ok(input(buyer, payTo, p, { purchaseId: "owner" }));
    const r = await fail(input(buyer, payTo, p, { purchaseId: "other" }));
    expect(r.receipt_reference_chain_verified).toBeNull();
    expect(r.receipt_reference_local_acceptance).toBe("refused");
    expect(r.receipt_reference_refusal_reason).toBe("reference_reused");
  });

  it("chain contradictions are mismatches", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const other = await generateKeyPairSigner();
    const honest = await payment(buyer, sponsor, payTo);
    const cases: [string, Shape, Partial<ReceiptChainVerifyInput>?][] = [
      ["amount_mismatch", { amount: AMOUNT - 1n }],
      ["mint_mismatch", { mint: USDT }],
      ["decimals_mismatch", { decimals: 9 }],
      ["payee_mismatch", { destOwner: other.address }],
      ["no_matching_transfer", { bare: true }],
      ["multiple_matching_transfers", { extraTransfer: true }],
      ["untrusted_token_program", { program: TOKEN_2022 }],
    ];
    for (const [code, shape, over] of cases) {
      const p = await payment(buyer, sponsor, payTo, shape);
      const { verify } = verifier(rpc(p.onChain));
      const r = await verify(input(buyer, payTo, p, over));
      expect(r.receipt_reference_chain_verified, code).toBe(false);
      expect(r.receipt_reference_mismatch, code).toBe(code);
      expect(r.receipt_reference_local_acceptance).toBeNull();
    }
    // The buyer signed (as fee payer) but another wallet's tokens moved: borrowed payment.
    const borrowed = await payment(buyer, sponsor, payTo, { authority: other, feePayer: buyer });
    const v = verifier(rpc(borrowed.onChain));
    const r = await v.verify(input(buyer, payTo, borrowed));
    expect(r.receipt_reference_chain_verified).toBe(false);
    expect(r.receipt_reference_mismatch).toBe("payer_mismatch");

    const failed = verifier(rpc(honest.onChain, { meta: { err: { InstructionError: [0, "x"] } } }));
    expect((await failed.verify(input(buyer, payTo, honest))).receipt_reference_mismatch).toBe(
      "tx_failed",
    );

    const untrusted = verifier(rpc(honest.onChain), { trustedMints: {} });
    expect((await untrusted.verify(input(buyer, payTo, honest))).receipt_reference_mismatch).toBe(
      "untrusted_mint",
    );
  });

  it("a reference that is not the first signature is a signature mismatch", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const otherPayment = await payment(buyer, sponsor, payTo, { blockhash: OTHER_BLOCKHASH });
    const { verify } = verifier(rpc(p.onChain));
    const r = await verify(input(buyer, payTo, p, { reference: otherPayment.reference }));
    expect(r.receipt_reference_mismatch).toBe("signature_mismatch");
  });

  it("a message signed by someone other than the buyer is buyer_signature_missing", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const stranger = await generateKeyPairSigner();
    const { verify } = verifier(rpc(p.onChain));
    const r = await verify(input(buyer, payTo, p, { payer: stranger.address }));
    expect(r.receipt_reference_mismatch).toBe("buyer_signature_missing");
  });

  it("a getTransaction that never settles is rpc_unavailable once rpcTimeoutMs passes; its signal aborts", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const signals: (AbortSignal | undefined)[] = [];
    const index = new InMemoryReceiptReferenceIndex();
    const verify = createReceiptChainVerifier({
      cluster: "mainnet",
      index,
      rpcTimeoutMs: 20,
      getTransaction: (_signature, options) => {
        signals.push(options?.signal);
        return new Promise<never>(() => {});
      },
    });
    const r = await verify(input(buyer, payTo, p));
    expect(r).toMatchObject({
      receipt_reference_chain_verified: null,
      receipt_reference_unverified_reason: "rpc_unavailable",
      receipt_reference_mismatch: null,
      receipt_reference_local_acceptance: null,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(await index.owner(p.reference)).toBeUndefined();
  });

  it("a fetcher that rejects when its signal aborts is also rpc_unavailable", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const verify = createReceiptChainVerifier({
      cluster: "mainnet",
      index: new InMemoryReceiptReferenceIndex(),
      rpcTimeoutMs: 20,
      getTransaction: (_signature, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
        ),
    });
    expect((await verify(input(buyer, payTo, p))).receipt_reference_unverified_reason).toBe(
      "rpc_unavailable",
    );
  });

  it("an answer inside the deadline is used and leaves no timer behind", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { verify } = verifier(rpc(p.onChain));
    const r = await verify(input(buyer, payTo, p));
    expect(r.receipt_reference_chain_verified).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses an rpcTimeoutMs that is not a usable timer at construction", () => {
    const index = new InMemoryReceiptReferenceIndex();
    for (const rpcTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "50"]) {
      expect(
        () =>
          createReceiptChainVerifier({
            cluster: "mainnet",
            index,
            rpcTimeoutMs: rpcTimeoutMs as number,
          }),
        String(rpcTimeoutMs),
      ).toThrow(TypeError);
    }
    expect(() =>
      createReceiptChainVerifier({ cluster: "mainnet", index, rpcTimeoutMs: 1 }),
    ).not.toThrow();
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(10_000);
  });

  it("rejects an age policy that cannot hold an honest payment at construction", () => {
    const index = new InMemoryReceiptReferenceIndex();
    expect(() =>
      createReceiptChainVerifier({
        cluster: "mainnet",
        index,
        maxAgeSeconds: 60 + LANDING_WINDOW_SECONDS,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createReceiptChainVerifier({
        cluster: "mainnet",
        index,
        maxAgeSeconds: 151,
        maxClockSkewSeconds: 60,
      }),
    ).not.toThrow();
  });

  it("no input path gives true when the fetcher rejected or returned null", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    for (const tx of [null, new Error("boom")] as const) {
      for (const over of [{}, { asset: USDC }, { network: "mainnet-beta" }, { purchaseId: "z" }]) {
        const { verify } = verifier(tx);
        expect(
          (await verify(input(buyer, payTo, p, over))).receipt_reference_chain_verified,
        ).not.toBe(true);
      }
    }
  });

  it("counts inner (CPI) token transfers", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(p.onChain)).messageBytes,
    );
    if (message.version !== 0) throw new Error("fixture must be v0");
    const outer = message.instructions[0];
    const innerOf = (data: Uint8Array) => ({
      programIdIndex: outer.programAddressIndex,
      accounts: [...(outer.accountIndices ?? [])],
      data: getBase58Decoder().decode(data),
    });
    const checked = new Uint8Array(outer.data ?? []);
    const bare = new Uint8Array([3, ...u64(AMOUNT)]);
    for (const [data, code] of [
      [checked, "multiple_matching_transfers"],
      [bare, "multiple_matching_transfers"],
    ] as const) {
      const { verify } = verifier(
        rpc(p.onChain, {
          meta: { err: null, innerInstructions: [{ index: 0, instructions: [innerOf(data)] }] },
        }),
      );
      const r = await verify(input(buyer, payTo, p));
      expect(r.receipt_reference_chain_verified).toBe(false);
      expect(r.receipt_reference_mismatch).toBe(code);
    }
    // Inner data that is not base58 is an RPC fault, never a verdict.
    const { verify } = verifier(
      rpc(p.onChain, {
        meta: {
          err: null,
          innerInstructions: [{ index: 0, instructions: [{ ...innerOf(checked), data: "0OIl" }] }],
        },
      }),
    );
    expect((await verify(input(buyer, payTo, p))).receipt_reference_unverified_reason).toBe(
      "rpc_unavailable",
    );
  });

  it("a result without innerInstructions is rpc_unavailable, not verified", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    for (const innerInstructions of [undefined, null]) {
      const { verify } = verifier(rpc(p.onChain, { meta: { err: null, innerInstructions } }));
      const r = await verify(input(buyer, payTo, p));
      expect(r.receipt_reference_chain_verified).toBeNull();
      expect(r.receipt_reference_unverified_reason).toBe("rpc_unavailable");
    }
  });

  it("a transfer from a token account other than the buyer's ATA is payer_mismatch", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const third = await generateKeyPairSigner();
    const p = await payment(buyer, sponsor, payTo, { source: await ata(third.address, USDC) });
    const { verify } = verifier(rpc(p.onChain));
    const r = await verify(input(buyer, payTo, p));
    expect(r.receipt_reference_chain_verified).toBe(false);
    expect(r.receipt_reference_mismatch).toBe("payer_mismatch");
  });

  it("a stale reference is refused without taking an index slot", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    const index = new InMemoryReceiptReferenceIndex();
    const stale = createReceiptChainVerifier({
      cluster: "mainnet",
      index,
      getTransaction: async () => rpc(p.onChain, { blockTime: SIGNED_AT - 601 }),
    });
    const r = await stale(input(buyer, payTo, p));
    expect(r.receipt_reference_refusal_reason).toBe("stale_by_local_clock");
    expect(await index.owner(p.reference)).toBeUndefined();
  });

  it("an inherited key is not a stablecoin symbol", async () => {
    const { buyer, sponsor, payTo } = await setup();
    const p = await payment(buyer, sponsor, payTo);
    for (const asset of ["__proto__", "constructor", "toString"]) {
      const { verify } = verifier(rpc(p.onChain));
      const r = await verify(input(buyer, payTo, p, { asset }));
      expect(r.receipt_reference_unverified_reason).toBe("unnormalized_terms");
    }
  });
});
