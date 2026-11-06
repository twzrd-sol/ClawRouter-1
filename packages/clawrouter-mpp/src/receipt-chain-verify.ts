/**
 * Buyer-side chain verification of a Solana MPP receipt reference (design: docs/receipt-chain-verify.md).
 *
 * Three independent results, each with its own reason: chain facts (from finalized chain bytes only),
 * purchase binding (always null/no_buyer_nonce today), and local acceptance (this sink's policy).
 * Local policy never changes a chain field. No RPC URL and no key ship here: the caller injects the
 * `getTransaction` fetcher and, for acceptance, a durable reference index.
 */
import { loadOptional } from "./mpp-optional.js";

export const SOLANA_KIT_RANGE = "~6.10.0";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP7VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const KNOWN_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
/** SPL Token instruction tags. */
const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;
/** A blockhash stays valid for about 150 slots, roughly 60-90 s. */
export const LANDING_WINDOW_SECONDS = 90;

const CLUSTER_IDS = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;
export type SolanaCluster = keyof typeof CLUSTER_IDS;

/** Stablecoin symbols the SDK resolves, per cluster (`@solana/mpp` 0.7.0 `client/Charge.js:111`). */
const SYMBOL_MINTS: Record<SolanaCluster, Record<string, string>> = {
  mainnet: { USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  devnet: { USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
};

export type TrustedMint = { decimals: number; tokenPrograms: readonly string[] };

/** Classic SPL Token USD mints with 6 decimals: USDC mainnet, USDC devnet, USDT mainnet. */
export const DEFAULT_TRUSTED_USD_MINTS: Readonly<Record<string, TrustedMint>> = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { decimals: 6, tokenPrograms: [TOKEN_PROGRAM] },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { decimals: 6, tokenPrograms: [TOKEN_PROGRAM] },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { decimals: 6, tokenPrograms: [TOKEN_PROGRAM] },
});

export type ChainMismatch =
  | "bad_reference_format"
  | "wrong_network"
  | "signature_mismatch"
  | "message_mismatch"
  | "buyer_signature_missing"
  | "untrusted_token_program"
  | "untrusted_mint"
  | "decimals_mismatch"
  | "tx_failed"
  | "no_matching_transfer"
  | "multiple_matching_transfers"
  | "amount_mismatch"
  | "mint_mismatch"
  | "payee_mismatch"
  | "payer_mismatch";

export type ChainUnverifiedReason =
  | "rpc_unavailable"
  | "not_finalized"
  | "no_fetcher"
  | "non_solana"
  | "no_signed_transaction"
  | "splits_unsupported"
  | "unnormalized_terms"
  | "unsupported_message_format";

export type ReceiptChainVerification = {
  receipt_reference_chain_verified: boolean | null;
  receipt_reference_finalized_slot: number | null;
  receipt_reference_mismatch: ChainMismatch | null;
  receipt_reference_unverified_reason: ChainUnverifiedReason | null;
  receipt_reference_purchase_bound: boolean | null;
  receipt_reference_purchase_bound_reason:
    "nonce_mismatch" | "no_buyer_nonce" | "chain_unverified" | null;
  receipt_reference_local_acceptance: "accepted" | "refused" | null;
  receipt_reference_refusal_reason: "reference_reused" | "stale_by_local_clock" | null;
};

/** Compiled inner instruction as returned by getTransaction with `encoding: "base64"`. */
export type RpcInnerInstruction = { programIdIndex: number; accounts: number[]; data: string };

/** The subset of a `getTransaction` (`encoding: "base64"`, finalized) result this verifier reads. */
export type RpcTransaction = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: RpcInnerInstruction[] }[] | null;
  } | null;
  transaction: [string, "base64"] | readonly [string, string];
};

/**
 * Must call getTransaction(signature, {commitment: "finalized", encoding: "base64",
 * maxSupportedTransactionVersion: 0}) on the configured cluster and return its result (null when
 * not found or not finalized). Throw on transport failure.
 */
export type GetFinalizedTransaction = (signature: string) => Promise<RpcTransaction | null>;

/**
 * Durable, atomic reference -> purchase_id index. `bind` returns true when this purchase owns the
 * reference (newly bound or already bound to the same purchase) and false when another purchase
 * holds it; exactly one concurrent binder may win. `owner` reads without binding.
 */
export type ReceiptReferenceIndex = {
  bind(reference: string, purchaseId: string): Promise<boolean>;
  owner(reference: string): Promise<string | undefined>;
};

