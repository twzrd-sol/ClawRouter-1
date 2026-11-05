/** Optional buyer-side policy hook evaluated on the exact MPP challenge before signing. */
export type MppGateChallenge = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: Record<string, unknown>;
  expires?: string;
  description?: string;
};

/** Safe decision metadata retained with the paid response for receipt verification. */
export type MppGateDecision = {
  disposition: "allow" | "warn" | "block";
  decisionId?: string;
  intentHash?: string;
  reasonCodes?: readonly string[];
};

export function paymentFactsFromMppChallenge(challenge: MppGateChallenge) {
  const request = challenge.request;
  const details =
    request.methodDetails && typeof request.methodDetails === "object"
      ? (request.methodDetails as Record<string, unknown>)
      : {};
  const rawNetwork = details.chainId ?? request.chainId ?? details.network ?? request.network;
  return {
    challengeId: challenge.id,
    method: challenge.method,
    intent: challenge.intent,
    payTo: typeof request.recipient === "string" ? request.recipient : null,
    network:
      typeof rawNetwork === "number"
        ? `eip155:${rawNetwork}`
        : typeof rawNetwork === "string"
          ? rawNetwork
          : null,
    asset: typeof request.currency === "string" ? request.currency : null,
    amountAtomic: typeof request.amount === "string" ? request.amount : null,
  };
}

/** Return the TWZRD gate's result. Throwing or returning an invalid result fails closed. */
export type MppGateEvaluator = (
  challenge: MppGateChallenge,
) => MppGateDecision | Promise<MppGateDecision>;

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child);
  }
  return value;
}

export class MppGateError extends Error {
  readonly code: "MPP_GATE_BLOCKED" | "MPP_GATE_INVALID_RESULT";
  readonly challengeId: string;
  readonly decisionId?: string;
  readonly reasonCodes?: readonly string[];

  constructor(
    code: MppGateError["code"],
    challengeId: string,
    message: string,
    decision?: MppGateDecision,
  ) {
    super(message);
    this.name = "MppGateError";
    this.code = code;
    this.challengeId = challengeId;
    this.decisionId = decision?.decisionId;
    this.reasonCodes = decision?.reasonCodes;
  }
}

/** Evaluate and retain only receipt-safe fields. A block throws before credential creation. */
export async function evaluateMppGate(
  evaluator: MppGateEvaluator | undefined,
  challenge: MppGateChallenge,
): Promise<MppGateDecision | undefined> {
  if (!evaluator) return undefined;
  // Give integration code an immutable copy so it cannot alter the challenge
  // whose terms the rail will subsequently price and sign.
  const gateChallenge = freezeRecursively(structuredClone(challenge));
  const raw: unknown = await evaluator(gateChallenge);
  const disposition =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).disposition : null;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof disposition !== "string" ||
    !["allow", "warn", "block"].includes(disposition)
  ) {
    throw new MppGateError(
      "MPP_GATE_INVALID_RESULT",
      challenge.id,
      "MPP gate returned an invalid result; refusing payment",
    );
  }
  const result = raw as MppGateDecision;
  const decision: MppGateDecision = {
    disposition: result.disposition,
    ...(typeof result.decisionId === "string" ? { decisionId: result.decisionId } : {}),
    ...(typeof result.intentHash === "string" ? { intentHash: result.intentHash } : {}),
    ...(Array.isArray(result.reasonCodes) && result.reasonCodes.every((x) => typeof x === "string")
      ? { reasonCodes: [...result.reasonCodes] }
      : {}),
  };
  if (decision.disposition === "block") {
    throw new MppGateError(
      "MPP_GATE_BLOCKED",
      challenge.id,
      `MPP gate blocked challenge ${challenge.id}${decision.reasonCodes?.length ? `: ${decision.reasonCodes.join(",")}` : ""}`,
      decision,
    );
  }
  return decision;
}
