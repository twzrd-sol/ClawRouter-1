/**
 * A2A x402 compatibility primitives.
 *
 * This is deliberately transport- and chain-agnostic. It maps the A2A
 * payment-required/payment-submitted/receipt lifecycle onto ClawRouter's
 * existing policy-before-sign path. A real wallet/facilitator is injected by
 * the caller; the HMAC helpers are only for hermetic integration tests and
 * release-gate smoke runs.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  assertSpendPolicyAllows,
  SpendControl,
  type QuotedRequirements,
} from "./spend-control.js";

export const A2A_X402_EXTENSION_URI = "https://github.com/google-a2a/a2a-x402/v0.1";

export const A2A_PAYMENT_METADATA = {
  status: "x402.payment.status",
  required: "x402.payment.required",
  payload: "x402.payment.payload",
  receipts: "x402.payment.receipts",
  error: "x402.payment.error",
} as const;

export type A2APaymentStatus =
  | "payment-required"
  | "payment-submitted"
  | "payment-verified"
  | "payment-rejected"
  | "payment-completed"
  | "payment-failed";

export type A2ATaskState = "input-required" | "working" | "completed" | "failed";

export type A2AErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_ID_MISMATCH"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_REQUIREMENT_MISMATCH"
  | "DUPLICATE_NONCE"
  | "EXPIRED_PAYMENT"
  | "INVALID_SIGNATURE"
  | "NETWORK_MISMATCH"
  | "INVALID_AMOUNT"
  | "SETTLEMENT_FAILED";

export type A2APaymentRequirement = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  resource?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type A2APaymentRequiredResponse = {
  x402Version: number;
  accepts: A2APaymentRequirement[];
};

export type A2APaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
};

export type A2ASignedPayment = {
  taskId: string;
  nonce: string;
  requirementHash: string;
  validBefore: number;
  payment: A2APaymentPayload;
  signature: string;
};

export type A2AMessage = {
  taskId?: string;
  role: "agent" | "user";
  parts: Array<{ kind: "text"; text: string }>;
  metadata: Record<string, unknown>;
};

export type A2ATask = {
  id: string;
  createdAt: number;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
  };
  artifacts?: Array<Record<string, unknown>>;
};

export type A2AReceipt = {
  success: boolean;
  network: string;
  transaction?: string;
  payer?: string;
  errorReason?: string;
};

export class A2APaymentError extends Error {
  readonly code: A2AErrorCode;

  constructor(code: A2AErrorCode, message: string) {
    super(message);
    this.name = "A2APaymentError";
    this.code = code;
  }
}

export type A2ASigningIntent = {
  taskId: string;
  nonce: string;
  requirementHash: string;
  validBefore: number;
  x402Version: number;
  requirement: A2APaymentRequirement;
};

export type A2ASigner = (
  intent: A2ASigningIntent,
) => Promise<Pick<A2ASignedPayment, "payment" | "signature">>;

export type A2AVerificationContext = {
  authorization: A2ASignedPayment;
  requirement: A2APaymentRequirement;
};

export type A2AVerifier = (context: A2AVerificationContext) => Promise<boolean>;

export type A2ASettlement = (context: A2AVerificationContext) => Promise<A2AReceipt>;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

function requirementHash(requirement: A2APaymentRequirement): string {
  return createHash("sha256").update(canonicalize(requirement)).digest("hex");
}

function signingBytes(intent: A2ASigningIntent, payment: A2APaymentPayload): string {
  return canonicalize({
    taskId: intent.taskId,
    nonce: intent.nonce,
    requirementHash: intent.requirementHash,
    validBefore: intent.validBefore,
    x402Version: intent.x402Version,
    payment,
  });
}

function amountQuote(requirement: A2APaymentRequirement): QuotedRequirements {
  return {
    payTo: requirement.payTo,
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.amount,
    maxAmountRequired: requirement.maxAmountRequired,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paymentClaimsMatchRequirement(
  payment: A2APaymentPayload,
  requirement: A2APaymentRequirement,
): boolean {
  const claims = payment.payload;
  if (!isRecord(claims)) return false;
  const amount = requirement.amount ?? requirement.maxAmountRequired;
  if (claims.payTo !== undefined && claims.payTo !== requirement.payTo) return false;
  if (claims.asset !== undefined && claims.asset !== requirement.asset) return false;
  if (amount !== undefined && claims.amount !== undefined && claims.amount !== amount) return false;
  if (
    claims.requirementHash !== undefined &&
    (typeof claims.requirementHash !== "string" || claims.requirementHash !== requirementHash(requirement))
  ) return false;
  return true;
}

function requiredMessage(response: A2APaymentRequiredResponse): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "text", text: "Payment is required for this service." }],
    metadata: {
      [A2A_PAYMENT_METADATA.status]: "payment-required" satisfies A2APaymentStatus,
      [A2A_PAYMENT_METADATA.required]: response,
    },
  };
}

/** Build an A2A `input-required` task containing x402 payment requirements. */
export function createPaymentRequiredTask(
  taskId: string,
  response: A2APaymentRequiredResponse,
  now = Date.now(),
): A2ATask {
  if (!taskId) throw new Error("A2A taskId is required");
  if (!Number.isInteger(response.x402Version) || response.accepts.length === 0) {
    throw new Error("A2A payment requirements must include at least one payment option");
  }
  for (const requirement of response.accepts) {
    if (!requirement.scheme || !requirement.network || !requirement.asset || !requirement.payTo) {
      throw new Error("A2A payment requirements must include scheme, network, asset, and payTo");
    }
    if (
      requirement.maxTimeoutSeconds !== undefined &&
      (!Number.isFinite(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds <= 0)
    ) {
      throw new Error("A2A payment requirement timeout must be positive");
    }
  }
  return {
    id: taskId,
    createdAt: now,
    status: { state: "input-required", message: requiredMessage(response) },
  };
}

/** Create the correlated A2A message carrying a signed payment payload. */
export function createPaymentSubmissionMessage(taskId: string, payment: A2ASignedPayment): A2AMessage {
  if (payment.taskId !== taskId) {
    throw new A2APaymentError("TASK_ID_MISMATCH", "Payment taskId does not match the submission task");
  }
  return {
    taskId,
    role: "user",
    parts: [{ kind: "text", text: "Payment authorization provided." }],
    metadata: {
      [A2A_PAYMENT_METADATA.status]: "payment-submitted" satisfies A2APaymentStatus,
      [A2A_PAYMENT_METADATA.payload]: payment,
    },
  };
}

/** AgentCard declaration for the extension. */
export function getA2AExtensionDeclaration(required = true): {
  uri: string;
  description: string;
  required: boolean;
} {
  return {
    uri: A2A_X402_EXTENSION_URI,
    description: "Supports x402 payments for agent-to-agent services.",
    required,
  };
}

/** Request/response activation helpers required by the A2A extension. */
export function hasA2AExtension(headers: Record<string, string | undefined>): boolean {
  return (headers["X-A2A-Extensions"] ?? headers["x-a2a-extensions"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .includes(A2A_X402_EXTENSION_URI);
}

export function echoA2AExtension(headers: Record<string, string>): Record<string, string> {
  return { ...headers, "X-A2A-Extensions": A2A_X402_EXTENSION_URI };
}

/**
 * Client-side policy gate. The signer is not called until SpendControl allows
 * the exact A2A counterparty and quoted amount. Signed payments settle the
 * existing reservation just like the HTTP x402 hook; signer failures release
 * it without consuming budget.
 */
export class A2AX402Client {
  private readonly spendControl: SpendControl;
  private readonly signer: A2ASigner;
  private readonly now: () => number;
  private readonly nextNonce: () => string;

  constructor(options: {
    signer: A2ASigner;
    spendControl?: SpendControl;
    now?: () => number;
    nonce?: () => string;
  }) {
    this.signer = options.signer;
    this.spendControl = options.spendControl ?? new SpendControl();
    this.now = options.now ?? (() => Date.now());
    this.nextNonce = options.nonce ?? (() => `${this.now()}-${cryptoRandom()}`);
  }

  async createPaymentSubmission(
    task: A2ATask,
    optionIndex = 0,
  ): Promise<A2AMessage> {
    const message = task.status.message;
    const response = message?.metadata[A2A_PAYMENT_METADATA.required] as
      | A2APaymentRequiredResponse
      | undefined;
    if (!response || !Array.isArray(response.accepts)) {
      throw new A2APaymentError("PAYMENT_REQUIRED", "Task does not contain A2A payment requirements");
    }
    if (task.status.state !== "input-required") {
      throw new A2APaymentError("PAYMENT_REQUIRED", `Task ${task.id} is not awaiting payment`);
    }
    const requirement = response.accepts[optionIndex];
    if (!requirement) throw new A2APaymentError("PAYMENT_REQUIRED", "Requested payment option does not exist");

    const validBefore = task.createdAt + (requirement.maxTimeoutSeconds ?? 600) * 1000;
    if (this.now() >= validBefore) {
      throw new A2APaymentError("EXPIRED_PAYMENT", "A2A payment requirements have expired");
    }

    const intent: A2ASigningIntent = {
      taskId: task.id,
      nonce: this.nextNonce(),
      requirementHash: requirementHash(requirement),
      validBefore,
      x402Version: response.x402Version,
      requirement,
    };
    const reservation = assertSpendPolicyAllows(this.spendControl, amountQuote(requirement));
    try {
      const signed = await this.signer(intent);
      if (
        typeof signed.signature !== "string" ||
        !signed.signature ||
        !signed.payment ||
        signed.payment.network !== requirement.network
      ) {
        throw new A2APaymentError("NETWORK_MISMATCH", "Signer returned a payment bound to the wrong network");
      }
      if (reservation !== undefined) {
        this.spendControl.settleReservation(reservation, { action: "a2a x402 payment" });
      }
      return createPaymentSubmissionMessage(task.id, {
        ...signed,
        taskId: task.id,
        nonce: intent.nonce,
        requirementHash: intent.requirementHash,
        validBefore,
      });
    } catch (error) {
      if (reservation !== undefined) this.spendControl.releaseReservation(reservation);
      throw error;
    }
  }
}

type StoredTask = {
  task: A2ATask;
  requirements: A2APaymentRequirement[];
  x402Version: number;
  usedNonces: Set<string>;
  receipts: A2AReceipt[];
};

/**
 * Minimal merchant-side state machine. It keeps the original requirements by
 * taskId (the A2A spec's correlation invariant), verifies the signed payload,
 * rejects expiry/replay/binding failures, and appends every receipt.
 */
export class A2AX402Merchant {
  private readonly tasks = new Map<string, StoredTask>();
  private readonly verifier: A2AVerifier;
  private readonly settle: A2ASettlement;
  private readonly now: () => number;

  constructor(options: {
    verifier: A2AVerifier;
    settle?: A2ASettlement;
    now?: () => number;
  }) {
    this.verifier = options.verifier;
    this.settle = options.settle ?? (async ({ requirement, authorization }) => ({
      success: true,
      network: requirement.network,
      transaction: `a2a-memory-${authorization.nonce}`,
    }));
    this.now = options.now ?? (() => Date.now());
  }

  createTask(taskId: string, response: A2APaymentRequiredResponse): A2ATask {
    const task = createPaymentRequiredTask(taskId, response, this.now());
    this.tasks.set(taskId, {
      task,
      requirements: [...response.accepts],
      x402Version: response.x402Version,
      usedNonces: new Set(),
      receipts: [],
    });
    return task;
  }

  async receivePayment(message: A2AMessage): Promise<A2ATask> {
    if (!message.taskId) throw new A2APaymentError("TASK_ID_MISMATCH", "Payment submission must include taskId");
    const record = this.tasks.get(message.taskId);
    if (!record) throw new A2APaymentError("TASK_NOT_FOUND", `Unknown A2A task ${message.taskId}`);
    if (message.metadata[A2A_PAYMENT_METADATA.status] !== "payment-submitted") {
      return this.fail(record, "PAYMENT_REQUIRED", "Payment submission has an invalid A2A payment status");
    }
    const authorization = message.metadata[A2A_PAYMENT_METADATA.payload] as A2ASignedPayment | undefined;
    if (
      !authorization ||
      typeof authorization !== "object" ||
      authorization.taskId !== message.taskId ||
      typeof authorization.nonce !== "string" ||
      typeof authorization.signature !== "string" ||
      !authorization.payment ||
      !isRecord(authorization.payment.payload)
    ) {
      return this.fail(record, "TASK_ID_MISMATCH", "Payment payload taskId does not match the task");
    }
    const requirement = record.requirements.find((candidate) => requirementHash(candidate) === authorization.requirementHash);
    if (!requirement) {
      return this.fail(record, "PAYMENT_REQUIREMENT_MISMATCH", "Payment is not bound to the task requirements");
    }
    if (this.now() >= authorization.validBefore) {
      return this.fail(record, "EXPIRED_PAYMENT", "Payment authorization expired before submission", requirement.network);
    }
    const expectedValidBefore = record.task.createdAt + (requirement.maxTimeoutSeconds ?? 600) * 1000;
    if (authorization.validBefore !== expectedValidBefore) {
      return this.fail(record, "PAYMENT_REQUIREMENT_MISMATCH", "Payment expiry is not bound to the task requirements", requirement.network);
    }
    if (
      authorization.payment.x402Version !== record.x402Version ||
      authorization.payment.scheme !== requirement.scheme
    ) {
      return this.fail(record, "PAYMENT_REQUIREMENT_MISMATCH", "Payment version or scheme does not match the task requirements", requirement.network);
    }
    if (authorization.payment.network !== requirement.network) {
      return this.fail(record, "NETWORK_MISMATCH", "Payment network does not match the task requirements", requirement.network);
    }
    if (!paymentClaimsMatchRequirement(authorization.payment, requirement)) {
      return this.fail(record, "PAYMENT_REQUIREMENT_MISMATCH", "Payment claims do not match the task requirements", requirement.network);
    }
    if (record.usedNonces.has(authorization.nonce)) {
      return this.fail(record, "DUPLICATE_NONCE", "Payment nonce has already been used", requirement.network);
    }

    const valid = await this.verifier({ authorization, requirement });
    if (!valid) return this.fail(record, "INVALID_SIGNATURE", "Payment signature failed verification", requirement.network);

    // Consume the nonce before settlement. A failed settlement is still a
    // settlement attempt and must not be replayed with the same authorization.
    record.usedNonces.add(authorization.nonce);
    record.task.status = { state: "working" };
    let receipt: A2AReceipt;
    try {
      receipt = await this.settle({ authorization, requirement });
    } catch (error) {
      receipt = {
        success: false,
        network: requirement.network,
        errorReason: error instanceof Error ? error.message : "Settlement failed",
      };
    }
    record.receipts.push(receipt);
    if (receipt.success) {
      record.task.status = {
        state: "completed",
        message: this.resultMessage("payment-completed", record.receipts),
      };
    } else {
      record.task.status = {
        state: "failed",
        message: this.resultMessage("payment-failed", record.receipts, "SETTLEMENT_FAILED"),
      };
    }
    return record.task;
  }

  private fail(record: StoredTask, code: A2AErrorCode, reason: string, network?: string): A2ATask {
    const receipt: A2AReceipt = {
      success: false,
      network: network ?? record.requirements[0]?.network ?? "unknown",
      errorReason: reason,
    };
    record.receipts.push(receipt);
    record.task.status = {
      state: "failed",
      message: this.resultMessage("payment-failed", record.receipts, code),
    };
    return record.task;
  }

  private resultMessage(
    status: Exclude<A2APaymentStatus, "payment-required" | "payment-submitted" | "payment-rejected">,
    receipts: A2AReceipt[],
    error?: string,
  ): A2AMessage {
    return {
      role: "agent",
      parts: [{ kind: "text", text: status === "payment-completed" ? "Payment completed." : "Payment failed." }],
      metadata: {
        [A2A_PAYMENT_METADATA.status]: status,
        [A2A_PAYMENT_METADATA.receipts]: [...receipts],
        ...(error ? { [A2A_PAYMENT_METADATA.error]: error } : {}),
      },
    };
  }
}

function cryptoRandom(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);
}

/** Hermetic signer for tests/release gates; not a wallet or production signer. */
export function createHmacA2ASigner(secret: string): A2ASigner {
  return async (intent) => {
    const amount = intent.requirement.amount ?? intent.requirement.maxAmountRequired;
    const payment: A2APaymentPayload = {
      x402Version: intent.x402Version,
      scheme: intent.requirement.scheme,
      network: intent.requirement.network,
      payload: {
        taskId: intent.taskId,
        nonce: intent.nonce,
        requirementHash: intent.requirementHash,
        payTo: intent.requirement.payTo,
        asset: intent.requirement.asset,
        ...(amount !== undefined ? { amount } : {}),
      },
    };
    const signature = createHmac("sha256", secret)
      .update(signingBytes(intent, payment))
      .digest("hex");
    return { payment, signature };
  };
}

/** Hermetic verifier paired with `createHmacA2ASigner`. */
export function createHmacA2AVerifier(secret: string): A2AVerifier {
  return async ({ authorization, requirement }) => {
    const intent: A2ASigningIntent = {
      taskId: authorization.taskId,
      nonce: authorization.nonce,
      requirementHash: authorization.requirementHash,
      validBefore: authorization.validBefore,
      x402Version: authorization.payment.x402Version,
      requirement,
    };
    const expected = createHmac("sha256", secret)
      .update(signingBytes(intent, authorization.payment))
      .digest("hex");
    const actual = Buffer.from(authorization.signature, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  };
}
