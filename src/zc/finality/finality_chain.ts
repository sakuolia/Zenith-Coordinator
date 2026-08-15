/**
 * @file finality_chain.ts — Tamper-evident hash chain over FinalityLog entries.
 *
 * Each entry commits to its predecessor via SHA-256, scoped per txid (or gtid
 * when no txid is present). A silent rewrite of historical audit data therefore
 * invalidates every subsequent entry in the same chain.
 *
 * The chain identifier is `txid` if set, otherwise `gtid`. Entries with neither
 * are anchored to the sentinel 'GLOBAL' chain (system-level events).
 */
import { sha256hex } from "../../shared/hmac";

export const GENESIS_PREV_HASH = "GENESIS";
export const GLOBAL_CHAIN_ID = "GLOBAL";
export const CHAIN_ALGORITHM = "SHA-256 hash-chain v2";

/**
 * Prefixes for chain ids stored in `FinalityLog.gtid` (non-transaction chains):
 * GT-/GTID- = GTID, DNS- = DNS cycle, LSM- = a Bulk LSM optimiser run. A chain
 * id with none of these (and not GLOBAL) is a transaction id stored in
 * `FinalityLog.txid`. This is the single source of truth for that split —
 * `orchestrator/finality.ts` imports it rather than re-declaring its own list.
 */
export const NON_TX_CHAIN_PREFIXES = ["GT-", "GTID-", "DNS-", "LSM-"] as const;

/** True if `chainId` denotes a non-transaction chain (stored in the gtid column). */
export function isNonTxChainId(chainId: string): boolean {
  return NON_TX_CHAIN_PREFIXES.some((p) => chainId.startsWith(p));
}

/**
 * SQL scope for a single chain. A chain id is EITHER a txid (matched on the
 * `txid` column) or a non-tx id like a gtid/DNS cycle/LSM run (matched on the
 * `gtid` column) — never both. The previous `txid = ? OR gtid = ?` form mixed
 * the two id spaces in one predicate; scoping to the correct column by id kind
 * keeps a txid chain from ever picking up a row that happens to share its id in
 * the other column. Callers handle GLOBAL separately.
 */
function chainColumnScope(chainId: string): { clause: string; bind: string } {
  return isNonTxChainId(chainId)
    ? { clause: "gtid = ?", bind: chainId }
    : { clause: "txid = ?", bind: chainId };
}

export interface ChainableEntry {
  log_id: string;
  txid: string | null;
  gtid: string | null;
  event_type: string;
  state_from: string | null;
  state_to: string;
  payload_json: string;
  event_seq: number;
  occurred_at: string;
  prev_hash?: string | null;
  entry_hash?: string | null;
}

export function chainIdOf(entry: Pick<ChainableEntry, "txid" | "gtid">): string {
  return entry.txid ?? entry.gtid ?? GLOBAL_CHAIN_ID;
}

/**
 * Deterministic serialization for hashing. Field order is part of the protocol.
 *
 * Framing (v2): each field is length-prefixed (`<charLen>:<value>`) and the
 * frames are concatenated. The previous form joined raw values with a single
 * `|`, which is NOT injective — a `|` embedded in a variable field (notably
 * `payload_json`, the one attacker-influenceable field) could shift a field
 * boundary so two logically distinct entries serialized identically and shared
 * a hash. Length-prefixing removes that ambiguity: the parse reads an exact
 * character count per field, so no value can forge a boundary and the mapping
 * (tuple → string) is injective. We never re-parse this string (it is only
 * hashed), but injectivity is what makes the hash a faithful commitment to the
 * tuple. Bumping CHAIN_ALGORITHM to v2 records the framing change.
 */
function canonicalize(entry: ChainableEntry, prevHash: string): string {
  const fields = [
    prevHash,
    entry.log_id,
    entry.txid ?? "",
    entry.gtid ?? "",
    entry.event_type,
    entry.state_from ?? "",
    entry.state_to,
    entry.payload_json,
    String(entry.event_seq),
    entry.occurred_at,
  ];
  return fields.map((f) => `${f.length}:${f}`).join("");
}

export async function computeEntryHash(entry: ChainableEntry, prevHash: string): Promise<string> {
  return sha256hex(canonicalize(entry, prevHash));
}

