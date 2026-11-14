/**
 * Durable replay stores: a seller's spent-proof claims and a buyer's receipt-reference index,
 * kept in Postgres or in Redis/Valkey so they survive a restart and are shared by every process.
 *
 * No database driver ships here. The caller injects one function that runs a query (Postgres) or
 * one EVAL (Redis/Valkey), so any client library works and nothing is loaded on import.
 * Every write is a single atomic statement or script: exactly one concurrent claimant wins.
 */
import type { ReceiptReferenceIndex } from "./receipt-chain-verify.js";
import { assertProofIds, type SpentProofStore } from "./spent-proof.js";

/** Runs one parameterized statement, as `pg`'s `pool.query(text, params)` does. */
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * Runs one Lua script with EVAL and resolves its reply (integer, bulk string, or null for nil).
 *   ioredis:   (script, keys, args) => client.eval(script, keys.length, ...keys, ...args)
 *   node-redis: (script, keys, args) => client.eval(script, { keys, arguments: args })
 */
export type RedisEval = (script: string, keys: string[], args: string[]) => Promise<unknown>;

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function tableName(table: string | undefined, fallback: string): string {
  const name = table ?? fallback;
  if (!SQL_IDENTIFIER.test(name))
    throw new TypeError(`table must match ${SQL_IDENTIFIER} (lowercase, unquoted); got ${name}`);
  return name;
}

function keyPrefix(prefix: string | undefined, fallback: string): string {
  const value = prefix ?? fallback;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("keyPrefix must be a non-empty string");
  return value;
}

/** A Redis integer reply of exactly 1. Anything else (0, nil, a string, an error value) is a loss. */
function isOne(reply: unknown): boolean {
  return reply === 1 || reply === 1n;
}

// ---------------------------------------------------------------------------------------------
// Seller: spent proofs
// ---------------------------------------------------------------------------------------------

export const DEFAULT_SPENT_PROOF_TABLE = "clawrouter_mpp_spent_proofs";
export const DEFAULT_SPENT_PROOF_PREFIX = "clawrouter-mpp:spent:";

/**
 * Spent proofs in Postgres. One row per proof; the primary key on (network, transaction) and the
 * unique key on (network, challenge) make a second use of either fail the insert, so the claim is
 * atomic across every process that shares the table. Run `ensureSchema()` once, or apply
 * `PostgresSpentProofStore.schema(table)` with your migrations.
 */
export class PostgresSpentProofStore implements SpentProofStore {
  readonly #query: SqlQuery;
  readonly table: string;

  constructor(options: { query: SqlQuery; table?: string }) {
    if (typeof options?.query !== "function") throw new TypeError("a query function is required");
    this.#query = options.query;
    this.table = tableName(options.table, DEFAULT_SPENT_PROOF_TABLE);
  }

  static schema(table: string = DEFAULT_SPENT_PROOF_TABLE): string {
    const t = tableName(table, DEFAULT_SPENT_PROOF_TABLE);
    return `CREATE TABLE IF NOT EXISTS ${t} (
  network_id text NOT NULL,
  tx_signature text NOT NULL,
  challenge_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, tx_signature),
  UNIQUE (network_id, challenge_id)
)`;
  }

  async ensureSchema(): Promise<void> {
    await this.#query(PostgresSpentProofStore.schema(this.table), []);
  }

  async claim(networkId: string, txSignature: string, challengeId: string): Promise<boolean> {
    assertProofIds(networkId, txSignature, challengeId);
    // No conflict target: a clash on either key does nothing, and a concurrent insert of the same
    // key waits for the other transaction and then does nothing, so only one claimant gets a row.
    const result = await this.#query(
      `INSERT INTO ${this.table} (network_id, tx_signature, challenge_id) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING RETURNING 1 AS won`,
      [networkId, txSignature, challengeId],
    );
    return result.rows.length === 1;
  }
}

