import { describe, expect, it } from "vitest";

import {
  A2A_PAYMENT_METADATA,
  A2APaymentError,
  type A2ASignedPayment,
  A2AX402Client,
  A2AX402Merchant,
  CAIP2_BASE,
  InMemorySpendControlStorage,
  SpendControl,
  createHmacA2ASigner,
  createHmacA2AVerifier,
  createPaymentSubmissionMessage,
  echoA2AExtension,
  getA2AExtensionDeclaration,
  hasA2AExtension,
} from "./index.js";

const SECRET = "a2a-test-secret";
const REQUIREMENT = {
  scheme: "exact",
  network: CAIP2_BASE,
  asset: "USDC",
  payTo: "0x1111111111111111111111111111111111111111",
  amount: "10000",
  resource: "https://merchant.example/report",
  maxTimeoutSeconds: 60,
};

function control(now: () => number): SpendControl {
  return new SpendControl({ storage: new InMemorySpendControlStorage(), now });
}

describe("A2A x402 compatibility flow", () => {
  it("completes payment-required → submitted → receipt with task correlation", async () => {
    const clock = 1_700_000_000_000;
    const merchant = new A2AX402Merchant({
      verifier: createHmacA2AVerifier(SECRET),
      now: () => clock,
    });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => clock),
      now: () => clock,
      nonce: () => "nonce-1",
    });
    const task = merchant.createTask("task-1", { x402Version: 1, accepts: [REQUIREMENT] });

    expect(task.status.state).toBe("input-required");
    expect(task.status.message?.metadata[A2A_PAYMENT_METADATA.status]).toBe("payment-required");
    const submission = await client.createPaymentSubmission(task);
    expect(submission.taskId).toBe("task-1");
    expect(submission.metadata[A2A_PAYMENT_METADATA.status]).toBe("payment-submitted");

    const completed = await merchant.receivePayment(submission);
    expect(completed.status.state).toBe("completed");
    expect(completed.status.message?.metadata[A2A_PAYMENT_METADATA.status]).toBe("payment-completed");
    expect(completed.status.message?.metadata[A2A_PAYMENT_METADATA.receipts]).toEqual([
      { success: true, network: CAIP2_BASE, transaction: "a2a-memory-nonce-1" },
    ]);
  });

  it("selects a non-default payment option and binds it to the task", async () => {
    const clock = 1_700_000_000_000;
    const second = { ...REQUIREMENT, network: "solana:mainnet", payTo: "So11111111111111111111111111111111111111112" };
    const merchant = new A2AX402Merchant({ verifier: createHmacA2AVerifier(SECRET), now: () => clock });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => clock),
      now: () => clock,
      nonce: () => "second-option",
    });
    const task = merchant.createTask("multi-option", { x402Version: 1, accepts: [REQUIREMENT, second] });
    const completed = await merchant.receivePayment(await client.createPaymentSubmission(task, 1));
    expect(completed.status.state).toBe("completed");
    expect(completed.status.message?.metadata[A2A_PAYMENT_METADATA.receipts]).toEqual([
      { success: true, network: "solana:mainnet", transaction: "a2a-memory-second-option" },
    ]);
  });

  it("enforces ClawRouter policy before the signer runs", async () => {
    const spend = control(() => 1_700_000_000_000);
    spend.setPolicy("blockedPayees", [REQUIREMENT.payTo]);
    let signerCalls = 0;
    const client = new A2AX402Client({
      spendControl: spend,
      signer: async () => {
        signerCalls += 1;
        return { payment: { x402Version: 1, scheme: "exact", network: CAIP2_BASE, payload: {} }, signature: "x" };
      },
      now: () => 1_700_000_000_000,
    });
    const merchant = new A2AX402Merchant({ verifier: createHmacA2AVerifier(SECRET), now: () => 1_700_000_000_000 });
    const task = merchant.createTask("blocked", { x402Version: 1, accepts: [REQUIREMENT] });

    await expect(client.createPaymentSubmission(task)).rejects.toThrow(/blocked by policy/i);
    expect(signerCalls).toBe(0);
  });

  it("refuses expired requirements before signing", async () => {
    const merchant = new A2AX402Merchant({ verifier: createHmacA2AVerifier(SECRET), now: () => 1_000 });
    const task = merchant.createTask("expired", { x402Version: 1, accepts: [{ ...REQUIREMENT, maxTimeoutSeconds: 1 }] });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => 2_001),
      now: () => 2_001,
    });

    const err = await client.createPaymentSubmission(task).catch((value: unknown) => value);
    expect(err).toBeInstanceOf(A2APaymentError);
    expect((err as A2APaymentError).code).toBe("EXPIRED_PAYMENT");
  });

  it("rejects a tampered requirement hash and preserves the failure receipt", async () => {
    const clock = 1_700_000_000_000;
    const merchant = new A2AX402Merchant({ verifier: createHmacA2AVerifier(SECRET), now: () => clock });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => clock),
      now: () => clock,
      nonce: () => "tamper",
    });
    const task = merchant.createTask("tamper-task", { x402Version: 1, accepts: [REQUIREMENT] });
    const original = await client.createPaymentSubmission(task);
    const authorization = original.metadata[A2A_PAYMENT_METADATA.payload] as A2ASignedPayment;
    const tampered = createPaymentSubmissionMessage("tamper-task", {
      ...authorization,
      requirementHash: "not-the-task-hash",
    });

    const failed = await merchant.receivePayment(tampered);
    expect(failed.status.state).toBe("failed");
    expect(failed.status.message?.metadata[A2A_PAYMENT_METADATA.error]).toBe("PAYMENT_REQUIREMENT_MISMATCH");
    expect(failed.status.message?.metadata[A2A_PAYMENT_METADATA.receipts]).toHaveLength(1);
  });

  it("rejects replayed nonces after a successful settlement", async () => {
    const clock = 1_700_000_000_000;
    const merchant = new A2AX402Merchant({ verifier: createHmacA2AVerifier(SECRET), now: () => clock });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => clock),
      now: () => clock,
      nonce: () => "once",
    });
    const task = merchant.createTask("replay-task", { x402Version: 1, accepts: [REQUIREMENT] });
    const submission = await client.createPaymentSubmission(task);
    expect((await merchant.receivePayment(submission)).status.state).toBe("completed");
    const replay = await merchant.receivePayment(submission);
    expect(replay.status.state).toBe("failed");
    expect(replay.status.message?.metadata[A2A_PAYMENT_METADATA.error]).toBe("DUPLICATE_NONCE");
    expect(replay.status.message?.metadata[A2A_PAYMENT_METADATA.receipts]).toHaveLength(2);
  });

  it("rejects payment claims for a different payee even when the verifier accepts the envelope", async () => {
    const clock = 1_700_000_000_000;
    const merchant = new A2AX402Merchant({ verifier: async () => true, now: () => clock });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => clock),
      now: () => clock,
      nonce: () => "wrong-payee",
    });
    const task = merchant.createTask("wrong-payee", { x402Version: 1, accepts: [REQUIREMENT] });
    const original = await client.createPaymentSubmission(task);
    const authorization = original.metadata[A2A_PAYMENT_METADATA.payload] as A2ASignedPayment;
    const tampered: A2ASignedPayment = {
      ...authorization,
      payment: {
        ...authorization.payment,
        payload: { ...authorization.payment.payload, payTo: "0x2222222222222222222222222222222222222222" },
      },
    };
    const failed = await merchant.receivePayment(createPaymentSubmissionMessage(task.id, tampered));
    expect(failed.status.message?.metadata[A2A_PAYMENT_METADATA.error]).toBe("PAYMENT_REQUIREMENT_MISMATCH");
  });

  it("records failed settlement attempts as receipts", async () => {
    const merchant = new A2AX402Merchant({
      verifier: createHmacA2AVerifier(SECRET),
      settle: async ({ requirement }) => ({ success: false, network: requirement.network, errorReason: "facilitator unavailable" }),
    });
    const client = new A2AX402Client({
      signer: createHmacA2ASigner(SECRET),
      spendControl: control(() => 1_700_000_000_000),
      now: () => 1_700_000_000_000,
      nonce: () => "settle-fail",
    });
    const task = merchant.createTask("settle-fail", { x402Version: 1, accepts: [REQUIREMENT] });
    const failed = await merchant.receivePayment(await client.createPaymentSubmission(task));
    expect(failed.status.state).toBe("failed");
    expect(failed.status.message?.metadata[A2A_PAYMENT_METADATA.error]).toBe("SETTLEMENT_FAILED");
    expect(failed.status.message?.metadata[A2A_PAYMENT_METADATA.receipts]).toEqual([
      { success: false, network: CAIP2_BASE, errorReason: "facilitator unavailable" },
    ]);
  });
});

describe("A2A extension activation", () => {
  it("declares and negotiates the canonical extension URI", () => {
    const declaration = getA2AExtensionDeclaration();
    expect(declaration.required).toBe(true);
    expect(hasA2AExtension({ "X-A2A-Extensions": declaration.uri })).toBe(true);
    expect(hasA2AExtension({ "x-a2a-extensions": `other, ${declaration.uri}` })).toBe(true);
    expect(echoA2AExtension({ Server: "a2a" })["X-A2A-Extensions"]).toBe(declaration.uri);
  });
});
