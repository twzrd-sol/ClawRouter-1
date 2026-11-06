import { describe, expect, it } from "vitest";
import { recordMppFulfillment, type MppFulfillmentRecord } from "./mpp-fulfillment-record.js";

// Evidence for a flush() deadline gap. recordMppFulfillment tracks one pending promise per paid
// response; the rails' flush() awaits Promise.all over those promises with no timeout
// (mpp-fetch.ts flush, mpp-solana-fetch.ts flush). On the SSE path that promise settles only when
// the tapped body reaches done, errors, or is cancelled. A caller that drops the response without
// reading or cancelling it leaves the promise pending, so flush() would wait forever.

const payment = {
  challengeId: "challenge-abandoned",
  method: "tempo",
  intent: "charge",
  payTo: "0x0000000000000000000000000000000000000001",
  network: "eip155:4217",
  asset: "0x20c0000000000000000000000000000000000000",
  amountAtomic: "750",
};

const DEADLINE_MS = 2000;

function multiChunkSse(): Response {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"model":"gpt-test","choices":[]}\n\n',
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function settleWithin(pending: Promise<void>[], ms: number): Promise<"settled" | "timeout"> {
  // Mirrors the rails' flush(): Promise.all over every tracked fulfillment.
  const flush = Promise.all(pending).then(
    () => "settled" as const,
    () => "settled" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([flush, timeout]).finally(() => clearTimeout(timer));
}

function record(rows: MppFulfillmentRecord[], pending: Promise<void>[]): Response {
  return recordMppFulfillment(
    {
      input: "https://seller.example/v1/chat/completions",
      init: { method: "POST", body: JSON.stringify({ model: "gpt-test", stream: true }) },
      response: multiChunkSse(),
      payment,
    },
    (row) => {
      rows.push(row);
    },
    (task) => pending.push(task),
  );
}

describe("abandoned SSE fulfillment and flush deadline", () => {
  it("control: a cancelled SSE body settles the pending record", async () => {
    const rows: MppFulfillmentRecord[] = [];
    const pending: Promise<void>[] = [];
    const response = record(rows, pending);
    await response.body!.cancel("caller gave up");
    expect(await settleWithin(pending, DEADLINE_MS)).toBe("settled");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receipt_state).toBe("unavailable");
  });

  // KNOWN GAP (it.fails): flush() has no deadline. When the caller neither reads nor cancels the
  // SSE body, the tracked promise never settles, so this assertion times out and it.fails passes.
  // When a flush deadline (or abandonment handling) lands, this flips red: change it.fails to it.
  it.fails(
    "an unread, uncancelled SSE body settles the pending record within the deadline",
    async () => {
      const rows: MppFulfillmentRecord[] = [];
      const pending: Promise<void>[] = [];
      const response = record(rows, pending);
      expect(response.bodyUsed).toBe(false);
      expect(pending).toHaveLength(1);
      // Drop the response: no read, no cancel.
      expect(await settleWithin(pending, DEADLINE_MS)).toBe("settled");
    },
    DEADLINE_MS + 3000,
  );
});
