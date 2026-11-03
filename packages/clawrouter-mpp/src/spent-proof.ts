/**
 * Seller-side spent-proof ledger. In memory only.
 *
 * A proof is one payment transaction signature plus one challenge id.
 * The buyer's 402 followed by the authorized retry is one proof: the 402
 * carries no transaction signature, so it never claims a slot.
 */

export class ReplayRejectedError extends Error {
  readonly status = 409;
  readonly code = "proof_replayed";
  constructor(
    readonly txSignature: string,
    readonly challengeId: string,
  ) {
    super("payment proof already used for this challenge");
    this.name = "ReplayRejectedError";
  }
}

export class SpentProofLedger {
  private readonly spent = new Set<string>();

  claim(txSignature: string, challengeId: string): boolean {
    const key = `${txSignature}\0${challengeId}`;
    if (this.spent.has(key)) return false;
    this.spent.add(key);
    return true;
  }
}

/**
 * Accept one paid proof and call the model at most once.
 * The claim is synchronous, so two overlapping calls yield one winner.
 */
export async function fulfillPaidProof<T>(opts: {
  ledger: SpentProofLedger;
  txSignature: string;
  challengeId: string;
  upstream: () => Promise<T>;
}): Promise<T> {
  const won = opts.ledger.claim(opts.txSignature, opts.challengeId);
  if (!won) throw new ReplayRejectedError(opts.txSignature, opts.challengeId);
  return opts.upstream();
}
