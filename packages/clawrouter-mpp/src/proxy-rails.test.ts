import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSigner } from "@solana/kit";
import { startProxy, SpendControl, InMemorySpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch, createSolanaMppFetch } from "./index.js";

describe("factory-produced rails through the streaming proxy", () => {
  it.each(["tempo", "solana"])(
    "forwards the receipt with the %s factory's own capability",
    async (rail) => {
      const base = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            id: "fixture",
            choices: [
              { message: { role: "assistant", content: "factory works" }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json", "payment-receipt": "fixture-receipt" } },
        );
      }) as unknown as typeof fetch;
      const payFetch =
        rail === "tempo"
          ? createMppFetch(privateKeyToAccount(generatePrivateKey()), base)
          : await createSolanaMppFetch({
              signer: await generateKeyPairSigner(),
              rpcUrl: "http://127.0.0.1:1",
              network: "devnet",
              fetch: base,
            });
      const proxy = await startProxy({
        wallet: generatePrivateKey(),
        apiBase: "http://127.0.0.1:1",
        port: 0,
        skipBalanceCheck: true,
        allowExistingProxy: false,
        payFetch,
        spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      });
      try {
        const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            stream: true,
            max_tokens: 8,
            messages: [{ role: "user", content: rail }],
          }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("payment-receipt")).toBe("fixture-receipt");
        const body = await response.text();
        expect(body).toContain("factory works");
        expect(body).toContain("[DONE]");
        expect(base).toHaveBeenCalledTimes(1);
      } finally {
        await proxy.close();
      }
    },
  );
});
