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

  it("reports recorded failures at timeout and retains late ledger errors", async () => {
    const failures: unknown[] = [new Error("sink failed")];
    const ledger = new Error("fsync failed");
    const error = await rejection(
      flushFulfillments(new Set([never()]), failures, async () => Promise.reject(ledger), {
        timeoutMs: 10,
      }),
    );
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toMatchObject({ message: "sink failed" });
    // A ledger rejection observed after the deadline belongs to the next explicit flush.
    const next = await rejection(flushFulfillments(new Set(), failures, async () => {}));
    expect(next.errors).toContain(ledger);
    expect(failures).toHaveLength(0);
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    Number.MAX_VALUE,
    "5" as unknown as number,
  ])("rejects timeoutMs %s", async (timeoutMs) => {
    await expect(
      flushFulfillments(new Set(), [], async () => {}, { timeoutMs }),
    ).rejects.toBeInstanceOf(TypeError);
  });

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

describe("total flush deadline", () => {
  it.each([0, 2_147_483_647])(
    "accepts timer boundary %s when persistence completes",
    async (timeoutMs) => {
      await expect(
        flushFulfillments(new Set(), [], async () => {}, { timeoutMs }),
      ).resolves.toBeUndefined();
    },
  );

  it("preserves every byte for a slow pipeTo reader after timeout", async () => {
    const pending = new Set<Promise<void>>();
    const rows: MppFulfillmentRecord[] = [];
    const response = recordMppFulfillment(
      { input: "https://seller.example/stream", response: sse(5), payment },
      (row) => {
        rows.push(row);
      },
      (task) => {
        pending.add(task);
      },
    );
    await rejection(flushFulfillments(pending, [], async () => {}, { timeoutMs: 1 }));
    let text = "";
    const decoder = new TextDecoder();
    await response.body!.pipeTo(
      new WritableStream<Uint8Array>({
        async write(bytes) {
          text += decoder.decode(bytes, { stream: true });
          await new Promise((r) => setTimeout(r, 5));
        },
      }),
    );
    expect(text).toBe(
      Array.from({ length: 5 }, (_, i) => `data: {"i":${i}}\n\n`).join("") + "data: [DONE]\n\n",
    );
    await flushFulfillments(pending, [], async () => {}, { timeoutMs: 100 });
    expect(rows).toHaveLength(1);
  });

  it("bounds a stalled ledger even when there are no pending records", async () => {
    const flush = vi.fn(never);
    const error = await rejection(flushFulfillments(new Set(), [], flush, { timeoutMs: 10 }));
    expect(flush).toHaveBeenCalledOnce();
    expect(error.errors[0]).toMatchObject({ pending: 0, ledgerPending: true, timeoutMs: 10 });
  });

  it("shares one deadline between the records and ledger stages", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Set([new Promise<void>((r) => setTimeout(r, 75))]);
      const flush = vi.fn(never);
      const result = rejection(flushFulfillments(pending, [], flush, { timeoutMs: 100 }));
      await vi.advanceTimersByTimeAsync(75);
      expect(flush).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      expect((await result).errors[0]).toMatchObject({ ledgerPending: true, timeoutMs: 100 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains late ledger rejection for a later flush without cancelling persistence", async () => {
    let rejectLedger!: (error: Error) => void;
    const ledger = new Promise<void>((_, reject) => {
      rejectLedger = reject;
    });
    const failures: unknown[] = [];
    const error = await rejection(
      flushFulfillments(new Set(), failures, () => ledger, { timeoutMs: 10 }),
    );
    expect(error.errors[0]).toMatchObject({ pending: 0, ledgerPending: true });
    const late = new Error("late fsync failure");
    rejectLedger(late);
    await Promise.resolve();
    await Promise.resolve();
    const next = await rejection(flushFulfillments(new Set(), failures, async () => {}));
    expect(next.errors).toContain(late);
    expect(failures).toHaveLength(0);
  });

  it("aggregates a synchronous ledger failure", async () => {
    const failure = new Error("sync ledger failure");
    const result = await rejection(
      flushFulfillments(
        new Set(),
        [],
        () => {
          throw failure;
        },
        { timeoutMs: 100 },
      ),
    );
    expect(result.errors).toContain(failure);
  });

  it("overlapping flushes: a ledger failure reaches the flush that was waiting on it", async () => {
    // One shared integration ledger, as on the rails. A waits with no deadline; B times out first.
    let rejectLedger!: (error: unknown) => void;
    const shared = new Promise<void>((_, reject) => (rejectLedger = reject));
    shared.catch(() => {});
    const failures: unknown[] = [];
    const ledgerError = new Error("fsync failed");
    let aSettled = false;
    const a = rejection(flushFulfillments(new Set(), failures, () => shared)).finally(
      () => (aSettled = true),
    );
    const b = await rejection(
      flushFulfillments(new Set(), failures, () => shared, { timeoutMs: 10 }),
    );
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toMatchObject({ ledgerPending: true });
    expect(aSettled).toBe(false);
    rejectLedger(ledgerError);
    // A was still waiting when its ledger failed: A must reject with it, exactly once, not resolve.
    // B had already returned and queued the same late error; A's drain takes it, so it is not
    // reported again by a later flush.
    expect((await a).errors).toEqual([ledgerError]);
    expect(failures).toHaveLength(0);
    await expect(flushFulfillments(new Set(), failures, async () => {})).resolves.toBe(undefined);
  });

  it("a ledger failure during this flush is not drained by an overlapping flush", async () => {
    let rejectA!: (error: unknown) => void;
    const aLedger = new Promise<void>((_, reject) => (rejectA = reject));
    const failures: unknown[] = [];
    const aError = new Error("a ledger failed");
    const a = rejection(flushFulfillments(new Set(), failures, () => aLedger));
    rejectA(aError);
    // B runs while A's rejection is settling; it must not take A's error.
    await expect(flushFulfillments(new Set(), failures, async () => {})).resolves.toBe(undefined);
    expect((await a).errors).toEqual([aError]);
  });
});
