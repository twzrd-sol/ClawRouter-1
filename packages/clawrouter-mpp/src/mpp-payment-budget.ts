import { AsyncLocalStorage } from "node:async_hooks";

/** Shared with ClawRouter's proxy, but never forwarded as an HTTP header. */
const PAY_FETCH_BUDGET_CONTEXT = Symbol.for("twzrd.clawrouter.pay-fetch-budget.v1");

export type MppPaymentBudgetContext = {
  /** Check and reserve the exact quoted USD micros before the rail signs. */
  assertPaymentAllowed: (quoteMicros: bigint | undefined) => void;
  /** Record the quoted amount when a credential is produced. */
  recordSigned: (quoteMicros: bigint | undefined) => void;
};

const contextStorage = new AsyncLocalStorage<MppPaymentBudgetContext | undefined>();

export function paymentBudgetFromInit(init?: RequestInit): MppPaymentBudgetContext | undefined {
  const context = (init as (RequestInit & { [key: symbol]: unknown }) | undefined)?.[
    PAY_FETCH_BUDGET_CONTEXT
  ];
  if (!context || typeof context !== "object") return undefined;
  const value = context as Partial<MppPaymentBudgetContext>;
  return typeof value.assertPaymentAllowed === "function" &&
    typeof value.recordSigned === "function"
    ? (value as MppPaymentBudgetContext)
    : undefined;
}

/** Clone init without the private symbol so it cannot reach an upstream fetch implementation. */
export function stripPaymentBudgetFromInit(init?: RequestInit): RequestInit | undefined {
  if (!init) return undefined;
  const clean = { ...init } as RequestInit & { [key: symbol]: unknown };
  delete clean[PAY_FETCH_BUDGET_CONTEXT];
  return clean;
}

export function currentMppPaymentBudget(): MppPaymentBudgetContext | undefined {
  return contextStorage.getStore();
}

export function runWithMppPaymentBudget<T>(
  context: MppPaymentBudgetContext | undefined,
  run: () => T,
): T {
  return contextStorage.run(context, run);
}
