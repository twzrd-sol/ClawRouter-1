import type { PayFetch } from "@twzrd1111/clawrouter";

export type MppFlushOptions = {
  /**
   * Stop waiting for pending fulfillment records after this many milliseconds. The ledger is still
   * flushed, and flush() then rejects with an MppFlushTimeoutError counting the records not yet
   * written. Response bodies are never cancelled or read here: an SSE body the caller has not drained
   * stays the caller's. Omit it to wait for every record, as before.
   */
  timeoutMs?: number;
};

/** A rail fetch whose flush() accepts an optional deadline. Assignable to PayFetch. */
export type MppPayFetch = PayFetch & { flush: (options?: MppFlushOptions) => Promise<void> };

/** flush() stopped waiting at its deadline; `pending` fulfillment records were not yet written. */
export class MppFlushTimeoutError extends Error {
  readonly pending: number;
  readonly timeoutMs: number;
  constructor(pending: number, timeoutMs: number) {
    super(
      `${pending} MPP fulfillment record(s) still pending after ${timeoutMs} ms; ` +
        "an undrained or uncancelled response body keeps its record open",
    );
    this.name = "MppFlushTimeoutError";
    this.pending = pending;
    this.timeoutMs = timeoutMs;
  }
}

function deadlineOf(options: MppFlushOptions | undefined): number | undefined {
  const value = options?.timeoutMs;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("flush timeoutMs must be a finite number >= 0");
  }
  return value;
}

/**
 * Shared flush for the MPP rails: wait for pending records (bounded when timeoutMs is set), drain
 * recorded failures, then flush the integration ledger. Rejects with an AggregateError of every
 * failure, including an MppFlushTimeoutError when the deadline passed.
 */
export async function flushFulfillments(
  pending: ReadonlySet<Promise<void>>,
  failures: unknown[],
  integrationFlush: () => Promise<void>,
  options?: MppFlushOptions,
): Promise<void> {
  const timeoutMs = deadlineOf(options);
  const all = Promise.all([...pending]).then(() => undefined);
  let timedOut: MppFlushTimeoutError | undefined;
  if (timeoutMs === undefined) {
    await all;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      if ((await Promise.race([all.then(() => "done" as const), deadline])) === "timeout") {
        timedOut = new MppFlushTimeoutError(pending.size, timeoutMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const errors = failures.splice(0);
  if (timedOut) errors.push(timedOut);
  try {
    await integrationFlush();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "MPP fulfillment records did not flush");
}