/** Both keys free, then both set, in one script: Redis runs a script without interleaving. */
export const REDIS_CLAIM_SCRIPT = `if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

/**
 * Spent proofs in Redis or Valkey: one key per (network, transaction) and one per
 * (network, challenge), checked and set by one script. Keys never expire.
 *
 * Survives a server restart only with persistence on: `appendonly yes`. With the default
 * `appendfsync everysec`, a crash can lose up to the last second of claims; use
 * `appendfsync always` where that matters. In Redis Cluster both keys must share a slot:
 * put a hash tag in `keyPrefix`, for example "{clawrouter-mpp}:spent:".
 */
export class RedisSpentProofStore implements SpentProofStore {
  readonly #eval: RedisEval;
  readonly keyPrefix: string;

  constructor(options: { eval: RedisEval; keyPrefix?: string }) {
    if (typeof options?.eval !== "function") throw new TypeError("an eval function is required");
    this.#eval = options.eval;
    this.keyPrefix = keyPrefix(options.keyPrefix, DEFAULT_SPENT_PROOF_PREFIX);
  }

  async claim(networkId: string, txSignature: string, challengeId: string): Promise<boolean> {
    assertProofIds(networkId, txSignature, challengeId);
    const keys = [
      `${this.keyPrefix}tx:${JSON.stringify([networkId, txSignature])}`,
      `${this.keyPrefix}challenge:${JSON.stringify([networkId, challengeId])}`,
    ];
    return isOne(await this.#eval(REDIS_CLAIM_SCRIPT, keys, [challengeId, txSignature]));
  }
}

// ---------------------------------------------------------------------------------------------
// Buyer: receipt reference -> purchase id
// ---------------------------------------------------------------------------------------------

export const DEFAULT_REFERENCE_TABLE = "clawrouter_mpp_receipt_references";
export const DEFAULT_REFERENCE_PREFIX = "clawrouter-mpp:reference:";

function assertReference(reference: string): void {
  if (typeof reference !== "string" || reference.length === 0)
    throw new TypeError("reference is required");
}

function assertBinding(reference: string, purchaseId: string): void {
  assertReference(reference);
  if (typeof purchaseId !== "string" || purchaseId.length === 0)
    throw new TypeError("purchase id is required");
}

/** `ReceiptReferenceIndex` in Postgres: the primary key on `reference` makes `bind` atomic. */
export class PostgresReceiptReferenceIndex implements ReceiptReferenceIndex {
  readonly #query: SqlQuery;
  readonly table: string;

  constructor(options: { query: SqlQuery; table?: string }) {
    if (typeof options?.query !== "function") throw new TypeError("a query function is required");
    this.#query = options.query;
    this.table = tableName(options.table, DEFAULT_REFERENCE_TABLE);
  }

  static schema(table: string = DEFAULT_REFERENCE_TABLE): string {
    const t = tableName(table, DEFAULT_REFERENCE_TABLE);
    return `CREATE TABLE IF NOT EXISTS ${t} (
  reference text PRIMARY KEY,
  purchase_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now()
)`;
  }

  async ensureSchema(): Promise<void> {
    await this.#query(PostgresReceiptReferenceIndex.schema(this.table), []);
  }

  async bind(reference: string, purchaseId: string): Promise<boolean> {
    assertBinding(reference, purchaseId);
    const inserted = await this.#query(
      `INSERT INTO ${this.table} (reference, purchase_id) VALUES ($1, $2)
ON CONFLICT (reference) DO NOTHING RETURNING purchase_id`,
      [reference, purchaseId],
    );
    if (inserted.rows.length === 1) return true;
    // A separate statement sees a row another transaction committed after this insert began.
    return (await this.owner(reference)) === purchaseId;
  }

  async owner(reference: string): Promise<string | undefined> {
    assertReference(reference);
    const result = await this.#query(`SELECT purchase_id FROM ${this.table} WHERE reference = $1`, [
      reference,
    ]);
    const row = result.rows[0] as { purchase_id?: unknown } | undefined;
    return typeof row?.purchase_id === "string" ? row.purchase_id : undefined;
  }
}

export const REDIS_BIND_SCRIPT = `local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
if current == ARGV[1] then
  return 1
end
return 0`;

export const REDIS_OWNER_SCRIPT = `return redis.call('GET', KEYS[1])`;

/** `ReceiptReferenceIndex` in Redis or Valkey. Persistence notes as for `RedisSpentProofStore`. */
export class RedisReceiptReferenceIndex implements ReceiptReferenceIndex {
  readonly #eval: RedisEval;
  readonly keyPrefix: string;

  constructor(options: { eval: RedisEval; keyPrefix?: string }) {
    if (typeof options?.eval !== "function") throw new TypeError("an eval function is required");
    this.#eval = options.eval;
    this.keyPrefix = keyPrefix(options.keyPrefix, DEFAULT_REFERENCE_PREFIX);
  }

  async bind(reference: string, purchaseId: string): Promise<boolean> {
    assertBinding(reference, purchaseId);
    return isOne(await this.#eval(REDIS_BIND_SCRIPT, [this.#key(reference)], [purchaseId]));
  }

  async owner(reference: string): Promise<string | undefined> {
    assertReference(reference);
    const reply = await this.#eval(REDIS_OWNER_SCRIPT, [this.#key(reference)], []);
    return typeof reply === "string" ? reply : undefined;
  }

  // Tagged and JSON-encoded like the spent-proof keys, so a reference such as `tx:[...]` cannot
  // alias a spent-proof key even when both stores share one prefix.
  #key(reference: string): string {
    return `${this.keyPrefix}ref:${JSON.stringify(reference)}`;
  }
}