/** In-memory index for tests and single-process demos. It forgets on restart, so it is not durable. */
export class InMemoryReceiptReferenceIndex implements ReceiptReferenceIndex {
  readonly #owners = new Map<string, string>();
  async bind(reference: string, purchaseId: string): Promise<boolean> {
    const current = this.#owners.get(reference);
    if (current === undefined) {
      this.#owners.set(reference, purchaseId);
      return true;
    }
    return current === purchaseId;
  }
  async owner(reference: string): Promise<string | undefined> {
    return this.#owners.get(reference);
  }
}

export type ReceiptChainVerifierConfig = {
  cluster: SolanaCluster;
  getTransaction?: GetFinalizedTransaction;
  index: ReceiptReferenceIndex;
  /** Trusted mint -> decimals and token programs. Defaults to DEFAULT_TRUSTED_USD_MINTS. */
  trustedMints?: Readonly<Record<string, TrustedMint>>;
  /** Default 600. Must exceed maxClockSkewSeconds + LANDING_WINDOW_SECONDS. */
  maxAgeSeconds?: number;
  /** Default 60. */
  maxClockSkewSeconds?: number;
};

export type ReceiptChainVerifyInput = {
  /** Seller's receipt reference: the settled transaction signature. */
  reference: string;
  /** MPP payment method; only "solana" is verified. */
  method: string;
  /** Challenge terms as the seller sent them. */
  network: string | null;
  asset: string | null;
  payTo: string | null;
  amountAtomic: string | null;
  /** True when the challenge carried split recipients. */
  hasSplits?: boolean;
  /** The buyer's own address. */
  payer: string;
  /** Base64 wire transaction from the rail's `signed` event, or null when not retained. */
  signedTransaction: string | null;
  /** Buyer clock (unix seconds) when the signed event fired. */
  signedAtUnix: number | null;
  /** Buyer-generated id of the logical purchase (not the seller's challenge id). */
  purchaseId: string;
};

type Kit = typeof import("@solana/kit");
const loadKit = () => loadOptional("@solana/kit", SOLANA_KIT_RANGE, () => import("@solana/kit"));

type TokenTransfer = {
  program: string;
  tag: number;
  accounts: string[];
  data: Uint8Array;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]);
  return value;
}

function clusterOf(network: string): SolanaCluster | undefined {
  if (network === "mainnet" || network === "mainnet-beta" || network === CLUSTER_IDS.mainnet)
    return "mainnet";
  if (network === "devnet" || network === CLUSTER_IDS.devnet) return "devnet";
  return undefined;
}

