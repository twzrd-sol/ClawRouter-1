import type { MppGateDecision } from "./mpp-gate.js";

export const MPP_FULFILLMENT_RECORD_SCHEMA = "twzrd.mpp.fulfillment.v1";
export const MPP_FULFILLMENT_MAX_BODY_BYTES = 1024 * 1024;

export type MppPaymentFacts = {
  challengeId: string;
  method: string;
  intent: string;
  payTo: string | null;
  network: string | null;
  asset: string | null;
  amountAtomic: string | null;
};

export type MppFulfillmentRecord = {
  schema: typeof MPP_FULFILLMENT_RECORD_SCHEMA;
  at_unix_ms: number;
  resource_origin: string | null;
  http_status: number;
  payment_method: string;
  payment_intent: string;
  challenge_id: string;
  paid_to: string | null;
  network: string | null;
  asset: string | null;
  amount_atomic: string | null;
  receipt_state: "valid_format" | "missing" | "invalid_format" | "unavailable";
  receipt_status: string | null;
  receipt_method: string | null;
  /** Seller-supplied MPP receipt reference (EVM hash or Solana signature); not chain-verified here. */
  receipt_reference: string | null;
  receipt_timestamp: string | null;
  requested_model: string | null;
  /** Model label reported by the seller. This is not an attestation of model identity. */
  seller_reported_model: string | null;
  /** Equality of seller-reported and requested labels only; this does not verify the served model. */
  seller_reported_model_matches_request: boolean | null;
  gate: MppGateDecision | null;
};

export type MppFulfillmentInput = {
  input: RequestInfo | URL;
  init?: RequestInit;
  response: Response;
  payment: MppPaymentFacts;
  gate?: MppGateDecision;
};

export type MppFulfillmentSink = (record: MppFulfillmentRecord) => void | Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function originOf(input: RequestInfo | URL): string | null {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type DecodedReceipt = {
  state: MppFulfillmentRecord["receipt_state"];
  value: Record<string, unknown> | null;
};

function decodeReceiptObject(
  value: unknown,
  challengeId: string,
  expectedIntent: string,
  expectedMethod: string,
): DecodedReceipt {
  const receipt = asRecord(value);
  if (
    !receipt ||
    string(receipt.method) !== expectedMethod ||
    !string(receipt.reference) ||
    receipt.status !== "success" ||
    !isTimestamp(receipt.timestamp)
  ) {
    return { state: "invalid_format", value: null };
  }
  // Standard charge receipts omit `intent`; session receipts carry it. Reject
  // an explicitly different intent so charge and session evidence cannot mix.
  if (
    (typeof receipt.intent === "string" && receipt.intent !== expectedIntent) ||
    (expectedIntent !== "charge" && receipt.intent !== expectedIntent) ||
    (expectedIntent === "session" &&
      (receipt.method !== "tempo" ||
        receipt.challengeId !== challengeId ||
        typeof receipt.channelId !== "string" ||
        typeof receipt.acceptedCumulative !== "string" ||
        typeof receipt.spent !== "string"))
  ) {
    return { state: "invalid_format", value: null };
  }
  return { state: "valid_format", value: receipt };
}

function decodeReceipt(
  encoded: string | null,
  challengeId: string,
  expectedIntent: string,
  expectedMethod: string,
): DecodedReceipt {
  if (!encoded) return { state: "missing", value: null };
  try {
    return decodeReceiptObject(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
      challengeId,
      expectedIntent,
      expectedMethod,
    );
  } catch {
    return { state: "invalid_format", value: null };
  }
}

function createSseReceiptParser(
  challengeId: string,
  expectedIntent: string,
  expectedMethod: string,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let data: string[] = [];
  let totalBytes = 0;
  let unavailable = false;
  let receipt: DecodedReceipt | undefined;
  let sellerReportedModel: string | null = null;

  const finishEvent = () => {
    if (data.length && eventName === "payment-receipt" && !receipt) {
      try {
        receipt = decodeReceiptObject(
          JSON.parse(data.join("\n")) as unknown,
          challengeId,
          expectedIntent,
          expectedMethod,
        );
      } catch {
        receipt = { state: "invalid_format", value: null };
      }
    } else if (data.length && (!eventName || eventName === "message") && !sellerReportedModel) {
      try {
        sellerReportedModel = string(asRecord(JSON.parse(data.join("\n")) as unknown)?.model);
      } catch {
        // Non-JSON SSE data and [DONE] are not model labels.
      }
    }
    eventName = "";
    data = [];
  };
  const line = (raw: string) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!value) return finishEvent();
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    const fieldValue = separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = fieldValue;
    if (field === "data" && data.join("\n").length + fieldValue.length <= 16 * 1024)
      data.push(fieldValue);
  };
  return {
    push(chunk: Uint8Array) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MPP_FULFILLMENT_MAX_BODY_BYTES) {
        unavailable = true;
        buffer = "";
        data = [];
        return;
      }
      if (unavailable) return;
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 16 * 1024) {
        unavailable = true;
        buffer = "";
      }
    },
    finish(): { receipt: DecodedReceipt; sellerReportedModel: string | null } {
      if (!unavailable && !receipt) {
        buffer += decoder.decode();
        if (buffer) line(buffer);
        finishEvent();
      }
      return {
        receipt: receipt ?? { state: unavailable ? "unavailable" : "missing", value: null },
        sellerReportedModel,
      };
    },
  };
}

