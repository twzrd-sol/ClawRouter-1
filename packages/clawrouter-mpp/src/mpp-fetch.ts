/**
 * MPP (Machine Payments Protocol) upstream fetch — SPIKE.
 *
 * A third way to pay an upstream, beside the x402 wallet rail and the BlockRun API key: answer an
 * HTTP 402 `WWW-Authenticate: Payment` challenge (Tempo charge) with the `mppx` client and retry.
 * Same signature as the other rails' fetch, so the proxy handlers stay unaware of how a call is paid.
 *
 * Spend controls (opt-in via `opts.spend`) follow the wallet rail's signing hook, not the API-key
 * wrapper: the price is read from the QUOTED challenge before anything is signed, the policy is
 * fail-closed, and a signed credential counts as spend even if the request then fails (MPP settles
 * before the upstream responds); that failure is surfaced as MppPaidNoCompletionError (mpp-paid-failure.ts). The check lives in the method's `createCredential` (see `guardMethod`)
 * because mppx swallows errors thrown from its event handlers.
 *
 * The account is supplied by the caller; this module reads no env vars and no key files.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Mppx as MppxClient } from "mppx/client";
import type { Account } from "viem";
import {
  assertSpendPolicyAllows,
  SpendPolicyError,
  type PayFetch,
  type SpendControl,
  type SpendRecord,
} from "@twzrd1111/clawrouter";
import {
  creditFromChallenge,
  currentPaidCall,
  guardPaid,
  isPaidResponse,
  markSigned,
  markGateEvaluated,
  markPaymentChallenge,
  rejectPaidNoCompletion,
} from "./mpp-paid-failure.js";
import { loadOptional, MPPX_RANGE } from "./mpp-optional.js";
import {
  assertMppIntegration,
  evaluateMppGate,
  paymentFactsFromMppChallenge,
  type MppIntegration,
  type MppGateEvaluator,
} from "./mpp-gate.js";
import { recordMppFulfillment } from "./mpp-fulfillment-record.js";
import {
  currentMppPaymentBudget,
  paymentBudgetFromInit,
  runWithMppPaymentBudget,
  stripPaymentBudgetFromInit,
} from "./mpp-payment-budget.js";

export type { PayFetch };

/** Injectable optional client boundary for offline tests; production uses mppx/client. */
export const mppxClientDeps: {
  load: () => Promise<typeof import("mppx/client")>;
} = {
  load: () => loadOptional("mppx", MPPX_RANGE, () => import("mppx/client")),
};

/**
 * Tempo TIP-20 USD stablecoins priced here, lower-case, all 6 decimals (the challenge carries no
 * `decimals`). Any other asset cannot be priced, so it is refused while amount limits are set.
 *  - 0x20c0…0000   pathUSD (Moderato testnet 42431, also on mainnet 4217)
 *  - 0x20c0…b9537d11c60e8b50   fee token a Tempo-run MPP proxy quoted on mainnet 4217 (2026-11-03)
 *  - 0x20c0…f37de3740adec032   charge currency on that same OpenRouter challenge (6 decimals, 750 = 0.00075 USD)
 */
export const DEFAULT_TEMPO_USD_ASSETS: ReadonlySet<string> = new Set([
  "0x20c0000000000000000000000000000000000000",
  "0x20c000000000000000000000b9537d11c60e8b50",
  "0x20c000000000000000000000f37de3740adec032",
]);

export type MppFetchOptions = {
  /** When set, every challenge is checked against these limits before a credential is created. */
  spend?: SpendControl;
  /** Override the assets treated as 6-decimal USD (lower-case addresses). */
  usdAssets?: ReadonlySet<string>;
  /** Required branded object from createTwzrdMppIntegration. */
  integration: MppIntegration;
};

type ChallengeLike = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: Record<string, unknown>;
  expires?: string;
  description?: string;
};

/** The quote as the spend-control layer understands it. `amount` stays undefined if unpriceable. */
export function quoteFromChallenge(
  challenge: ChallengeLike,
  usdAssets: ReadonlySet<string> = DEFAULT_TEMPO_USD_ASSETS,
) {
  const req = (challenge.request ?? {}) as {
    amount?: unknown;
    currency?: unknown;
    recipient?: unknown;
    methodDetails?: { chainId?: unknown };
  };
  const asset = typeof req.currency === "string" ? req.currency : undefined;
  const chainId = req.methodDetails?.chainId;
  const priceable =
    asset !== undefined && usdAssets.has(asset.toLowerCase()) && typeof req.amount === "string";
  return {
    payTo: typeof req.recipient === "string" ? req.recipient : undefined,
    network: typeof chainId === "number" ? `eip155:${chainId}` : undefined,
    asset,
    amount: priceable ? (req.amount as string) : undefined,
    priceable,
  };
}

