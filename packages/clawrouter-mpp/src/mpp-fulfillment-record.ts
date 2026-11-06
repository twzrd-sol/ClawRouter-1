import { createHash } from "node:crypto";
import type { MppGateDecision } from "./mpp-gate.js";

export const MPP_FULFILLMENT_RECORD_SCHEMA = "twzrd.mpp.fulfillment.v2";
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
  /**
   * Byte length of the complete response body as received. null when the recorder did not read
   * the body, it exceeded MPP_FULFILLMENT_MAX_BODY_BYTES, or it was cancelled or errored first.
   */
  response_bytes: number | null;
  /** Lowercase hex SHA-256 of the same complete body; null under the same conditions. */
  body_sha256: string | null;
};

/** Size and digest of a complete response body, or null fields when it was not fully read. */
export type MppBodyDigest = { response_bytes: number | null; body_sha256: string | null };

const NO_BODY_DIGEST: MppBodyDigest = { response_bytes: null, body_sha256: null };

export type MppFulfillmentInput = {
  input: RequestInfo | URL;
  init?: RequestInit;
  response: Response;
  payment: MppPaymentFacts;
  gate?: MppGateDecision;
};

export type MppFulfillmentSink = (record: MppFulfillmentRecord) => void | Promise<void>;
export type MppFulfillmentPendingHook = (pending: Promise<void>) => void;

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
  const hash = createHash("sha256");

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
      if (totalBytes <= MPP_FULFILLMENT_MAX_BODY_BYTES) hash.update(chunk);
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
    /** Digest of every pushed byte; call only after the source stream reported done. */
    digest(): MppBodyDigest {
      return totalBytes > MPP_FULFILLMENT_MAX_BODY_BYTES
        ? NO_BODY_DIGEST
        : { response_bytes: totalBytes, body_sha256: hash.digest("hex") };
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

/** Read a whole body up to the cap. null when absent, over the cap, or the read errored. */
async function readBodyCapped(body: ReadableStream<Uint8Array> | null): Promise<Buffer | null> {
  if (!body) return null;
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
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

function parseJson(bytes: Buffer | null): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function digestOf(bytes: Buffer | null): MppBodyDigest {
  return bytes
    ? {
        response_bytes: bytes.byteLength,
        body_sha256: createHash("sha256").update(bytes).digest("hex"),
      }
    : NO_BODY_DIGEST;
}

async function readJsonCapped(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  return parseJson(await readBodyCapped(body));
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
  digest: MppBodyDigest,
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
    response_bytes: digest.response_bytes,
    body_sha256: digest.body_sha256,
  };
  await sink(row);
}

/** Capture receipt facts and seller-reported model metadata without consuming the response. */
export function recordMppFulfillment(
  input: MppFulfillmentInput,
  sink: MppFulfillmentSink,
  onPending?: MppFulfillmentPendingHook,
): Response {
  const track = (pending: Promise<void>) => {
    onPending?.(pending);
    // The response path remains non-blocking. Rail.flush() can await this task
    // and surface persistence failures to the orderly-shutdown caller.
    void pending.catch(() => {});
  };
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
    const reader = input.response.body.getReader();
    let resolveRecording!: () => void;
    let rejectRecording!: (error: unknown) => void;
    const recording = new Promise<void>((resolve, reject) => {
      resolveRecording = resolve;
      rejectRecording = reject;
    });
    track(recording);
    let recordingStarted = false;
    const finishRecord = (
      receipt: DecodedReceipt,
      sellerReportedModel: string | null,
      digest: MppBodyDigest,
    ) => {
      if (recordingStarted) return;
      recordingStarted = true;
      const write = requestBody.then((request) =>
        emitRecord(input, receipt, request, undefined, sink, digest, sellerReportedModel),
      );
      void write.then(resolveRecording, rejectRecording);
      void write.catch(() => {
        process.emitWarning("MPP fulfillment record failed; call payFetch.flush() to inspect", {
          code: "TWZRD_MPP_FULFILLMENT_RECORD_FAILED",
        });
      });
    };
    const tapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            const parsed = parser.finish();
            finishRecord(parsed.receipt, parsed.sellerReportedModel, parser.digest());
            controller.close();
            reader.releaseLock();
            return;
          }
          parser.push(value);
          controller.enqueue(value);
        } catch (error) {
          finishRecord({ state: "unavailable", value: null }, null, NO_BODY_DIGEST);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        const parsed = parser.finish();
        const receipt =
          parsed.receipt.state === "missing"
            ? { state: "unavailable" as const, value: null }
            : parsed.receipt;
        // A cancelled stream never reached its end: no digest, even of the bytes seen so far.
        finishRecord(receipt, parsed.sellerReportedModel, NO_BODY_DIGEST);
      },
    });
    return wrappedResponse(input.response, tapped);
  }
  const responseBody = bodyIsJson(input.response.headers)
    ? readBodyCapped(input.response.clone().body)
    : Promise.resolve(null);
  const recording = Promise.all([requestBody, responseBody]).then(([request, bytes]) =>
    emitRecord(input, receipt, request, parseJson(bytes), sink, digestOf(bytes)),
  );
  track(recording);
  void recording.catch(() => {
    process.emitWarning("MPP fulfillment record failed; call payFetch.flush() to inspect", {
      code: "TWZRD_MPP_FULFILLMENT_RECORD_FAILED",
    });
  });
  return input.response;
}