/** Fetch the most recent entry_hash for a chain, or GENESIS if empty. */
export async function getChainTipHash(db: D1Database, chainId: string): Promise<string> {
  if (chainId === GLOBAL_CHAIN_ID) {
    const row = await db
      .prepare(
        `SELECT entry_hash FROM FinalityLog
         WHERE txid IS NULL AND gtid IS NULL
         ORDER BY event_seq DESC LIMIT 1`
      )
      .first<{ entry_hash: string | null }>();
    return row?.entry_hash ?? GENESIS_PREV_HASH;
  }
  const scope = chainColumnScope(chainId);
  const row = await db
    .prepare(
      `SELECT entry_hash FROM FinalityLog
       WHERE ${scope.clause}
       ORDER BY event_seq DESC LIMIT 1`
    )
    .bind(scope.bind)
    .first<{ entry_hash: string | null }>();
  return row?.entry_hash ?? GENESIS_PREV_HASH;
}

/**
 * Fetch the `entry_hash` of a chain's tip *as of* `maxSeq` (the most recent
 * entry with `event_seq <= maxSeq`), or GENESIS if no such entry exists.
 *
 * Used by §G anchoring/inclusion-proof verification: an anchor fixes a chain's
 * tip hash at a past `event_seq` high-water mark, and inclusion is checked by
 * recomputing the tip "as of" that watermark and comparing.
 */
export async function getChainTipHashAsOf(
  db: D1Database,
  chainId: string,
  maxSeq: number
): Promise<string> {
  if (chainId === GLOBAL_CHAIN_ID) {
    const row = await db
      .prepare(
        `SELECT entry_hash FROM FinalityLog
         WHERE txid IS NULL AND gtid IS NULL AND event_seq <= ?
         ORDER BY event_seq DESC LIMIT 1`
      )
      .bind(maxSeq)
      .first<{ entry_hash: string | null }>();
    return row?.entry_hash ?? GENESIS_PREV_HASH;
  }
  const scope = chainColumnScope(chainId);
  const row = await db
    .prepare(
      `SELECT entry_hash FROM FinalityLog
       WHERE ${scope.clause} AND event_seq <= ?
       ORDER BY event_seq DESC LIMIT 1`
    )
    .bind(scope.bind, maxSeq)
    .first<{ entry_hash: string | null }>();
  return row?.entry_hash ?? GENESIS_PREV_HASH;
}

export interface ChainVerification {
  chain_id: string;
  valid: boolean;
  entries_checked: number;
  break_at_seq: number | null;
  break_reason: string | null;
  algorithm: string;
}

/**
 * Recompute hashes for every entry in a chain and detect tampering.
 *
 * Returns `valid: true` when every stored entry_hash matches its canonical
 * recomputation AND each entry's prev_hash equals the previous tip. The first
 * inconsistency is reported in `break_at_seq`.
 */
export async function verifyChain(db: D1Database, chainId: string): Promise<ChainVerification> {
  const rows = await (chainId === GLOBAL_CHAIN_ID
    ? db
        .prepare(
          `SELECT log_id, txid, gtid, event_type, state_from, state_to, payload_json,
                  event_seq, occurred_at, prev_hash, entry_hash
           FROM FinalityLog WHERE txid IS NULL AND gtid IS NULL
           ORDER BY event_seq ASC`
        )
        .all<ChainableEntry>()
    : db
        .prepare(
          `SELECT log_id, txid, gtid, event_type, state_from, state_to, payload_json,
                  event_seq, occurred_at, prev_hash, entry_hash
           FROM FinalityLog WHERE ${chainColumnScope(chainId).clause}
           ORDER BY event_seq ASC`
        )
        .bind(chainColumnScope(chainId).bind)
        .all<ChainableEntry>());

  let expectedPrev = GENESIS_PREV_HASH;
  let checked = 0;
  for (const row of rows.results) {
    checked++;
    // Legacy entries written before the entry_hash chain was introduced have no entry_hash — skip
    // strict verification but treat the chain as "partially verified".
    if (row.entry_hash == null) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: "LEGACY_UNCHAINED_ENTRY",
        algorithm: CHAIN_ALGORITHM,
      };
    }
    if ((row.prev_hash ?? GENESIS_PREV_HASH) !== expectedPrev) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: "PREV_HASH_MISMATCH",
        algorithm: CHAIN_ALGORITHM,
      };
    }
    const recomputed = await computeEntryHash(row, expectedPrev);
    if (recomputed !== row.entry_hash) {
      return {
        chain_id: chainId,
        valid: false,
        entries_checked: checked,
        break_at_seq: row.event_seq,
        break_reason: "ENTRY_HASH_MISMATCH",
        algorithm: CHAIN_ALGORITHM,
      };
    }
    expectedPrev = row.entry_hash;
  }
  return {
    chain_id: chainId,
    valid: true,
    entries_checked: checked,
    break_at_seq: null,
    break_reason: null,
    algorithm: CHAIN_ALGORITHM,
  };
}
