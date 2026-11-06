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

/**
 * Late-error ownership shared by every flush of one rail (keyed by its shared failures array).
 * `waiters` counts flushes still waiting on each ledger promise; `claimed` holds errors a waiting
 * flush has already taken. A flush that returned at its deadline queues a late ledger error only
 * when no flush is still waiting on that promise and no waiter claimed the error, so an error is
 * reported by the flush that was waiting on it, or else once by the next flush to drain.
 */
type LedgerOwnership = { waiters: Map<Promise<void>, number>; claimed: WeakSet<object> };
const ownership = new WeakMap<unknown[], LedgerOwnership>();

function ownershipFor(failures: unknown[]): LedgerOwnership {
  let entry = ownership.get(failures);
  if (!entry) {
    entry = { waiters: new Map(), claimed: new WeakSet() };
    ownership.set(failures, entry);
  }
  return entry;
}

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

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
    // Invoke even after expiration. An error that settles while this flush is still waiting is
    // this flush's own and is reported here. One that settles after this flush returned at its
    // deadline is queued in `failures` for the next explicit flush, unless another flush is still
    // waiting on the same ledger promise or has claimed the error. Every rejection is observed,
    // so background persistence cannot cause an unhandled rejection.
    const owners = ownershipFor(failures);
    const ownErrors: unknown[] = [];
    let ledgerPending = true;
    let waiting = true;
    let source: Promise<void> | undefined;
    try {
      source = Promise.resolve(integrationFlush());
    } catch (error) {
      ownErrors.push(error);
      ledgerPending = false;
    }
    const release = () => {
      if (!waiting) return;
      waiting = false;
      if (!source) return;
      const left = (owners.waiters.get(source) ?? 1) - 1;
      if (left > 0) owners.waiters.set(source, left);
      else owners.waiters.delete(source);
    };
    let ledger: Promise<void> = Promise.resolve();
    if (source) {
      const observed = source;
      owners.waiters.set(observed, (owners.waiters.get(observed) ?? 0) + 1);
      ledger = observed
        .catch((error: unknown) => {
          if (waiting) {
            ownErrors.push(error);
            if (isObject(error)) owners.claimed.add(error);
            const queued = failures.indexOf(error);
            if (queued >= 0) failures.splice(queued, 1);
          } else if (
            !owners.waiters.get(observed) &&
            !(isObject(error) && owners.claimed.has(error)) &&
            !failures.includes(error)
          ) {
            failures.push(error);
          }
        })
        .finally(() => {
          ledgerPending = false;
        });
    }
    try {
      await wait(ledger);
    } finally {
      release();
    }
    const errors = [...new Set([...failures.splice(0), ...ownErrors])];
    if (expired) errors.push(new MppFlushTimeoutError(pending.size, timeoutMs!, ledgerPending));
    if (errors.length) throw new AggregateError(errors, "MPP fulfillment records did not flush");
  } finally {
    clearTimeout(timer);
  }
}
