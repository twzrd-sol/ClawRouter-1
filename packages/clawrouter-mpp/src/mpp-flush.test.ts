import { describe, expect, it, vi } from "vitest";
import { flushFulfillments, MppFlushTimeoutError } from "./mpp-flush.js";
import { recordMppFulfillment, type MppFulfillmentRecord } from "./mpp-fulfillment-record.js";

const never = () => new Promise<void>(() => {});

const payment = {
  challengeId: "challenge-flush-deadline",
  method: "tempo",
  intent: "charge",
  payTo: "0x0000000000000000000000000000000000000001",
  network: "eip155:4217",
  asset: "0x20c0000000000000000000000000000000000000",
  amountAtomic: "750",
};

function sse(events: number): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < events) controller.enqueue(encoder.encode(`data: {"i":${i++}}\n\n`));
        else {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function rejection(promise: Promise<unknown>): Promise<AggregateError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AggregateError);
  return error as AggregateError;
}

describe("flushFulfillments deadline", () => {
  it("without timeoutMs waits for every pending record, as before", async () => {
    let release!: () => void;
    const pending = new Set([new Promise<void>((r) => (release = r))]);
    const integrationFlush = vi.fn(async () => {});
    let done = false;
    const flushing = flushFulfillments(pending, [], integrationFlush).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    release();
    await flushing;
    expect(integrationFlush).toHaveBeenCalledOnce();
  });

  it("stops at the deadline, still flushes the ledger, and counts what is pending", async () => {
    const pending = new Set([never(), never()]);
    const integrationFlush = vi.fn(async () => {});
    const started = Date.now();
    const error = await rejection(
      flushFulfillments(pending, [], integrationFlush, { timeoutMs: 100 }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(integrationFlush).toHaveBeenCalledOnce();
    const timeout = error.errors.find(
      (e) => e instanceof MppFlushTimeoutError,
    ) as MppFlushTimeoutError;
    expect(timeout.pending).toBe(2);
    expect(timeout.timeoutMs).toBe(100);
  });

  it("resolves when every record settles before the deadline", async () => {
    const pending = new Set([Promise.resolve()]);
    const integrationFlush = vi.fn(async () => {});
    await expect(
      flushFulfillments(pending, [], integrationFlush, { timeoutMs: 1000 }),
    ).resolves.toBe(undefined);
    expect(integrationFlush).toHaveBeenCalledOnce();
  });

  it("reports recorded failures and ledger errors with the timeout, and drains failures", async () => {
    const failures: unknown[] = [new Error("sink failed")];
    const ledger = new Error("fsync failed");
    const error = await rejection(
      flushFulfillments(new Set([never()]), failures, async () => Promise.reject(ledger), {
        timeoutMs: 10,
      }),
    );
    expect(error.errors).toHaveLength(3);
    expect(error.errors).toContain(ledger);
    expect(failures).toHaveLength(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])(
    "rejects timeoutMs %s",
    async (timeoutMs) => {
      await expect(
        flushFulfillments(new Set(), [], async () => {}, { timeoutMs }),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("an unread paid SSE body is not cancelled: the caller still reads all of it after a timed-out flush", async () => {
    const rows: MppFulfillmentRecord[] = [];
    const pending = new Set<Promise<void>>();
    const response = recordMppFulfillment(
      {
        input: "https://seller.example/v1/chat/completions",
        init: { method: "POST", body: JSON.stringify({ model: "gpt-test", stream: true }) },
        response: sse(5),
        payment,
      },
      (row) => {
        rows.push(row);
      },
      (task) => pending.add(task),
    );
    const error = await rejection(
      flushFulfillments(pending, [], async () => {}, { timeoutMs: 100 }),
    );
    expect(error.errors[0]).toBeInstanceOf(MppFlushTimeoutError);
    // Read late, after the deadline: every event is still delivered.
    const text = await response.text();
    for (let i = 0; i < 5; i++) expect(text).toContain(`{"i":${i}}`);
    expect(text).toContain("[DONE]");
    // Draining the body finishes the record, so a later flush settles.
    await flushFulfillments(pending, [], async () => {}, { timeoutMs: 1000 });
    expect(rows).toHaveLength(1);
  });
});