/** Build a verifier. Throws when the age policy cannot hold an honest payment. */
export function createReceiptChainVerifier(config: ReceiptChainVerifierConfig) {
  const maxAge = config.maxAgeSeconds ?? 600;
  const skew = config.maxClockSkewSeconds ?? 60;
  if (!Number.isFinite(maxAge) || !Number.isFinite(skew) || skew < 0) {
    throw new TypeError("maxAgeSeconds and maxClockSkewSeconds must be finite; skew must be >= 0");
  }
  if (maxAge <= skew + LANDING_WINDOW_SECONDS) {
    throw new RangeError(
      `maxAgeSeconds (${maxAge}) must exceed maxClockSkewSeconds (${skew}) + the ${LANDING_WINDOW_SECONDS} s landing window`,
    );
  }
  if (!config.index) throw new TypeError("a ReceiptReferenceIndex is required");
  const trusted = config.trustedMints ?? DEFAULT_TRUSTED_USD_MINTS;
  const cluster = config.cluster;
  if (!(cluster in CLUSTER_IDS)) throw new TypeError(`unknown cluster ${String(cluster)}`);

  return async function verify(input: ReceiptChainVerifyInput): Promise<ReceiptChainVerification> {
    const chain = await chainFacts(input);
    const verified = chain.receipt_reference_chain_verified;
    const purchase: Pick<
      ReceiptChainVerification,
      "receipt_reference_purchase_bound" | "receipt_reference_purchase_bound_reason"
    > =
      verified === true
        ? {
            receipt_reference_purchase_bound: null,
            receipt_reference_purchase_bound_reason: "no_buyer_nonce",
          }
        : {
            receipt_reference_purchase_bound: null,
            receipt_reference_purchase_bound_reason: "chain_unverified",
          };

    // Local policy. It never changes a chain field.
    let refusal: ReceiptChainVerification["receipt_reference_refusal_reason"] = null;
    if (
      chain.blockTime !== null &&
      input.signedAtUnix !== null &&
      Number.isFinite(input.signedAtUnix) &&
      input.signedAtUnix - chain.blockTime > maxAge
    ) {
      refusal = "stale_by_local_clock";
    }
    if (verified === true) {
      // Bind only verified references, so an unverified one cannot occupy the index.
      const owns = await config.index.bind(input.reference, input.purchaseId);
      if (!owns) refusal = "reference_reused";
    } else {
      const owner = await config.index.owner(input.reference);
      if (owner !== undefined && owner !== input.purchaseId) refusal = "reference_reused";
    }
    const acceptance = refusal ? "refused" : verified === true ? "accepted" : null;
    return {
      receipt_reference_chain_verified: verified,
      receipt_reference_finalized_slot: chain.receipt_reference_finalized_slot,
      receipt_reference_mismatch: chain.receipt_reference_mismatch,
      receipt_reference_unverified_reason: chain.receipt_reference_unverified_reason,
      ...purchase,
      receipt_reference_local_acceptance: acceptance,
      receipt_reference_refusal_reason: refusal,
    };
  };

  type Chain = Pick<
    ReceiptChainVerification,
    | "receipt_reference_chain_verified"
    | "receipt_reference_finalized_slot"
    | "receipt_reference_mismatch"
    | "receipt_reference_unverified_reason"
  > & { blockTime: number | null };

  function result(
    verified: boolean | null,
    code: ChainMismatch | ChainUnverifiedReason | null,
    slot: number | null = null,
    blockTime: number | null = null,
  ): Chain {
    return {
      receipt_reference_chain_verified: verified,
      receipt_reference_finalized_slot: slot,
      receipt_reference_mismatch: verified === false ? (code as ChainMismatch) : null,
      receipt_reference_unverified_reason:
        verified === null ? (code as ChainUnverifiedReason) : null,
      blockTime,
    };
  }

  async function chainFacts(input: ReceiptChainVerifyInput): Promise<Chain> {
    if (input.method !== "solana") return result(null, "non_solana");
    const kit: Kit = await loadKit();
    const base58 = kit.getBase58Encoder();

    // Check 1: definitive input failure, no RPC.
    let referenceBytes: Uint8Array;
    try {
      referenceBytes = new Uint8Array(base58.encode(input.reference));
    } catch {
      return result(false, "bad_reference_format");
    }
    if (referenceBytes.length !== 64) return result(false, "bad_reference_format");
    // Check 2.
    const challengeCluster = input.network ? clusterOf(input.network) : undefined;
    if (challengeCluster !== cluster) return result(false, "wrong_network");

    if (input.hasSplits) return result(null, "splits_unsupported");
    if (!input.signedTransaction) return result(null, "no_signed_transaction");

    // Normalize seller terms with the rail's rules; keep raw terms out of the comparison.
    const asset = input.asset ? (SYMBOL_MINTS[cluster][input.asset] ?? input.asset) : null;
    if (!asset || !kit.isAddress(asset)) return result(null, "unnormalized_terms");
    if (!input.payTo || !kit.isAddress(input.payTo)) return result(null, "unnormalized_terms");
    if (!kit.isAddress(input.payer)) return result(null, "unnormalized_terms");
    if (!input.amountAtomic || !/^\d+$/.test(input.amountAtomic))
      return result(null, "unnormalized_terms");

    let retained: { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> };
    try {
      retained = decodeWire(kit, input.signedTransaction);
    } catch {
      return result(null, "no_signed_transaction");
    }

    if (!config.getTransaction) return result(null, "no_fetcher");
    let tx: RpcTransaction | null;
    try {
      tx = await config.getTransaction(input.reference);
    } catch {
      return result(null, "rpc_unavailable");
    }
    if (!tx) return result(null, "not_finalized");
    const slot = typeof tx.slot === "number" ? tx.slot : null;
    const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;
    const at = (verified: boolean | null, code: ChainMismatch | ChainUnverifiedReason | null) =>
      result(verified, code, slot, blockTime);
    if (!tx.meta) return at(null, "rpc_unavailable");

    // Check 4.
    if (tx.meta.err !== null && tx.meta.err !== undefined) return at(false, "tx_failed");

    let onChain: { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> };
    try {
      onChain = decodeWire(kit, tx.transaction[0]);
    } catch {
      return at(null, "rpc_unavailable");
    }
    // Check 5: the first signature is the reference.
    const firstSignature = Object.values(onChain.signatures)[0];
    if (!firstSignature || !bytesEqual(firstSignature, referenceBytes))
      return at(false, "signature_mismatch");
    // B1 / B3: byte-identical message, carrying the buyer's own signature.
    if (!bytesEqual(onChain.messageBytes, retained.messageBytes))
      return at(false, "message_mismatch");
    const buyerRetained = retained.signatures[input.payer];
    const buyerOnChain = onChain.signatures[input.payer];
    if (!buyerRetained || !buyerOnChain || !bytesEqual(buyerRetained, buyerOnChain)) {
      return at(false, "buyer_signature_missing");
    }

    const message = kit.getCompiledTransactionMessageDecoder().decode(onChain.messageBytes);
    // The SDK builds v0 without lookup tables; resolving looked-up accounts is not supported.
    if (message.version !== "legacy" && message.version !== 0) {
      return at(null, "unsupported_message_format");
    }
    const lookups = (message as { addressTableLookups?: readonly unknown[] }).addressTableLookups;
    if (lookups && lookups.length > 0) return at(null, "unsupported_message_format");
    const keys = message.staticAccounts.map(String);
    const transfers: TokenTransfer[] = [];
    const consider = (
      programIndex: number,
      accountIndexes: readonly number[],
      data: Uint8Array,
    ) => {
      const program = keys[programIndex];
      if (!program || !KNOWN_TOKEN_PROGRAMS.has(program) || data.length === 0) return;
      if (data[0] !== IX_TRANSFER && data[0] !== IX_TRANSFER_CHECKED) return;
      transfers.push({ program, tag: data[0], accounts: accountIndexes.map((i) => keys[i]), data });
    };
    for (const ix of message.instructions) {
      consider(ix.programAddressIndex, ix.accountIndices ?? [], new Uint8Array(ix.data ?? []));
    }
    const base58Bytes = kit.getBase58Encoder();
    for (const group of tx.meta.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        let data: Uint8Array;
        try {
          data = new Uint8Array(base58Bytes.encode(ix.data));
        } catch {
          return at(null, "rpc_unavailable");
        }
        consider(ix.programIdIndex, ix.accounts, data);
      }
    }

    // Checks 6, 6a and 7: exactly one transferChecked, judged against trusted configuration.
    const checked = transfers.filter((t) => t.tag === IX_TRANSFER_CHECKED);
    if (checked.length === 0) return at(false, "no_matching_transfer");
    if (checked.length > 1 || transfers.length > 1) return at(false, "multiple_matching_transfers");
    const [transfer] = checked;
    if (transfer.data.length < 10 || transfer.accounts.length < 4)
      return at(false, "no_matching_transfer");
    const [, mint, destination, authority] = transfer.accounts;
    const trust = Object.prototype.hasOwnProperty.call(trusted, asset) ? trusted[asset] : undefined;
    if (!trust) return at(false, "untrusted_mint");
    if (!trust.tokenPrograms.includes(transfer.program))
      return at(false, "untrusted_token_program");
    if (mint !== asset) return at(false, "mint_mismatch");
    if (transfer.data[9] !== trust.decimals) return at(false, "decimals_mismatch");
    const [expectedDestination] = await kit.getProgramDerivedAddress({
      programAddress: kit.address(ASSOCIATED_TOKEN_PROGRAM),
      seeds: [
        kit.getAddressEncoder().encode(kit.address(input.payTo)),
        kit.getAddressEncoder().encode(kit.address(transfer.program)),
        kit.getAddressEncoder().encode(kit.address(asset)),
      ],
    });
    if (destination !== expectedDestination) return at(false, "payee_mismatch");
    if (readU64(transfer.data, 1) !== BigInt(input.amountAtomic))
      return at(false, "amount_mismatch");
    if (authority !== input.payer) return at(false, "payer_mismatch");
    return at(true, null);
  }
}

function decodeWire(
  kit: Kit,
  base64: string,
): { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> } {
  const bytes = kit.getBase64Encoder().encode(base64);
  const decoded = kit.getTransactionDecoder().decode(bytes);
  const signatures: Record<string, Uint8Array | null> = {};
  for (const [addr, sig] of Object.entries(decoded.signatures)) {
    signatures[addr] = sig ? new Uint8Array(sig) : null;
  }
  return { messageBytes: new Uint8Array(decoded.messageBytes), signatures };
}
