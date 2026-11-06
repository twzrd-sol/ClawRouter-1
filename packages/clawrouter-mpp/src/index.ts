/**
 * MPP (Machine Payments Protocol) payment rails for ClawRouter.
 *
 *   import { startProxy } from "@twzrd1111/clawrouter";
 *   import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
 *   await startProxy({ ..., payFetch: createMppFetch(account, fetch, { spend, integration }) });
 *
 * Both rails require the branded TWZRD MPP integration. Tempo (`createMppFetch`, needs
 * `mppx`) and Solana (`createSolanaMppFetch`, needs `@solana/mpp`) remain optional peer dependencies.
 */
export { createMppFetch, DEFAULT_TEMPO_USD_ASSETS, quoteFromChallenge } from "./mpp-fetch.js";
export type { MppFetchOptions, PayFetch } from "./mpp-fetch.js";
export { MppFlushTimeoutError } from "./mpp-flush.js";
export type { MppFlushOptions, MppPayFetch } from "./mpp-flush.js";
export { createSolanaMppFetch, DEFAULT_SOLANA_USD_MINTS } from "./mpp-solana-fetch.js";
export type {
  SolanaMppFetchOptions,
  SolanaReceiptVerificationOptions,
} from "./mpp-solana-fetch.js";
export { MppGateError } from "./mpp-gate.js";
export type {
  MppGateChallenge,
  MppGateDecision,
  MppGateEvaluator,
  MppIntegration,
} from "./mpp-gate.js";
export {
  MPP_FULFILLMENT_MAX_BODY_BYTES,
  MPP_FULFILLMENT_RECORD_SCHEMA,
  RECEIPT_REFERENCE_NOT_EVALUATED,
} from "./mpp-fulfillment-record.js";
export type {
  MppBodyDigest,
  MppFulfillmentRecord,
  MppFulfillmentSink,
  MppPaymentFacts,
  MppReceiptReferenceVerification,
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
export {
  createReceiptChainVerifier,
  DEFAULT_TRUSTED_USD_MINTS,
  InMemoryReceiptReferenceIndex,
  LANDING_WINDOW_SECONDS,
} from "./receipt-chain-verify.js";
export type {
  ChainMismatch,
  ChainUnverifiedReason,
  GetFinalizedTransaction,
  ReceiptChainVerification,
  ReceiptChainVerifierConfig,
  ReceiptChainVerify,
  ReceiptChainVerifyInput,
  ReceiptReferenceIndex,
  RpcTransaction,
  SolanaCluster,
  TrustedMint,
} from "./receipt-chain-verify.js";
