import { describe, expect, it } from "vitest";
import {
  MPP_FULFILLMENT_RECORD_SCHEMA,
  recordMppFulfillment,
  type MppFulfillmentRecord,
} from "./mpp-fulfillment-record.js";

const payment = {
  challengeId: "challenge-1",
  method: "tempo",
  intent: "charge",
  payTo: "0x0000000000000000000000000000000000000001",
  network: "eip155:4217",
  asset: "0x20c0000000000000000000000000000000000000",
  amountAtomic: "750",
};

function receipt(reference: string): string {
  return Buffer.from(
    JSON.stringify({
      method: "tempo",
      reference,
      status: "success",
      timestamp: "2026-11-05T00:00:00.000Z",
    }),
  ).toString("base64url");
}

function sessionReceipt(challengeId: string) {
  return {
    method: "tempo",
    intent: "session",
    status: "success",
    timestamp: "2026-11-05T00:00:00.000Z",
    reference: "0xchannel",
    challengeId,
    channelId: "0xchannel",
    acceptedCumulative: "1000",
    spent: "750",
    units: 1,
    txHash: "0xtx",
  };
}

function nextRecord() {
  let resolve!: (record: MppFulfillmentRecord) => void;
  const result = new Promise<MppFulfillmentRecord>((done) => (resolve = done));
  return { result, resolve };
}