// mppx method options are generic over the method's schema; the guard only reads `challenge`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MethodLike = { createCredential: (options: any) => Promise<string> };

/**
 * Put the spend policy in the signing path of an mppx method.
 *
 * mppx's `challenge.received` event is an observer: it runs each handler inside try/catch and goes on to
 * sign, so a handler cannot veto a payment by throwing (verified against mppx 0.17.0 and live, 2026-11-03).
 * `createCredential` is the one place a throw really aborts: reserve (fail-closed) -> sign -> settle,
 * and release the reservation if signing fails. A signed credential counts as spend even if the request
 * then fails, because MPP settles before the upstream responds.
 */
export function guardMethod<M extends MethodLike>(
  method: M,
  control: SpendControl | undefined,
  usdAssets: ReadonlySet<string> = DEFAULT_TEMPO_USD_ASSETS,
  gate?: MppGateEvaluator,
): M {
  type Signed = {
    credential: string;
    record?: ReturnType<SpendControl["settleReservation"]>;
  };
  // Cache in-flight promises too: overlapping calls for one challenge must
  // never create two Tempo credentials.
  const signedOnce = new Map<string, { promise: Promise<Signed>; signingStarted: boolean }>();
  const gateOnce = new Map<string, Promise<Awaited<ReturnType<typeof evaluateMppGate>>>>();
  const reuseKey = (challenge: ChallengeLike) => JSON.stringify(challenge);
  const guarded: MethodLike = {
    createCredential: async (options: { challenge: ChallengeLike }) => {
      const challenge = options.challenge;
      markPaymentChallenge(paymentFactsFromMppChallenge(challenge));
      const key = reuseKey(challenge);
      let gatePending = gateOnce.get(key);
      if (!gatePending) {
        gatePending = evaluateMppGate(gate, challenge);
        gateOnce.set(key, gatePending);
      }
      let gateDecision: Awaited<ReturnType<typeof evaluateMppGate>>;
      try {
        gateDecision = await gatePending;
      } catch (err) {
        if (gateOnce.get(key) === gatePending) gateOnce.delete(key);
        throw err;
      }
      if (gateOnce.get(key) === gatePending) gateOnce.delete(key);
      markGateEvaluated(gateDecision);
      const quote = quoteFromChallenge(challenge, usdAssets);
      const budget = currentMppPaymentBudget();
      const quoteMicros =
        quote.priceable && quote.amount && /^\d+$/.test(quote.amount)
          ? BigInt(quote.amount)
          : undefined;
      budget?.assertPaymentAllowed(quoteMicros);
      const call = currentPaidCall();
      const credit = creditFromChallenge(challenge, call?.payer ?? "");
      if (call && !credit)
        throw new Error("challenge is missing amount or id, or payer is missing");
      let attempt = signedOnce.get(key);
      if (!attempt) {
        const state: { promise: Promise<Signed>; signingStarted: boolean } = {
          promise: Promise.resolve({ credential: "" }),
          signingStarted: false,
        };
        state.promise = (async (): Promise<Signed> => {
          let reservationId: string | undefined;
          if (control) {
            if (!quote.priceable && control.hasAmountLimits()) {
              // An amount we cannot convert to USD cannot be compared to a configured cap.
              throw new SpendPolicyError(
                `MPP quote is in an asset or shape ClawRouter cannot price (${quote.asset ?? "none"}); refusing to pay against a configured spend limit`,
              );
            }
            reservationId = assertSpendPolicyAllows(control, quote);
          }
          let credential: string;
          try {
            state.signingStarted = true;
            credential = await method.createCredential(options);
          } catch (err) {
            if (control && reservationId !== undefined) control.releaseReservation(reservationId);
            throw err;
          }
          const record =
            control && reservationId !== undefined
              ? control.settleReservation(reservationId, { action: "mpp tempo charge" })
              : undefined;
          budget?.recordSigned(quoteMicros);
          return { credential, record };
        })();
        signedOnce.set(key, state);
        attempt = state;
      }
      let signed: Signed;
      try {
        signed = await attempt.promise;
      } catch (err) {
        // A failed policy reservation is known to precede signing; let a later
        // attempt re-check the changed spend state. Once the method started,
        // keep the rejection because signing may be ambiguous.
        if (!attempt.signingStarted && signedOnce.get(key) === attempt) signedOnce.delete(key);
        throw err;
      }
      markSigned(signed.credential, credit, signed.record);
      return signed.credential;
    },
  };
  return { ...method, ...guarded } as M;
}

