import type { PayFetch } from "@twzrd1111/clawrouter";

export type MppFlushOptions = {
  /**
   * Bound the entire wait for fulfillment records and ledger persistence. At the deadline,
   * ledger flushing is still attempted in the background; neither writes nor response bodies
   * are cancelled. Late ledger failures are retained for the next flush(). Omit to wait forever.
   * Valid range: 0 through 2_147_483_647 milliseconds (Node's maximum timer delay).
   */
  timeoutMs?: number;
};

/** A rail fetch whose flush() accepts an optional deadline. Assignable to PayFetch. */
export type MppPayFetch = PayFetch & { flush: (options?: MppFlushOptions) => Promise<void> };

/** The deadline elapsed; persistence may still be running and response bodies remain caller-owned. */
export class MppFlushTimeoutError extends Error {
  readonly pending: number;
  readonly timeoutMs: number;
  readonly ledgerPending: boolean;
  constructor(pending: number, timeoutMs: number, ledgerPending = false) {
    super(
      `MPP flush deadline reached after ${timeoutMs} ms: ${pending} fulfillment record(s) pending; ` +
        `ledger flush ${ledgerPending ? "still pending" : "finished"}`,
    );
    this.name = "MppFlushTimeoutError";
    this.pending = pending;
    this.timeoutMs = timeoutMs;
    this.ledgerPending = ledgerPending;
  }
}

/** Largest delay setTimeout honours; Node clamps anything above it to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function deadlineOf(options: MppFlushOptions | undefined): number | undefined {
  const value = options?.timeoutMs;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new TypeError(`flush timeoutMs must be a number from 0 to ${MAX_TIMER_MS}`);
  }
  return value;
}

/** Share one deadline across both stages, leaving timed-out work running with observed errors. */
export async function flushFulfillments(
  pending: ReadonlySet<Promise<void>>,
  failures: unknown[],
  integrationFlush: () => Promise<void>,
  options?: MppFlushOptions,
): Promise<void> {
  const timeoutMs = deadlineOf(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline =
    timeoutMs === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve();
          }, timeoutMs);
        });
  const wait = (task: Promise<void>) => (deadline ? Promise.race([task, deadline]) : task);
  try {
    await wait(Promise.all([...pending]).then(() => undefined));
    let ledgerPending = true;
    // Invoke even after expiration. Observe late failures so background persistence cannot
    // cause an unhandled rejection, and the next explicit flush can report them.
    let ledger: Promise<void>;
    try {
      ledger = Promise.resolve(integrationFlush())
        .catch((error) => {
          failures.push(error);
        })
        .finally(() => {
          ledgerPending = false;
        });
    } catch (error) {
      failures.push(error);
      ledgerPending = false;
      ledger = Promise.resolve();
    }
    await wait(ledger);
    const errors = failures.splice(0);
    if (expired) errors.push(new MppFlushTimeoutError(pending.size, timeoutMs!, ledgerPending));
    if (errors.length) throw new AggregateError(errors, "MPP fulfillment records did not flush");
  } finally {
    clearTimeout(timer);
  }
}