describe("MPP fulfillment records", () => {
  it("records decoded receipt reference and seller model claim without consuming the response", async () => {
    const pending = nextRecord();
    const encodedReceipt = receipt("0xabc123");
    const response = new Response(JSON.stringify({ model: "seller-claims-7b" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Payment-Receipt": encodedReceipt,
      },
    });
    recordMppFulfillment(
      {
        input: "https://seller.example/v1/chat/completions?secret=omit-me",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "frontier-model" }),
        },
        response,
        payment,
        gate: {
          disposition: "allow",
          decisionId: "decision-1",
          intentHash: "hash-1",
          reasonCodes: [],
        },
      },
      pending.resolve,
    );
    const [row, body] = await Promise.all([pending.result, response.json()]);
    expect(body).toEqual({ model: "seller-claims-7b" });
    expect(row).toMatchObject({
      schema: MPP_FULFILLMENT_RECORD_SCHEMA,
      resource_origin: "https://seller.example",
      payment_method: "tempo",
      paid_to: payment.payTo,
      network: "eip155:4217",
      amount_atomic: "750",
      receipt_state: "valid_format",
      receipt_status: "success",
      receipt_reference: "0xabc123",
      requested_model: "frontier-model",
      seller_reported_model: "seller-claims-7b",
      seller_reported_model_matches_request: false,
      gate: { disposition: "allow", decisionId: "decision-1", intentHash: "hash-1" },
    });
    expect(JSON.stringify(row)).not.toContain(encodedReceipt);
    expect(JSON.stringify(row)).not.toContain("secret=omit-me");
  });

  it("records missing and malformed receipts explicitly", async () => {
    for (const [header, state] of [
      [null, "missing"],
      ["not-base64-json", "invalid_format"],
    ] as const) {
      const pending = nextRecord();
      const response = new Response("stream", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          ...(header ? { "Payment-Receipt": header } : {}),
        },
      });
      const recordedResponse = recordMppFulfillment(
        { input: "https://seller.example/stream", response, payment },
        pending.resolve,
      );
      const [row, body] = await Promise.all([pending.result, recordedResponse.text()]);
      expect(row.receipt_state).toBe(state);
      expect(row.seller_reported_model_matches_request).toBeNull();
      expect(body).toBe("stream");
    }
  });

  it("records a Tempo session receipt from SSE without changing the stream bytes", async () => {
    const pending = nextRecord();
    const event = `event: payment-receipt\ndata: ${JSON.stringify(sessionReceipt(payment.challengeId))}\n\n`;
    const bytes = new TextEncoder().encode(
      `${event}event: message\ndata: {"model":"seller-stream-model","choices":[]}\n\ndata: [DONE]\n\n`,
    );
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 23));
          controller.enqueue(bytes.slice(23));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const response = recordMppFulfillment(
      {
        input: "https://seller.example/v1/chat/completions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "requested-stream-model" }),
        },
        response: original,
        payment: { ...payment, intent: "session" },
      },
      pending.resolve,
    );
    const [row, stream] = await Promise.all([pending.result, response.text()]);
    expect(stream).toBe(new TextDecoder().decode(bytes));
    expect(row).toMatchObject({
      receipt_state: "valid_format",
      receipt_method: "tempo",
      receipt_status: "success",
      receipt_reference: "0xchannel",
      receipt_timestamp: "2026-11-05T00:00:00.000Z",
      payment_intent: "session",
      requested_model: "requested-stream-model",
      seller_reported_model: "seller-stream-model",
      seller_reported_model_matches_request: false,
    });
  });

  it("does not parse oversized request bodies just to extract a model", async () => {
    const pending = nextRecord();
    const body = JSON.stringify({ model: "frontier-model", padding: "x".repeat(1024 * 1024) });
    recordMppFulfillment(
      {
        input: "https://seller.example/v1/chat/completions",
        init: { method: "POST", headers: { "content-type": "application/json" }, body },
        response: new Response("ok", { status: 200 }),
        payment,
      },
      pending.resolve,
    );
    const row = await pending.result;
    expect(row.requested_model).toBeNull();
  });

  it("does not let an async sink rejection break an SSE response", async () => {
    const receiptBody = `event: payment-receipt\ndata: ${JSON.stringify(sessionReceipt(payment.challengeId))}\n\n`;
    const response = recordMppFulfillment(
      {
        input: "https://seller.example/stream",
        response: new Response(receiptBody, { headers: { "content-type": "text/event-stream" } }),
        payment: { ...payment, intent: "session" },
      },
      async () => {
        throw new Error("sink down");
      },
    );
    await expect(response.text()).resolves.toBe(receiptBody);
  });

  it("does not wait for a slow async sink before closing an SSE response", async () => {
    const receiptBody = `event: payment-receipt\ndata: ${JSON.stringify(sessionReceipt(payment.challengeId))}\n\n`;
    let startSink!: () => void;
    let releaseSink!: () => void;
    const sinkStarted = new Promise<void>((resolve) => (startSink = resolve));
    const sinkWait = new Promise<void>((resolve) => (releaseSink = resolve));
    const response = recordMppFulfillment(
      {
        input: "https://seller.example/stream",
        response: new Response(receiptBody, { headers: { "content-type": "text/event-stream" } }),
        payment: { ...payment, intent: "session" },
      },
      async () => {
        startSink();
        await sinkWait;
      },
    );
    const body = response.text();
    await sinkStarted;
    await expect(body).resolves.toBe(receiptBody);
    releaseSink();
  });

  it("rejects receipts whose status is not successful or session challenge does not match", async () => {
    const invalidReceipts: Array<[Record<string, unknown>, string]> = [
      [{ method: "tempo", reference: "ref", status: "failure", timestamp: "2026-11-05" }, "charge"],
      [
        {
          method: "stripe",
          reference: "ref",
          status: "success",
          timestamp: "2026-11-05T00:00:00Z",
        },
        "charge",
      ],
      [{ method: "tempo", reference: "ref", status: "success", timestamp: "invalid" }, "charge"],
      [{ ...sessionReceipt(payment.challengeId) }, "charge"],
      [{ ...sessionReceipt("other-challenge") }, "session"],
    ];
    for (const [value, intent] of invalidReceipts) {
      const pending = nextRecord();
      recordMppFulfillment(
        {
          input: "https://seller.example/paid",
          response: new Response("ok", {
            headers: {
              "payment-receipt": Buffer.from(JSON.stringify(value)).toString("base64url"),
            },
          }),
          payment: { ...payment, intent },
        },
        pending.resolve,
      );
      expect((await pending.result).receipt_state).toBe("invalid_format");
    }
  });
});
