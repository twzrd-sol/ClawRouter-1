// Outside payer, dry path only: @twzrd1111/clawrouter + @twzrd1111/clawrouter-mpp pointed at an MPP
// inference seller. The per-request cap (0.0001 USD) is below the seller's listed price (0.00075 USD),
// so the spend check refuses with 403 spend_policy_denied before anything is signed.
//
// The payer is a throwaway key generated fresh on every run. It holds no funds and is never persisted.
//
//   npm install && npm start
//   DEMO_SELLER=https://... DEMO_MODEL=... npm start   (optional overrides)
import { startProxy, SpendControl, InMemorySpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const SELLER = process.env.DEMO_SELLER ?? "https://openrouter.mpp.tempo.xyz";
const MODEL = process.env.DEMO_MODEL ?? "openai/gpt-4o-mini";
const CAP_USD = 0.0001; // listed price is 0.00075 USD; the cap is below it on purpose

const account = privateKeyToAccount(generatePrivateKey());
const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
spend.setLimit("perRequest", CAP_USD);
const payFetch = createMppFetch(account, fetch, { spend });

const proxy = await startProxy({
  spendControl: spend,
  payFetch,
  apiBase: SELLER,
  wallet: generatePrivateKey(),
  skipBalanceCheck: true,
  port: 0,
  allowExistingProxy: false,
});

let ok = false;
try {
  const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const text = await r.text();
  let errorType = null;
  try {
    errorType = JSON.parse(text)?.error?.type ?? null;
  } catch {
    // non-JSON body; errorType stays null
  }
  const receipt = r.headers.get("payment-receipt") ? "present" : "absent";

  console.log("seller:", SELLER, "| model:", MODEL);
  console.log("payer (throwaway):", account.address, "| cap USD:", CAP_USD);
  console.log("status:", r.status);
  console.log("error type:", errorType ?? "(none)");
  console.log("receipt header:", receipt);

  ok = r.status === 403 && errorType === "spend_policy_denied";
  console.log(ok ? "result: refused before signing (expected)" : "result: UNEXPECTED, expected 403 spend_policy_denied");
  if (!ok) console.log("body:", text.slice(0, 400));
} finally {
  await proxy.close();
}
process.exit(ok ? 0 : 1);
