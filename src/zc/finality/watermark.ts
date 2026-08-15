/**
 * @file watermark.ts — per-chain read-model watermarks for query responses.
 *
 * A single `MAX(event_seq)` answers "how far has the read model caught up?" only
 * when every fact about the transaction lives on one log. It does not: the
 * FinalityLog is a *set* of hash chains, one per txid and one per non-transaction
 * aggregate (gtid, DNS cycle, LSM run — `finality_chain.ts`). A GTID leg's fate
 * is decided on the GT chain; a transfer parked in a net cycle is settled on the
 * DNS chain. Collapsing those into one number loses exactly the information an
 * auditor needs to reproduce the answer: *which* log positions the figures were
 * read at (docs/specs/30_internal_design.md §13.6).
 *
 * So the response carries the collapsed number for the counter (`watermark`) and
 * the per-chain breakdown for audit (`watermark_detail.shards`).
 *
 * **Chain, not physical shard.** The spec's illustrative keys (`TX_SHARD:12`)
 * name a partition of the log. ZC's unit of replay is the hash chain, and it is
 * addressable by id, so the keys are `TX:<txid>` / `GT:<gtid>` / `DNS:<cycle_id>`
 * — an auditor can take a key straight from the response and re-walk that chain.
 * A physical sharding scheme, if one is ever introduced, adds keys here; it does
 * not change what the field means.
 *
 * @module zc/finality/watermark
 */

/** Prefixes distinguishing the chain kinds a transaction can appear on. */
const CHAIN_KIND = {
  tx: "TX",
  gtid: "GT",
  dnsCycle: "DNS",
} as const;

export interface WatermarkDetail {
  /** Chain id → the highest `event_seq` this response reflects on that chain. */
  shards: Record<string, number>;
}

export interface Watermarks {
  /**
   * The single number the counter/UI shows: the highest `event_seq` across every
   * chain below. Kept as the max (not the tx chain alone) so it never claims to
   * be more current than the breakdown it summarises.
   */
  watermark: number;
  watermark_detail: WatermarkDetail;
  /**
   * Newest committed fact on the transaction's OWN chain (`MAX(occurred_at)`), or
   * null when it has none. This is what `freshness_level` measures the derived
   * row against, and it stays scoped to the tx chain on purpose: §13.6 defines
   * the lag as "当該 txid の FinalityLog 先端" — widening it to the GT/DNS chains
   * would turn an unrelated cycle event into this transaction's staleness.
   */
  tx_chain_tip_at: string | null;
}

/**
 * Collect the watermark of every FinalityLog chain that carries facts about
 * `txid`: its own chain, the GT chain when the transaction is a GTID leg, and
 * the DNS cycle chain when it is snapshotted into a net cycle.
 *
 * A chain with no entries is reported as 0 rather than omitted — "this chain
 * exists and has nothing for you yet" is a different statement from "there is no
 * such chain", and an auditor comparing two responses needs the distinction.
 */
export async function getWatermarks(
  db: D1Database,
  tx: { txid: string; dns_cycle_id?: string | null }
): Promise<Watermarks> {
  // Non-transaction chains this txid participates in, resolved first so the
  // watermark query can read them all in one statement.
  const leg = await db
    .prepare(`SELECT gtid FROM GtidLegs WHERE txid = ? LIMIT 1`)
    .bind(tx.txid)
    .first<{ gtid: string }>();

  const aggregateChains: Array<{ key: string; id: string }> = [];
  if (leg?.gtid) aggregateChains.push({ key: `${CHAIN_KIND.gtid}:${leg.gtid}`, id: leg.gtid });
  if (tx.dns_cycle_id) {
    aggregateChains.push({ key: `${CHAIN_KIND.dnsCycle}:${tx.dns_cycle_id}`, id: tx.dns_cycle_id });
  }

  const shards: Record<string, number> = {};

  const txRow = await db
    .prepare(
      `SELECT MAX(event_seq) AS wm, MAX(occurred_at) AS tip_at FROM FinalityLog WHERE txid = ?`
    )
    .bind(tx.txid)
    .first<{ wm: number | null; tip_at: string | null }>();
  shards[`${CHAIN_KIND.tx}:${tx.txid}`] = txRow?.wm ?? 0;

  if (aggregateChains.length > 0) {
    const placeholders = aggregateChains.map(() => "?").join(",");
    // `txid IS NULL` keeps this to the aggregate's own chain: a GT/DNS chain is
    // the set of rows carrying that id with no txid (finality_chain.ts —
    // per-leg rows belong to their own tx chain and are already counted above).
    const rows = await db
      .prepare(
        `SELECT gtid, MAX(event_seq) AS wm FROM FinalityLog
          WHERE gtid IN (${placeholders}) AND txid IS NULL
          GROUP BY gtid`
      )
      .bind(...aggregateChains.map((c) => c.id))
      .all<{ gtid: string; wm: number | null }>();

    const byId = new Map((rows.results ?? []).map((r) => [r.gtid, r.wm ?? 0]));
    for (const chain of aggregateChains) shards[chain.key] = byId.get(chain.id) ?? 0;
  }

  const values = Object.values(shards);
  return {
    watermark: values.length > 0 ? Math.max(...values) : 0,
    watermark_detail: { shards },
    tx_chain_tip_at: txRow?.tip_at ?? null,
  };
}
