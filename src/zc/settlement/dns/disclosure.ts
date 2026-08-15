/**
 * @file Official-disclosure message IDs for held settlement cycles.
 *
 * `public_message_id` is the join key between what ZC publishes as the official
 * status and what a participant is allowed to show its customers. The rulebook
 * (docs/specs/10_requirements.md §3.3.1-3/-4) restricts customer-facing wording during
 * a DNS_HOLD to the pre-approved template identified by this id, and forbids
 * naming a participant, quoting shortfall figures, or asserting insolvency.
 *
 * ZC never renders customer text itself; it hands the participant an id
 * (docs/specs/20_method_design.md §1.5.3, §9.4.4.2). Without a machine-readable id there is no
 * way to check after the fact that a participant's customer messaging matched
 * the official disclosure — which is why this is a first-class column rather
 * than an operational convention.
 *
 * Two templates exist because the audiences differ:
 *   - `DNS_HOLD_{business_date}` — the cycle-level official status, returned by
 *     `GET /api/dns/:business_date/status` to every participant.
 *   - `IGS_HOLD_{business_date}` — attached to a HIGH_VALUE transaction that is
 *     itself parked by the hold, where the customer *is* waiting on this
 *     transaction (docs/specs/20_method_design.md §9.4.4.1 (A)).
 *
 * Leaf module: no other DNS deps, so cycle.ts / settle.ts / the query layer can
 * all import it without creating a cycle.
 *
 * @module zc/settlement/dns/disclosure
 */

/** Cycle-level official status template id (all participants). */
export const dnsHoldMessageId = (businessDate: string) => `DNS_HOLD_${businessDate}`;

/** Transaction-level template id for a HIGH_VALUE tx parked by an IGS hold. */
export const igsHoldMessageId = (businessDate: string) => `IGS_HOLD_${businessDate}`;

/**
 * Reason codes that mean "this HIGH_VALUE transfer is parked because the day's
 * JPY cycle is held" (`checkIgsAdmission`). Kept here rather than inlined so the
 * disclosure path and the resume sweep cannot drift apart.
 */
export const IGS_HOLD_REASON_CODES = new Set([
  "DNS_RINGFENCED",
  "DNS_HOLD_IGS_STOPPED",
  "DNS_IGS_THROTTLED",
]);

/** What a transaction query should disclose while a settlement cycle is held. */
export interface HoldDisclosure {
  /** Pre-approved template id the participant must key its customer wording to. */
  public_message_id: string;
  /** Present only for ordinary lanes: the *interbank* leg is held, the tx is not. */
  dns_settlement_status?: "HOLD_ACTIVE";
}

/**
 * Resolve the official-disclosure context for a transaction, or null when no
 * hold applies.
 *
 * Two distinct cases, and conflating them is exactly the mistake the rulebook
 * forbids (docs/specs/20_method_design.md §9.4.4.1):
 *   (A) HIGH_VALUE parked by the IGS ring-fence — the transaction really is
 *       incomplete, so the customer-facing template is the IGS one.
 *   (B) an ordinary lane whose transaction is already SETTLED but whose DNS
 *       cycle is held — the transaction must NOT be shown as incomplete; only
 *       `dns_settlement_status` is attached, as informational context.
 */
export async function resolveHoldDisclosure(
  db: D1Database,
  tx: { reason_code: string | null; dns_cycle_id: string | null }
): Promise<HoldDisclosure | null> {
  if (tx.reason_code && IGS_HOLD_REASON_CODES.has(tx.reason_code)) {
    const held = await db
      .prepare(
        `SELECT business_date FROM DnsCycles
         WHERE currency = 'JPY' AND state = 'HOLD_ACTIVE'
         ORDER BY created_at DESC LIMIT 1`
      )
      .first<{ business_date: string }>();
    if (held) return { public_message_id: igsHoldMessageId(held.business_date) };
  }

  if (tx.dns_cycle_id) {
    const cycle = await db
      .prepare(`SELECT state, public_message_id FROM DnsCycles WHERE cycle_id = ?`)
      .bind(tx.dns_cycle_id)
      .first<{ state: string; public_message_id: string | null }>();
    if (cycle?.state === "HOLD_ACTIVE" && cycle.public_message_id) {
      return {
        public_message_id: cycle.public_message_id,
        dns_settlement_status: "HOLD_ACTIVE",
      };
    }
  }

  return null;
}
