/**
 * Seller-side spent-proof claims.
 *
 * A proof is one payment transaction signature plus one challenge id.
 * The buyer's 402 followed by the authorized retry is one proof: the 402
 * carries no transaction signature, so it never claims a slot.
 *
 * `SpentProofLedger` keeps claims in memory. For claims that survive a restart and are shared by
 * every process, use `PostgresSpentProofStore` or `RedisSpentProofStore` (replay-store.ts).
 */

export class ReplayRejectedError extends Error {
  readonly status = 409;
  readonly code = "proof_replayed";
  constructor(
    readonly networkId: string,
    readonly txSignature: string,
    readonly challengeId: string,
  ) {
    super("payment transaction or challenge already used on this network");
    this.name = "ReplayRejectedError";
  }
}

/**
 * Claims one proof. Resolves true when neither the (network, transaction) nor the
 * (network, challenge) pair was claimed before and this call now holds both; false otherwise.
 * Exactly one of any set of concurrent claims for overlapping pairs may resolve true, and a true
 * claim must already be stored when it resolves. A claim that throws holds nothing for the caller.
 */
export type SpentProofStore = {
  claim(networkId: string, txSignature: string, challengeId: string): boolean | Promise<boolean>;
};

export function assertProofIds(networkId: string, txSignature: string, challengeId: string): void {
  for (const value of [networkId, txSignature, challengeId]) {
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError("network id, transaction signature, and challenge id are required");
  }
}

/** In-memory claims for one process. A restart forgets them. */
export class SpentProofLedger implements SpentProofStore {
  private readonly transactions = new Map<string, string>();
  private readonly challenges = new Map<string, string>();

  claim(networkId: string, txSignature: string, challengeId: string): boolean {
    assertProofIds(networkId, txSignature, challengeId);
    const transactionKey = JSON.stringify([networkId, txSignature]);
    const challengeKey = JSON.stringify([networkId, challengeId]);
    // A verified transaction is one spend, and a challenge is one fulfillment.
    // Check both indexes before mutating either so rejected claims remain atomic.
    if (this.transactions.has(transactionKey) || this.challenges.has(challengeKey)) return false;
    this.transactions.set(transactionKey, challengeId);
    this.challenges.set(challengeKey, txSignature);
    return true;
  }
}

/**
 * Accept one paid proof and call the model at most once per proof.
 * The store's claim is atomic, so overlapping calls yield one winner; the in-memory ledger's
 * claim is synchronous. A claim that throws (store unreachable) rejects before `upstream` runs.
 */
export async function fulfillPaidProof<T>(opts: {
  ledger: SpentProofStore;
  networkId: string;
  txSignature: string;
  challengeId: string;
  upstream: () => Promise<T>;
}): Promise<T> {
  const won = await opts.ledger.claim(opts.networkId, opts.txSignature, opts.challengeId);
  if (won !== true)
    throw new ReplayRejectedError(opts.networkId, opts.txSignature, opts.challengeId);
  return opts.upstream();
}