export function createMppFetch(
  account: Account,
  base: typeof fetch = fetch,
  opts: MppFetchOptions,
): PayFetch {
  assertMppIntegration(opts?.integration, "Tempo");
  const integration = Object.freeze({ ...opts.integration });
  // Remember the last 402 the upstream sent. mppx throws "No method found for challenges" when a 402
  // offers nothing this client can pay (e.g. a non-MPP gateway); callers expect to see that 402, not
  // an exception, so the proxy can classify it as a payment error like the other rails do.
  // Kept per call (AsyncLocalStorage), not per fetch instance: concurrent requests share this fetch.
  const calls = new AsyncLocalStorage<{ last402?: Response }>();
  const pendingFulfillments = new Set<Promise<void>>();
  const fulfillmentFailures: unknown[] = [];
  const trackFulfillment = (task: Promise<void>) => {
    let tracked!: Promise<void>;
    tracked = task.then(
      () => {
        pendingFulfillments.delete(tracked);
      },
      (error) => {
        fulfillmentFailures.push(error);
        pendingFulfillments.delete(tracked);
      },
    );
    pendingFulfillments.add(tracked);
  };
  const recording: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    const call = calls.getStore();
    if (call) call.last402 = res.status === 402 ? res.clone() : undefined;
    const paid = currentPaidCall();
    if (res.status !== 402 && paid?.signed && paid.payment) {
      return recordMppFulfillment(
        { input, init, response: res, payment: paid.payment, gate: paid.gate },
        integration.onFulfillment,
        trackFulfillment,
      );
    }
    return res;
  };
  // polyfill:false keeps globalThis.fetch untouched: only calls routed through this wrapper can pay.
  // `mppx` is an optional peer dependency, loaded on the first paid call (see mpp-optional.ts).
  const { spend, usdAssets } = opts;
  let mppxPromise: Promise<ReturnType<typeof MppxClient.create>> | undefined;
  const getMppx = () =>
    (mppxPromise ??= mppxClientDeps.load().then(({ Mppx, tempo }) =>
      Mppx.create({
        methods: tempo({ account }).map((m) => guardMethod(m, spend, usdAssets, integration.gate)),
        polyfill: false,
        fetch: recording,
      }),
    ));

  const payFetch: PayFetch = async (input, init) => {
    const call: { last402?: Response } = {};
    const mppx = await getMppx();
    const budget = paymentBudgetFromInit(init);
    const cleanInit = stripPaymentBudgetFromInit(init);
    try {
      // After a credential is signed, a failed or non-2xx result ends in MppPaidNoCompletionError.
      return await runWithMppPaymentBudget(budget, () =>
        calls.run(call, () =>
          guardPaid(spend, () => mppx.fetch(input, cleanInit), account.address),
        ),
      );
    } catch (e) {
      if (call.last402 && /No method found for challenges/.test((e as Error).message)) {
        return call.last402;
      }
      throw e;
    }
  };
  payFetch.enforcesSpend = opts.spend !== undefined;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  payFetch.onNoCompletion = rejectPaidNoCompletion;
  payFetch.isPaidResponse = isPaidResponse;
  payFetch.flush = async () => {
    await Promise.all([...pendingFulfillments]);
    const errors = fulfillmentFailures.splice(0);
    try {
      await integration.flush();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "MPP fulfillment records did not flush");
  };
  return payFetch;
}

export type TempoChargeChallenge = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: {
    amount?: string;
    currency?: string;
    recipient?: string;
    methodDetails?: { chainId?: number };
  };
};

/** Parse one `WWW-Authenticate: Payment` Tempo charge header. Throws if the header is not that shape. */
export function parseTempoChargeHeader(header: string): TempoChargeChallenge {
  const pick = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)?.[1];
  const id = pick("id");
  const realm = pick("realm");
  const method = pick("method");
  const intent = pick("intent");
  const requestB64 = pick("request");
  if (!id || !method || !intent || !requestB64) throw new Error("unparsed Tempo MPP challenge");
  const parsed: unknown = JSON.parse(Buffer.from(requestB64, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unparsed Tempo MPP challenge");
  }
  return { id, realm, method, intent, request: parsed as TempoChargeChallenge["request"] };
}

