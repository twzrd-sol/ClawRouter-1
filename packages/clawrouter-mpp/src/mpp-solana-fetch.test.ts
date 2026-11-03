import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";
import {
  createSolanaFixtureFetch,
  createSolanaMppFetch,
  parseSolanaChargeHeader,
  payKitClientDeps,
  quoteFromSolanaChallenge,
  SOLANA_DEVNET_USDC_MINT,
  type SolanaChargeChallenge,
} from "./mpp-solana-fetch.js";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@twzrd1111/clawrouter";
import { MppPaidNoCompletionError, readCredits } from "./mpp-paid-failure.js";

// A real pay-kit server emits real Solana MPP 402s without touching a chain. The payer's RPC points at a
// closed port, so a veto that fails to hold would surface as a connection error, not SpendPolicyError.
const DEAD_RPC = "http://127.0.0.1:1";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function seller(stablecoin: "USDC" | "PYUSD" = "USDC") {
  const operator = await generateKeyPairSigner();
  const pay = await createPayKit({
    network: "localnet",
    accept: ["mpp"],
    stablecoins: [stablecoin],
    operator: { signer: operator, recipient: operator.address },
    rpcUrl: DEAD_RPC,
    preflight: false,
    pricing: { chat: usd("0.00075") },
  });
  const handler = pay.fetch("chat", () => new Response("paid"));
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handler(
      new Request(`http://127.0.0.1${req.url}`, { method: "POST", headers, body: "{}" }),
    );
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, operator };
}

const control = (configure: (c: SpendControl) => void) => {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  configure(c);
  return c;
};
const payer = () => generateKeyPairSigner();
/** Counts `signMessages` / `signTransactions`. A policy veto must leave this at 0. */
async function watchedPayer() {
  const base = await payer();
  let calls = 0;
  const count =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      calls += 1;
      return fn(...args);
    };
  return {
    signer: {
      address: base.address,
      keyPair: base.keyPair,
      signMessages: count(base.signMessages),
      signTransactions: count(base.signTransactions),
    },
    calls: () => calls,
  };
}
const call = (f: (u: string, i?: RequestInit) => Promise<Response>, url: string) =>
  f(url, { method: "POST", body: "{}" });

describe("Solana MPP spend controls", () => {
  it("refuses over the per-request limit before anything is signed", async () => {
    const s = await seller();
    const spend = control((c) => c.setLimit("perRequest", 0.0005));
    const watched = await watchedPayer();
    const f = await createSolanaMppFetch({
      signer: watched.signer,
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toBeInstanceOf(SpendPolicyError);
    expect(spend.getStatus().spending.daily).toBe(0);
    expect(watched.calls()).toBe(0);
  });

  it("refuses a mint it cannot price while amount limits are set", async () => {
    const s = await seller("PYUSD");
    const spend = control((c) => c.setLimit("perRequest", 1));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/cannot price/);
  });

  it("enforces payee lists from the challenge recipient, before signing", async () => {
    const s = await seller();
    const spend = control((c) => c.setPolicy("blockedPayees", [s.operator.address]));
    const watched = await watchedPayer();
    const f = await createSolanaMppFetch({
      signer: watched.signer,
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/Payee is blocked by policy/);
    expect(watched.calls()).toBe(0);
  });

  it("lets an allowlisted payee reach signing (regression: authorize() ran the payee check with no payTo)", async () => {
    const s = await seller();
    const spend = control((c) => c.setPolicy("allowedPayees", [s.operator.address]));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    // Past every policy check, then dies at the dead RPC while building the transaction.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
  });

  it("refuses a payee that is not on the allowlist, before signing", async () => {
    const s = await seller();
    const other = (await payer()).address;
    const spend = control((c) => c.setPolicy("allowedPayees", [other]));
    const watched = await watchedPayer();
    const f = await createSolanaMppFetch({
      signer: watched.signer,
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/not in the configured allowlist/);
    expect(watched.calls()).toBe(0);
  });

  it("releases the held budget when the payment fails before a signed credential", async () => {
    const s = await seller();
    const spend = control((c) => c.setLimit("daily", 0.001));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    // Passes the policy, then dies at the dead RPC while building the transaction: not a policy error.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
    expect(spend.getStatus().spending.daily).toBe(0);
    // ...and the failed attempt did not eat the window: a second one still gets past the policy.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
  });

  it("marks the fetch as enforcing only when a spend control is supplied", async () => {
    const plain = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
    });
    const guarded = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend: control(() => {}),
    });
    expect(plain.enforcesSpend).toBe(false);
    expect(guarded.enforcesSpend).toBe(true);
  });
});

const DEVNET_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const FIXTURE_PAYEE = "DevnetFixturePayee11111111111111111111111111";
const FIXTURE_RECEIPT = "solana-receipt-fixture";
const COMPLETION_BODY = { id: "chatcmpl-fixture", choices: [{ message: { content: "hi" } }] };
const FIXTURE_URL = "https://devnet.fixture.invalid/v1/chat/completions";
const FIXTURE_REQUEST = {
  amount: "750",
  currency: SOLANA_DEVNET_USDC_MINT,
  recipient: FIXTURE_PAYEE,
  methodDetails: { network: DEVNET_NETWORK, decimals: 6 },
};
const FIXTURE_HEADER = `Payment id="fixture-challenge-id", realm="devnet.fixture", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(FIXTURE_REQUEST)).toString("base64url")}"`;

function devnetControl() {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  c.setLimit("perRequest", 0.001);
  c.setLimit("daily", 1);
  c.setPolicy("allowedPayees", [FIXTURE_PAYEE]);
  c.setPolicy("allowedNetworks", [DEVNET_NETWORK]);
  return c;
}

