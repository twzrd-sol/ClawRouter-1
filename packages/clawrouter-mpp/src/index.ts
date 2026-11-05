/**
 * MPP (Machine Payments Protocol) payment rails for ClawRouter.
 *
 *   import { startProxy } from "@twzrd1111/clawrouter";
 *   import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
 *   await startProxy({ ..., payFetch: createMppFetch(account, fetch, { spend }) });
 *
 * Two rails: Tempo (`createMppFetch`, needs `mppx`) and Solana (`createSolanaMppFetch`, needs
 * `@solana/mpp`). Both are optional peer dependencies; Tempo loads on first use,
 * Solana loads when its asynchronous factory is called.
 */
export {
  createMppFetch,
  DEFAULT_TEMPO_USD_ASSETS,
  guardMethod,
  quoteFromChallenge,
} from "./mpp-fetch.js";
export type { MppFetchOptions, PayFetch } from "./mpp-fetch.js";
export { createSolanaMppFetch, DEFAULT_SOLANA_USD_MINTS } from "./mpp-solana-fetch.js";
export type { SolanaMppFetchOptions } from "./mpp-solana-fetch.js";
export { MppGateError } from "./mpp-gate.js";
export type { MppGateChallenge, MppGateDecision, MppGateEvaluator } from "./mpp-gate.js";
export {
  MPP_FULFILLMENT_MAX_BODY_BYTES,
  MPP_FULFILLMENT_RECORD_SCHEMA,
} from "./mpp-fulfillment-record.js";
export type {
  MppFulfillmentRecord,
  MppFulfillmentSink,
  MppPaymentFacts,
} from "./mpp-fulfillment-record.js";
export {
  MppPaidNoCompletionError,
  creditPaidNoCompletion,
  readCredits,
} from "./mpp-paid-failure.js";
export { readPaidCallEvidence } from "./mpp-paid-failure.js";
export { CreditLedger } from "./credit-record.js";
export type { CreditEntry } from "./credit-record.js";
export { SpentProofLedger, ReplayRejectedError, fulfillPaidProof } from "./spent-proof.js";