export type TempoFixtureFetchOptions = {
  /** Actual payer identity supplied by the caller, distinct from the seller recipient. */
  payer: string;
  /** When set, the challenge is checked and reserved before `sign` runs. */
  spend?: SpendControl;
  /** Extra TIP-20 assets to treat as 6-decimal USD. */
  usdAssets?: Iterable<string>;
  /**
   * Produce the signed payload for this challenge. No key file and no network: the caller supplies it.
   * Called at most once per challenge quote; a later call resends the same credential.
   */
  sign: (challenge: TempoChargeChallenge) => string | Promise<string>;
  /** Seller. Tests pass a stub; this helper never calls `globalThis.fetch`. */
  fetch: typeof fetch;
};

/**
 * Tempo charge completion without mppx.
 *
 * `createMppFetch` loads mppx and signs with a viem account. This runs the same spend checks
 * (price, network, asset, payee, reserve, then settle) and attaches one cached `Payment`
 * credential via `opts.fetch`.
 */
export function createTempoFixtureFetch(opts: TempoFixtureFetchOptions): PayFetch {
  const usd = new Set(
    [...DEFAULT_TEMPO_USD_ASSETS, ...(opts.usdAssets ?? [])].map((a) => a.toLowerCase()),
  );
  const signedOnce = new Map<string, { credential: string; record?: SpendRecord }>();
  const reuseKey = (challenge: TempoChargeChallenge) => {
    const quote = quoteFromChallenge(challenge, usd);
    return `${challenge.id}|${quote.amount ?? ""}|${quote.asset ?? ""}|${quote.payTo ?? ""}|${quote.network ?? ""}`;
  };

  const credentialFor = async (challenge: TempoChargeChallenge): Promise<string> => {
    const cached = signedOnce.get(reuseKey(challenge));
    const credit = creditFromChallenge(challenge, opts.payer);
    if (!credit) throw new Error("challenge is missing payer, amount, or id");
    if (cached) {
      markSigned(cached.credential, credit, cached.record);
      return cached.credential;
    }
    const { spend } = opts;
    let reservationId: string | undefined;
    if (spend) {
      const quote = quoteFromChallenge(challenge, usd);
      if (!quote.priceable && spend.hasAmountLimits()) {
        throw new SpendPolicyError(
          `MPP quote is in an asset or shape ClawRouter cannot price (${quote.asset ?? "none"}); refusing to pay against a configured spend limit`,
        );
      }
      reservationId = assertSpendPolicyAllows(spend, {
        payTo: quote.payTo,
        network: quote.network,
        asset: quote.asset,
        amount: quote.amount,
      });
    }
    let payload: string;
    try {
      payload = await opts.sign(challenge);
    } catch (err) {
      if (spend && reservationId !== undefined) spend.releaseReservation(reservationId);
      throw err;
    }
    const credential = payload.startsWith("Payment ") ? payload : `Payment ${payload}`;
    const record =
      spend && reservationId !== undefined
        ? spend.settleReservation(reservationId, { action: "mpp tempo charge" })
        : undefined;
    signedOnce.set(reuseKey(challenge), { credential, record });
    markSigned(credential, credit, record);
    return credential;
  };

  const payFetch: PayFetch = async (input, init) =>
    guardPaid(
      opts.spend,
      async () => {
        const challengeRes = await opts.fetch(input, init);
        if (challengeRes.status !== 402) return challengeRes;
        const header = challengeRes.headers.get("www-authenticate");
        let challenge: TempoChargeChallenge;
        try {
          if (!header) return challengeRes;
          challenge = parseTempoChargeHeader(header);
        } catch {
          return challengeRes;
        }
        if (challenge.method !== "tempo" || challenge.intent !== "charge") return challengeRes;
        const credential = await credentialFor(challenge);
        const headers = new Headers(init?.headers);
        headers.set("authorization", credential);
        return opts.fetch(input, { ...init, headers });
      },
      opts.payer,
    );
  payFetch.enforcesSpend = opts.spend !== undefined;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  payFetch.onNoCompletion = rejectPaidNoCompletion;
  payFetch.isPaidResponse = isPaidResponse;
  return payFetch;
}
