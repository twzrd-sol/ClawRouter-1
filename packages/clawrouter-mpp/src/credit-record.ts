/** In-memory credit row. No chain write and no signer. */

export type CreditEntry = {
  payer: string;
  amount: string;
  challengeId: string;
  reason: string;
};

export class CreditLedger {
  private readonly rows: CreditEntry[] = [];

  /** One row per payer and challenge. A retry returns the first row. */
  recordOnce(entry: CreditEntry): CreditEntry {
    const key = `${entry.payer}\0${entry.challengeId}`;
    const prior = this.rows.find((row) => `${row.payer}\0${row.challengeId}` === key);
    if (prior) return prior;
    this.rows.push({ ...entry });
    return this.rows[this.rows.length - 1];
  }

  read(): readonly CreditEntry[] {
    return this.rows;
  }
}

/** Pure read. Does not sign and does not add a row. */
export function readCredits(ledger: CreditLedger): readonly CreditEntry[] {
  return ledger.read();
}
