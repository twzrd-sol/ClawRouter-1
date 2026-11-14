/**
 * Durable replay stores. Postgres runs in process (PGlite, a real Postgres build) on a temporary
 * directory, so "restart" closes the database and opens the same directory again. Redis/Valkey runs
 * against a real server only when CLAWROUTER_MPP_TEST_REDIS_URL is set; without it, the adapters'
 * wiring is checked against a scripted fake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryReceiptReferenceIndex,
  type ReceiptReferenceIndex,
} from "./receipt-chain-verify.js";
import {
  PostgresReceiptReferenceIndex,
  PostgresSpentProofStore,
  REDIS_BIND_SCRIPT,
  REDIS_CLAIM_SCRIPT,
  REDIS_OWNER_SCRIPT,
  RedisReceiptReferenceIndex,
  RedisSpentProofStore,
  type RedisEval,
  type SqlQuery,
} from "./replay-store.js";
import {
  fulfillPaidProof,
  ReplayRejectedError,
  SpentProofLedger,
  type SpentProofStore,
} from "./spent-proof.js";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const OTHER_NET = "eip155:4217";

/** One backend that can be reopened: `open()` returns a fresh store on the same data. */
type Backend<S> = {
  open(): Promise<S>;
  /** Simulate a process restart: drop every client and handle, keep the data. */
  restart(): Promise<void>;
  close(): Promise<void>;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

function pgBackend<S>(make: (query: SqlQuery) => S & { ensureSchema(): Promise<void> }) {
  return async (): Promise<Backend<S>> => {
    const dir = mkdtempSync(join(tmpdir(), "clawrouter-mpp-pg-"));
    let db = new PGlite(dir);
    const query: SqlQuery = (text, params) => db.query(text, params);
    const first = make(query);
    await first.ensureSchema();
    const backend: Backend<S> = {
      open: async () => make(query),
      restart: async () => {
        await db.close();
        db = new PGlite(dir);
      },
      close: async () => {
        await db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
    cleanups.push(() => backend.close());
    return backend;
  };
}

const REDIS_URL = process.env.CLAWROUTER_MPP_TEST_REDIS_URL;

function redisEvalFor(client: Redis): RedisEval {
  return (script, keys, args) => client.eval(script, keys.length, ...keys, ...args);
}

function redisBackend<S>(make: (evalFn: RedisEval, prefix: string) => S) {
  return async (): Promise<Backend<S>> => {
    const prefix = `clawrouter-mpp-test:${process.pid}:${Math.random().toString(36).slice(2)}:`;
    let client = new Redis(REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
    const evalFn: RedisEval = (s, k, a) => redisEvalFor(client)(s, k, a);
    const backend: Backend<S> = {
      open: async () => make(evalFn, prefix),
      restart: async () => {
        client.disconnect();
        client = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 });
      },
      close: async () => {
        const keys = await client.keys(`${prefix}*`);
        if (keys.length) await client.del(...keys);
        client.disconnect();
      },
    };
    cleanups.push(() => backend.close());
    return backend;
  };
}

/** A scripted stand-in for EVAL that runs each of the three scripts' semantics on a Map. */
function fakeRedis(): { eval: RedisEval; data: Map<string, string>; calls: string[][] } {
  const data = new Map<string, string>();
  const calls: string[][] = [];
  const evalFn: RedisEval = async (script, keys, args) => {
    calls.push([...keys, ...args]);
    if (script === REDIS_CLAIM_SCRIPT) {
      if (data.has(keys[0]) || data.has(keys[1])) return 0;
      data.set(keys[0], args[0]);
      data.set(keys[1], args[1]);
      return 1;
    }
    if (script === REDIS_BIND_SCRIPT) {
      const current = data.get(keys[0]);
      if (current === undefined) {
        data.set(keys[0], args[0]);
        return 1;
      }
      return current === args[0] ? 1 : 0;
    }
    if (script === REDIS_OWNER_SCRIPT) return data.get(keys[0]) ?? null;
    throw new Error("unknown script");
  };
  return { eval: evalFn, data, calls };
}

function fakeRedisBackend<S>(make: (evalFn: RedisEval) => S) {
  return async (): Promise<Backend<S>> => {
    const fake = fakeRedis();
    return { open: async () => make(fake.eval), restart: async () => {}, close: async () => {} };
  };
}

// ---------------------------------------------------------------------------------------------
// Spent-proof store contract
// ---------------------------------------------------------------------------------------------

const spentStores: [string, () => Promise<Backend<SpentProofStore>>, boolean][] = [
  ["Postgres (PGlite)", pgBackend((query) => new PostgresSpentProofStore({ query })), true],
  ["Redis (scripted fake)", fakeRedisBackend((e) => new RedisSpentProofStore({ eval: e })), false],
];
if (REDIS_URL) {
  spentStores.push([
    "Redis/Valkey (live server)",
    redisBackend((e, prefix) => new RedisSpentProofStore({ eval: e, keyPrefix: prefix })),
    true,
  ]);
}

describe.each(spentStores)("spent-proof store: %s", (_name, backendOf, durable) => {
  it("first claim wins; the same proof again loses", async () => {
    const store = await (await backendOf()).open();
    expect(await store.claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(await store.claim(NET, "tx-1", "ch-1")).toBe(false);
  });

  it("a reused transaction or a reused challenge loses on its own", async () => {
    const store = await (await backendOf()).open();
    expect(await store.claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(await store.claim(NET, "tx-1", "ch-2")).toBe(false);
    expect(await store.claim(NET, "tx-2", "ch-1")).toBe(false);
  });

  it("a losing claim holds nothing: its other half stays free", async () => {
    const store = await (await backendOf()).open();
    expect(await store.claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(await store.claim(NET, "tx-2", "ch-1")).toBe(false);
    expect(await store.claim(NET, "tx-2", "ch-2")).toBe(true);
  });

  it("is scoped by network", async () => {
    const store = await (await backendOf()).open();
    expect(await store.claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(await store.claim(OTHER_NET, "tx-1", "ch-1")).toBe(true);
  });

  it("gives one winner among concurrent claims of overlapping proofs", async () => {
    const backend = await backendOf();
    const stores = await Promise.all(Array.from({ length: 4 }, () => backend.open()));
    const attempts = Array.from({ length: 24 }, (_, i) =>
      stores[i % stores.length].claim(
        NET,
        i % 2 ? "tx-race" : `tx-${i}`,
        i % 2 ? `ch-${i}` : "ch-race",
      ),
    );
    const results = await Promise.all(attempts);
    // Every attempt reuses tx-race or ch-race, and (tx-race, ch-race) never appears together, so
    // at most one tx-race claim and one ch-race claim can win.
    const txRaceWins = results.filter((won, i) => won && i % 2 === 1).length;
    const chRaceWins = results.filter((won, i) => won && i % 2 === 0).length;
    expect(txRaceWins).toBe(1);
    expect(chRaceWins).toBe(1);
  });

  it("rejects missing ids", async () => {
    const store = await (await backendOf()).open();
    await expect(async () => store.claim(NET, "", "ch-1")).rejects.toThrow(TypeError);
    await expect(async () => store.claim("", "tx-1", "ch-1")).rejects.toThrow(TypeError);
  });

  it.runIf(durable)("survives a restart", async () => {
    const backend = await backendOf();
    expect(await (await backend.open()).claim(NET, "tx-1", "ch-1")).toBe(true);
    await backend.restart();
    const reopened = await backend.open();
    expect(await reopened.claim(NET, "tx-1", "ch-1")).toBe(false);
    expect(await reopened.claim(NET, "tx-1", "ch-2")).toBe(false);
    expect(await reopened.claim(NET, "tx-2", "ch-1")).toBe(false);
    expect(await reopened.claim(NET, "tx-2", "ch-2")).toBe(true);
  });

  it.runIf(durable)("fulfillPaidProof calls upstream once across a restart", async () => {
    const backend = await backendOf();
    const upstream = vi.fn(async () => "completion");
    const proof = { networkId: NET, txSignature: "tx-1", challengeId: "ch-1", upstream };
    await expect(fulfillPaidProof({ ledger: await backend.open(), ...proof })).resolves.toBe(
      "completion",
    );
    await backend.restart();
    const replay = await fulfillPaidProof({ ledger: await backend.open(), ...proof }).catch(
      (e: unknown) => e,
    );
    expect(replay).toBeInstanceOf(ReplayRejectedError);
    expect((replay as ReplayRejectedError).status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("in-memory SpentProofLedger forgets on restart (why 4.3 needs a durable store)", () => {
  it("a new ledger accepts a proof the old one spent", () => {
    expect(new SpentProofLedger().claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(new SpentProofLedger().claim(NET, "tx-1", "ch-1")).toBe(true);
  });
});

describe("fulfillPaidProof with a store that fails", () => {
  it("rejects before upstream when the store throws", async () => {
    const upstream = vi.fn(async () => "completion");
    const ledger: SpentProofStore = { claim: async () => Promise.reject(new Error("db down")) };
    await expect(
      fulfillPaidProof({ ledger, networkId: NET, txSignature: "t", challengeId: "c", upstream }),
    ).rejects.toThrow("db down");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("treats any answer other than true as a lost claim", async () => {
    const upstream = vi.fn(async () => "completion");
    for (const answer of [1, "true", {}, undefined]) {
      const ledger = { claim: async () => answer } as unknown as SpentProofStore;
      await expect(
        fulfillPaidProof({ ledger, networkId: NET, txSignature: "t", challengeId: "c", upstream }),
      ).rejects.toBeInstanceOf(ReplayRejectedError);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("adapter details", () => {
  it("Postgres refuses a table name that is not a plain identifier", () => {
    const query: SqlQuery = async () => ({ rows: [] });
    for (const table of ["proofs; DROP TABLE x", "Proofs", "a-b", '"q"', ""]) {
      expect(() => new PostgresSpentProofStore({ query, table })).toThrow(TypeError);
      expect(() => new PostgresReceiptReferenceIndex({ query, table })).toThrow(TypeError);
    }
  });

  it("Postgres passes ids only as parameters", async () => {
    const seen: { text: string; params: unknown[] }[] = [];
    const query: SqlQuery = async (text, params) => {
      seen.push({ text, params });
      return { rows: [{ won: 1 }] };
    };
    const evil = "x'); DROP TABLE clawrouter_mpp_spent_proofs; --";
    await new PostgresSpentProofStore({ query }).claim(NET, evil, evil);
    expect(seen[0].text).not.toContain(evil);
    expect(seen[0].params).toEqual([NET, evil, evil]);
  });

  it("Postgres counts only a returned row as a win", async () => {
    const lost = new PostgresSpentProofStore({ query: async () => ({ rows: [] }) });
    expect(await lost.claim(NET, "t", "c")).toBe(false);
    const index = new PostgresReceiptReferenceIndex({ query: async () => ({ rows: [] }) });
    expect(await index.bind("ref-1", "p-1")).toBe(false);
    expect(await index.owner("ref-1")).toBeUndefined();
  });

  it("Redis counts only an integer 1 reply as a win", async () => {
    for (const reply of ["1", true, "OK", 2, null]) {
      const store = new RedisSpentProofStore({ eval: async () => reply });
      expect(await store.claim(NET, "t", "c")).toBe(false);
    }
    expect(await new RedisSpentProofStore({ eval: async () => 1 }).claim(NET, "t", "c")).toBe(true);
  });

  it("Redis keys carry the prefix and a network-scoped, unambiguous id", async () => {
    const fake = fakeRedis();
    await new RedisSpentProofStore({ eval: fake.eval, keyPrefix: "{p}:" }).claim(NET, "a:b", "c");
    expect(fake.calls[0].slice(0, 2)).toEqual([
      `{p}:tx:${JSON.stringify([NET, "a:b"])}`,
      `{p}:challenge:${JSON.stringify([NET, "c"])}`,
    ]);
  });

  it("Redis reference keys cannot alias spent-proof keys under a shared prefix", async () => {
    const fake = fakeRedis();
    const spent = new RedisSpentProofStore({ eval: fake.eval, keyPrefix: "{p}:" });
    const index = new RedisReceiptReferenceIndex({ eval: fake.eval, keyPrefix: "{p}:" });
    // A reference spelled like a spent-proof key, bound before that proof is claimed.
    const spentKey = `tx:${JSON.stringify([NET, "tx-1"])}`;
    expect(await index.bind(spentKey, "p-1")).toBe(true);
    expect(fake.calls[0][0]).toBe(`{p}:ref:${JSON.stringify(spentKey)}`);
    expect(await spent.claim(NET, "tx-1", "ch-1")).toBe(true);
    expect(fake.data.get(`{p}:${spentKey}`)).toBe("ch-1");
    expect(await index.owner(spentKey)).toBe("p-1");
  });

  it("Redis owner is undefined for nil or any non-string reply", async () => {
    for (const reply of [null, 1, 0, true, {}]) {
      const index = new RedisReceiptReferenceIndex({ eval: async () => reply });
      expect(await index.owner("ref-1")).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Receipt reference index contract
// ---------------------------------------------------------------------------------------------

const indexes: [string, () => Promise<Backend<ReceiptReferenceIndex>>, boolean][] = [
  [
    "in-memory",
    async () => {
      const index = new InMemoryReceiptReferenceIndex();
      return { open: async () => index, restart: async () => {}, close: async () => {} };
    },
    false,
  ],
  ["Postgres (PGlite)", pgBackend((query) => new PostgresReceiptReferenceIndex({ query })), true],
  [
    "Redis (scripted fake)",
    fakeRedisBackend((e) => new RedisReceiptReferenceIndex({ eval: e })),
    false,
  ],
];
if (REDIS_URL) {
  indexes.push([
    "Redis/Valkey (live server)",
    redisBackend((e, prefix) => new RedisReceiptReferenceIndex({ eval: e, keyPrefix: prefix })),
    true,
  ]);
}

describe.each(indexes)("receipt reference index: %s", (_name, backendOf, durable) => {
  it("binds once; the same purchase re-binds; another purchase cannot", async () => {
    const index = await (await backendOf()).open();
    expect(await index.owner("ref-1")).toBeUndefined();
    expect(await index.bind("ref-1", "p-1")).toBe(true);
    expect(await index.bind("ref-1", "p-1")).toBe(true);
    expect(await index.bind("ref-1", "p-2")).toBe(false);
    expect(await index.owner("ref-1")).toBe("p-1");
  });

  it("gives one purchase the reference among concurrent binders", async () => {
    const backend = await backendOf();
    const handles = await Promise.all(Array.from({ length: 4 }, () => backend.open()));
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => handles[i % handles.length].bind("ref-race", `p-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = `p-${results.indexOf(true)}`;
    expect(await handles[0].owner("ref-race")).toBe(winner);
  });

  it.runIf(durable)("survives a restart", async () => {
    const backend = await backendOf();
    expect(await (await backend.open()).bind("ref-1", "p-1")).toBe(true);
    await backend.restart();
    const reopened = await backend.open();
    expect(await reopened.owner("ref-1")).toBe("p-1");
    expect(await reopened.bind("ref-1", "p-2")).toBe(false);
    expect(await reopened.bind("ref-1", "p-1")).toBe(true);
  });
});

afterAll(() => vi.restoreAllMocks());