/** Stub the seller. No socket and no signer: 402 from the inline fixture, then the scripted paid response. */
function stubDevnet(paid: Response) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    calls.push({ url: String(input), authorization });
    if (!authorization) {
      return new Response(JSON.stringify({ title: "Payment Required" }), {
        status: 402,
        headers: { "www-authenticate": FIXTURE_HEADER },
      });
    }
    return paid.clone();
  }) as unknown as typeof fetch;
  return { base, calls };
}

describe("createSolanaMppFetch with no spend control", () => {
  it("a signed 502 records one credit from the challenge and a retry stays one row", async () => {
    const before = readCredits().length;
    const realLoad = payKitClientDeps.load;
    payKitClientDeps.load = async () =>
      ({
        PayKitClient: {
          builder() {
            let progress: (event: unknown) => void = () => {};
            const chain = {
              signer: () => chain,
              rpcUrl: () => chain,
              network: () => chain,
              accept: () => chain,
              permissions: () => chain,
              onProgress(cb: (event: unknown) => void) {
                progress = cb;
                return chain;
              },
              async build() {
                return {
                  async fetch() {
                    progress({ type: "challenge", recipient: FIXTURE_PAYEE });
                    progress({ type: "signed", transaction: "tx-sol" });
                    return new Response("down", { status: 502 });
                  },
                };
              },
            };
            return chain;
          },
        },
      }) as unknown as Awaited<ReturnType<typeof realLoad>>;
    try {
      const pay = await createSolanaMppFetch({
        signer: await generateKeyPairSigner(),
        rpcUrl: DEAD_RPC,
        network: "devnet",
      });
      const send = () => pay(FIXTURE_URL, { method: "POST", body: "{}" });
      const err = await send().catch((e: unknown) => e);
      await send().catch(() => {});
      expect(err).toBeInstanceOf(MppPaidNoCompletionError);
      expect(readCredits().slice(before)).toEqual([
        { payer: FIXTURE_PAYEE, amount: "", challengeId: "tx-sol", reason: "HTTP 502" },
      ]);
    } finally {
      payKitClientDeps.load = realLoad;
    }
  });
});

describe("Solana devnet fixture, no network", () => {
  const parsed = parseSolanaChargeHeader(FIXTURE_HEADER);

  it("parses the devnet charge: 750 units, USDC devnet mint, devnet CAIP-2, fixture payee", () => {
    expect(parsed.request).toEqual(FIXTURE_REQUEST);
    expect(parsed.realm).toBe("devnet.fixture");
    expect(quoteFromSolanaChallenge(parsed)).toMatchObject({
      payTo: FIXTURE_PAYEE,
      network: DEVNET_NETWORK,
      asset: SOLANA_DEVNET_USDC_MINT,
      amount: "750",
      priceable: true,
    });
  });

  it("reserves, signs once, attaches the credential, and returns the completion plus receipt", async () => {
    const control = devnetControl();
    const seenPending: number[] = [];
    const historyAtSign: number[] = [];
    const signed: string[] = [];
    const sign = async (c: SolanaChargeChallenge) => {
      seenPending.push(control.getSpending("daily"));
      historyAtSign.push((control as unknown as { history: unknown[] }).history.length);
      signed.push(c.id);
      return c.id;
    };
    const { base, calls } = stubDevnet(
      new Response(JSON.stringify(COMPLETION_BODY), {
        status: 200,
        headers: { "content-type": "application/json", "Payment-Receipt": FIXTURE_RECEIPT },
      }),
    );
    const body = JSON.stringify({ model: "fixture" });
    const pay = createSolanaFixtureFetch({ spend: control, sign, fetch: base });
    const once = () =>
      pay(FIXTURE_URL, { method: "POST", headers: { "content-type": "application/json" }, body });

    const res = await once();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COMPLETION_BODY);
    expect(res.headers.get("payment-receipt")).toBe(FIXTURE_RECEIPT);
    expect(seenPending[0]).toBeCloseTo(0.00075, 8);
    expect(historyAtSign).toEqual([0]);
    expect(signed).toEqual(["fixture-challenge-id"]);
    expect(calls[0].authorization).toBeNull();
    expect(calls[1].authorization).toBe("Payment fixture-challenge-id");
    expect(calls.every((c) => c.url === FIXTURE_URL)).toBe(true);
    expect(control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);

    const again = await once();
    expect(again.status).toBe(200);
    expect(again.headers.get("payment-receipt")).toBe(FIXTURE_RECEIPT);
    expect(signed).toEqual(["fixture-challenge-id"]);
    expect(calls).toHaveLength(4);
    expect(calls[3].authorization).toBe("Payment fixture-challenge-id");
    expect(control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });

  it("a signed call with no completion is MppPaidNoCompletionError and is not retried", async () => {
    const control = devnetControl();
    const signed: string[] = [];
    const sign = async (c: SolanaChargeChallenge) => {
      signed.push(c.id);
      return c.id;
    };
    const { base, calls } = stubDevnet(new Response("no completion", { status: 502 }));
    const pay = createSolanaFixtureFetch({ spend: control, sign, fetch: base });
    const before = readCredits().length;
    const send = () =>
      pay(FIXTURE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const err = await send().catch((e) => e);
    await send().catch(() => {});
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.message).toContain("Not retrying");
    expect(readCredits().slice(before)).toEqual([
      {
        payer: FIXTURE_PAYEE,
        amount: "750",
        challengeId: "fixture-challenge-id",
        reason: "HTTP 502",
      },
    ]);
    expect(signed).toEqual(["fixture-challenge-id"]);
  });
});
