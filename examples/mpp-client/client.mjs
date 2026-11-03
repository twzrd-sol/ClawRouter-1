// Local payer against a fixture seller. The proxy is aimed at the Tempo MPP seller
// and openai/gpt-4o-mini, but createMppFetch is given an in-memory fetch: a 200
// chat completion whose content is "ok", plus a Payment-Receipt header.
// No key is read. The account is generated in memory and discarded. Sockets are
// refused unless they stay on the local proxy port.
//
//   npm install && npm start
import net from "node:net";
import { startProxy, SpendControl, InMemorySpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function endpointHost(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    if (typeof first.path === "string") return "localhost";
    return first.host ?? first.hostname ?? "localhost";
  }
  if (typeof first === "string" && first.startsWith("/")) return "localhost";
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const host = args[1];
    if (host === undefined || typeof host === "function") return "localhost";
    return String(host);
  }
  return "unknown";
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const host = String(endpointHost(args));
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing non-local connection to ${host}`);
  }
  return origConnect.apply(this, args);
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url, "http://127.0.0.1").hostname;
  } catch {
    host = "";
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return realFetch(input, init);
  }
  return Promise.resolve(new Response("{}", { status: 404, headers: { "content-type": "application/json" } }));
};

const SELLER = "https://openrouter.mpp.tempo.xyz";
const MODEL = "openai/gpt-4o-mini";

const COMPLETION = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 0,
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function memoryFetch() {
  return Promise.resolve(
    new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Payment-Receipt": "fixture.receipt.not-a-credential",
      },
    }),
  );
}

const account = privateKeyToAccount(generatePrivateKey());
const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
const payFetch = createMppFetch(account, memoryFetch, { spend });

const proxy = await startProxy({
  spendControl: spend,
  payFetch,
  apiBase: SELLER,
  paymentChain: "base",
  wallet: generatePrivateKey(),
  skipBalanceCheck: true,
  port: 0,
  allowExistingProxy: false,
});

let exitCode = 1;
try {
  const r = await realFetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const text = await r.text();
  let content = "";
  try {
    content = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
  } catch {
    content = "";
  }
  if (r.status === 200 && content) {
    console.log(content);
    exitCode = 0;
  } else {
    console.error(text.slice(0, 500));
  }
} finally {
  await proxy.close();
}
process.exit(exitCode);
