import { describe, expect, it } from "vitest";
import { fulfillPaidProof, ReplayRejectedError, SpentProofLedger } from "./spent-proof.js";

const TX = "tx-sig-1";
const CHALLENGE = "fixture-challenge-id";

describe("seller spent proof", () => {
  it("rejects a second use of the same tx signature and challenge and does not call the model", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    const first = await fulfillPaidProof({
      ledger,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    });
    expect(first).toBe("completion");
    const err = await fulfillPaidProof({
      ledger,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayRejectedError);
    expect((err as ReplayRejectedError).status).toBe(409);
    expect(calls).toBe(1);
  });

  it("gives concurrent duplicates one winner", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    const run = () =>
      fulfillPaidProof({ ledger, txSignature: TX, challengeId: CHALLENGE, upstream });
    const settled = await Promise.allSettled([run(), run()]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ReplayRejectedError);
    expect((lost[0] as PromiseRejectedResult).reason.status).toBe(409);
    expect(calls).toBe(1);
  });
});
