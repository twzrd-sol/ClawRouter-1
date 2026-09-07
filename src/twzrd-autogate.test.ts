import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isMissingTwzrdGateModule,
  isTwzrdAutoGateEnabled,
  maybeComposeTwzrdAutoGate,
  twzrdAutoGateInstallOptions,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type TwzrdGateInstallOptions,
  type X402ClientLike,
} from "./twzrd-autogate.js";
import { VERSION } from "./version.js";

function fakeClient(): {
  client: X402ClientLike;
  hooks: Array<(ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>>;
} {
  const hooks: Array<(ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>> =
    [];
  const client: X402ClientLike = {
    onBeforePaymentCreation(hook) {
      hooks.push(hook);
    },
  };
  return { client, hooks };
}

describe("isTwzrdAutoGateEnabled", () => {
  it("is off by default when both flags are unset", () => {
    expect(isTwzrdAutoGateEnabled({})).toBe(false);
  });

  it("opts in on TWZRD_AUTO_GATE=1", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "1" })).toBe(true);
  });

  it("opts in on TWZRD_GATE_ENABLED=true", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_GATE_ENABLED: "true" })).toBe(true);
  });

  it("treats true/yes/on as enable and 0/false as disable", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "yes" })).toBe(true);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "on" })).toBe(true);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "0" })).toBe(false);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "false" })).toBe(false);
    expect(isTwzrdAutoGateEnabled({ TWZRD_GATE_ENABLED: "off" })).toBe(false);
  });

  it("lets an explicit disable win over an enable on the other flag", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "1", TWZRD_GATE_ENABLED: "false" })).toBe(
      false,
    );
  });
});

describe("isMissingTwzrdGateModule", () => {
  it("matches only a missing twzrd-x402-gate package", () => {
    expect(
      isMissingTwzrdGateModule(
        Object.assign(
          new Error("Cannot find package 'twzrd-x402-gate' imported from /app/proxy.js"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
      ),
    ).toBe(true);
    expect(
      isMissingTwzrdGateModule(
        Object.assign(
          new Error(
            "Cannot find package 'some-transitive-dep' imported from /app/node_modules/twzrd-x402-gate/index.js",
          ),
          { code: "ERR_MODULE_NOT_FOUND" },
        ),
      ),
    ).toBe(false);
    expect(isMissingTwzrdGateModule(new Error("boom unrelated"))).toBe(false);
  });
});

describe("twzrdAutoGateInstallOptions", () => {
  it("stamps clawrouter/<version> so a refuse is attributable", () => {
    const opts = twzrdAutoGateInstallOptions(() => "run-1");
    expect(opts.attribution.integration).toBe(`clawrouter/${VERSION}`);
    expect(opts.attribution.runId).toBe("run-1");
    expect(opts.refuseWashFlagged).toBe(true);
    expect(opts.gateOnCanSpend).toBe(false);
    expect(opts.unsupportedNetworkMode).toBe("observe");
  });
});

describe("maybeComposeTwzrdAutoGate", () => {
  const prevAuto = process.env.TWZRD_AUTO_GATE;
  const prevGate = process.env.TWZRD_GATE_ENABLED;

  afterEach(() => {
    if (prevAuto === undefined) delete process.env.TWZRD_AUTO_GATE;
    else process.env.TWZRD_AUTO_GATE = prevAuto;
    if (prevGate === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = prevGate;
  });

  it("does not load or register anything on the default path", async () => {
    const loadGate = vi.fn();
    const { client, hooks } = fakeClient();
    const spendHook = async () => undefined;
    client.onBeforePaymentCreation(spendHook);

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: {},
      loadGate,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(loadGate).not.toHaveBeenCalled();
    expect(hooks).toEqual([spendHook]);
  });

  it("composes installTwzrdAutoGate after an existing SpendControl hook", async () => {
    const { client, hooks } = fakeClient();
    const spendHook = async () => undefined;
    client.onBeforePaymentCreation(spendHook);

    let invoked = 0;
    const installTwzrdAutoGate = vi.fn((x402: X402ClientLike, opts?: TwzrdGateInstallOptions) => {
      expect(opts?.attribution.integration).toBe(`clawrouter/${VERSION}`);
      x402.onBeforePaymentCreation(async () => {
        invoked += 1;
      });
    });

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => ({ installTwzrdAutoGate }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "composed", via: "installTwzrdAutoGate" });
    expect(installTwzrdAutoGate).toHaveBeenCalledTimes(1);
    expect(hooks[0]).toBe(spendHook);
    expect(hooks).toHaveLength(2);

    await hooks[1]!({
      selectedRequirements: { payTo: "Seller1111111111111111111111111111111111111" },
    });
    expect(invoked).toBe(1);
  });

  it("falls back to createTwzrdBeforePaymentHook and invokes it", async () => {
    const { client, hooks } = fakeClient();
    const seen: unknown[] = [];
    const createTwzrdBeforePaymentHook = vi.fn(() => {
      return async (requirements: Record<string, unknown>) => {
        seen.push(requirements);
        return { abort: true as const, reason: "wash" };
      };
    });

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => ({ createTwzrdBeforePaymentHook }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "composed", via: "createTwzrdBeforePaymentHook" });
    const abort = await hooks[0]!({ selectedRequirements: { payTo: "wash" } });
    expect(abort).toEqual({ abort: true, reason: "wash" });
    expect(seen).toEqual([{ payTo: "wash" }]);
  });

  it("fails open only when twzrd-x402-gate itself is missing", async () => {
    const warn = vi.fn();
    const result = await maybeComposeTwzrdAutoGate(fakeClient().client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => {
        throw Object.assign(new Error("Cannot find package 'twzrd-x402-gate' imported from /app"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
      log: { log: vi.fn(), warn },
    });
    expect(result.status).toBe("unavailable");
    expect(warn).toHaveBeenCalled();
  });

  it("fails closed on a real module error", async () => {
    await expect(
      maybeComposeTwzrdAutoGate(fakeClient().client, {
        env: { TWZRD_AUTO_GATE: "1" },
        loadGate: async () => {
          throw new Error("unexpected gate init failure");
        },
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow("unexpected gate init failure");
  });
});
