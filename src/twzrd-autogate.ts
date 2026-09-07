/**
 * Opt-in TWZRD AutoGate on the existing x402 onBeforePaymentCreation chain.
 *
 * Default OFF. SpendControl remains the vendor-neutral path (#205 / #268 / #304).
 * This is not a re-open of withdrawn #218 (default-on vendor lock).
 *
 * When TWZRD_AUTO_GATE=1 (or TWZRD_GATE_ENABLED=true), compose
 * installTwzrdAutoGate / createTwzrdBeforePaymentHook AFTER registerSpendPolicyHook
 * so a wash payTo is refused before sign. Identity header:
 *   X-Twzrd-Caller: clawrouter/<version>
 *
 * Fail closed on a real module error; fail open only when twzrd-x402-gate itself
 * is missing (optionalDependency — forks may omit it).
 */

import { randomUUID } from "node:crypto";
import { VERSION } from "./version.js";

export const TWZRD_GATE_PACKAGE = "twzrd-x402-gate";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export type BeforePaymentCreationResult = void | { abort: true; reason: string };

export type BeforePaymentCreationContext = {
  selectedRequirements: Record<string, unknown>;
  paymentRequired?: unknown;
};

export type X402ClientLike = {
  onBeforePaymentCreation: (
    hook: (context: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>,
  ) => unknown;
};

export type TwzrdGateInstallOptions = {
  refuseWashFlagged: boolean;
  gateOnCanSpend: boolean;
  unsupportedNetworkMode: "observe" | "strict";
  attribution: { integration: string; runId: string };
};

export type TwzrdGateModule = {
  installTwzrdAutoGate?: (client: X402ClientLike, options?: TwzrdGateInstallOptions) => unknown;
  createTwzrdBeforePaymentHook?: (
    options?: TwzrdGateInstallOptions,
  ) => (
    requirements: Record<string, unknown>,
    context?: unknown,
  ) => Promise<BeforePaymentCreationResult>;
};

export type LoadTwzrdGate = () => Promise<TwzrdGateModule>;

export type ComposeTwzrdAutoGateResult =
  | { status: "skipped" }
  | { status: "composed"; via: "installTwzrdAutoGate" | "createTwzrdBeforePaymentHook" }
  | { status: "unavailable"; reason: string };

function normalizeFlag(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * True only when an operator explicitly opts in. Unset is off.
 * An explicit disable (`0` / `false` / `no` / `off`) on either flag wins.
 */
export function isTwzrdAutoGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const auto = normalizeFlag(env.TWZRD_AUTO_GATE);
  const gate = normalizeFlag(env.TWZRD_GATE_ENABLED);
  if ((auto !== undefined && FALSY.has(auto)) || (gate !== undefined && FALSY.has(gate))) {
    return false;
  }
  return (auto !== undefined && TRUTHY.has(auto)) || (gate !== undefined && TRUTHY.has(gate));
}

/** Fail-open only when the absent package is the optional gate itself. */
export function isMissingTwzrdGateModule(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  const missingModule =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find module/i.test(msg) ||
    /Cannot find package/i.test(msg);
  return missingModule && new RegExp(String.raw`['"]${TWZRD_GATE_PACKAGE}['"]`).test(msg);
}

export function twzrdAutoGateInstallOptions(
  runId: () => string = randomUUID,
): TwzrdGateInstallOptions {
  return {
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    unsupportedNetworkMode: "observe",
    attribution: {
      integration: `clawrouter/${VERSION}`,
      runId: runId(),
    },
  };
}

export async function defaultLoadTwzrdGate(): Promise<TwzrdGateModule> {
  // Variable specifier so tsup/esbuild cannot statically inline the optional dep
  // (the build uses noExternal: [/.*/]).
  const specifier: string = TWZRD_GATE_PACKAGE;
  return import(specifier) as Promise<TwzrdGateModule>;
}

/**
 * Compose TWZRD onto an x402 client that already has SpendControl registered.
 * Does nothing unless the opt-in flag is set. Never replaces SpendControl.
 */
export async function maybeComposeTwzrdAutoGate(
  x402: X402ClientLike,
  options?: {
    env?: NodeJS.ProcessEnv;
    loadGate?: LoadTwzrdGate;
    log?: Pick<Console, "log" | "warn">;
  },
): Promise<ComposeTwzrdAutoGateResult> {
  const env = options?.env ?? process.env;
  const log = options?.log ?? console;
  if (!isTwzrdAutoGateEnabled(env)) {
    return { status: "skipped" };
  }

  const load = options?.loadGate ?? defaultLoadTwzrdGate;
  let gate: TwzrdGateModule;
  try {
    gate = await load();
  } catch (err) {
    if (isMissingTwzrdGateModule(err)) {
      const reason = `${TWZRD_GATE_PACKAGE} is not installed`;
      log.warn(
        `[ClawRouter] TWZRD AutoGate opted in but ${reason} — skipping. npm i ${TWZRD_GATE_PACKAGE}@0.9.3`,
      );
      return { status: "unavailable", reason };
    }
    throw err;
  }

  const installOpts = twzrdAutoGateInstallOptions();

  if (typeof gate.installTwzrdAutoGate === "function") {
    gate.installTwzrdAutoGate(x402, installOpts);
    log.log(
      "[ClawRouter] TWZRD AutoGate ON (opt-in, after SpendControl). Unset TWZRD_AUTO_GATE to disable.",
    );
    return { status: "composed", via: "installTwzrdAutoGate" };
  }

  if (typeof gate.createTwzrdBeforePaymentHook === "function") {
    const hook = gate.createTwzrdBeforePaymentHook(installOpts);
    x402.onBeforePaymentCreation(async (ctx) => hook(ctx.selectedRequirements, ctx));
    log.log(
      "[ClawRouter] TWZRD AutoGate ON (opt-in, after SpendControl). Unset TWZRD_AUTO_GATE to disable.",
    );
    return { status: "composed", via: "createTwzrdBeforePaymentHook" };
  }

  throw new Error(
    `[ClawRouter] ${TWZRD_GATE_PACKAGE} is installed but exports neither installTwzrdAutoGate nor createTwzrdBeforePaymentHook`,
  );
}