async function readJsonCapped(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MPP_FULFILLMENT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function bodyIsJson(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().includes("json");
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (!bodyIsJson(headers)) return undefined;
  if (typeof init?.body === "string") {
    if (Buffer.byteLength(init.body, "utf8") > MPP_FULFILLMENT_MAX_BODY_BYTES) return undefined;
    try {
      return JSON.parse(init.body) as unknown;
    } catch {
      return undefined;
    }
  }
  if (input instanceof Request && init?.body === undefined) {
    try {
      return await readJsonCapped(input.clone().body);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function wrappedResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
}

async function emitRecord(
  input: MppFulfillmentInput,
  receipt: DecodedReceipt,
  requestValue: unknown,
  responseValue: unknown,
  sink: MppFulfillmentSink,
  sellerModelOverride?: string | null,
): Promise<void> {
  const req = asRecord(requestValue);
  const res = asRecord(responseValue);
  const requestedModel = string(req?.model);
  const sellerReportedModel = string(sellerModelOverride) ?? string(res?.model);
  const row: MppFulfillmentRecord = {
    schema: MPP_FULFILLMENT_RECORD_SCHEMA,
    at_unix_ms: Date.now(),
    resource_origin: originOf(input.input),
    http_status: input.response.status,
    payment_method: input.payment.method,
    payment_intent: input.payment.intent,
    challenge_id: input.payment.challengeId,
    paid_to: input.payment.payTo,
    network: input.payment.network,
    asset: input.payment.asset,
    amount_atomic: input.payment.amountAtomic,
    receipt_state: receipt.state,
    receipt_status: string(receipt.value?.status),
    receipt_method: string(receipt.value?.method),
    receipt_reference: string(receipt.value?.reference),
    receipt_timestamp: string(receipt.value?.timestamp),
    requested_model: requestedModel,
    seller_reported_model: sellerReportedModel,
    seller_reported_model_matches_request:
      requestedModel && sellerReportedModel
        ? requestedModel.toLowerCase() === sellerReportedModel.toLowerCase()
        : null,
    gate: input.gate ?? null,
  };
  try {
    await sink(row);
  } catch {
    // A record sink must never reach the payment path, including rejected promises.
  }
}

/** Capture receipt facts and seller-reported model metadata without consuming the response. */
export function recordMppFulfillment(
  input: MppFulfillmentInput,
  sink: MppFulfillmentSink,
): Response {
  const receipt = decodeReceipt(
    input.response.headers.get("payment-receipt"),
    input.payment.challengeId,
    input.payment.intent,
    input.payment.method,
  );
  const requestBody = readRequestBody(input.input, input.init);
  const isSse = (input.response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
  if (
    isSse &&
    receipt.state === "missing" &&
    input.response.body &&
    input.response.status !== 204 &&
    input.response.status !== 205
  ) {
    const parser = createSseReceiptParser(
      input.payment.challengeId,
      input.payment.intent,
      input.payment.method,
    );
    const requestValue = requestBody;
    const tapped = input.response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          parser.push(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          const parsed = parser.finish();
          void requestValue
            .then((request) =>
              emitRecord(
                input,
                parsed.receipt,
                request,
                undefined,
                sink,
                parsed.sellerReportedModel,
              ),
            )
            .catch(() => {
              // Recording is detached from stream completion and payment behavior.
            });
        },
      }),
    );
    return wrappedResponse(input.response, tapped);
  }
  const responseBody = bodyIsJson(input.response.headers)
    ? readJsonCapped(input.response.clone().body)
    : Promise.resolve(undefined);
  void Promise.all([requestBody, responseBody])
    .then(([request, response]) => emitRecord(input, receipt, request, response, sink))
    .catch(() => {
      // A record read failure must never reach the payment path.
    });
  return input.response;
}
