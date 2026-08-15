/**
 * @file GTID leg algebra — pure normalization of fan-out / fan-in / general
 *       N×M leg sets into the rank-aligned 1:1 sub-transfers that advanceGtid
 *       settles. No I/O.
 * @module zc/lanes/gtid/legs
 */
import type { GtidLegInput } from "../../../types";

/**
 * Normalize a balanced single-payer fan-out (1 × M, M > 1) into an aligned
 * M × M square so the existing rank-paired, payer-driven settlement path
 * (one Transaction per PAYER leg, its own suspense + H reservation keyed on the
 * PAYER leg) settles it correctly — crediting each PAYEE exactly its amount —
 * with no change to the fragile ready-check / execution / finalization wiring.
 *
 * The single payer's amount is split into one PAYER sub-leg per PAYEE, each
 * carrying that PAYEE's amount and a leg_id whose lexicographic rank matches the
 * PAYEE's (so advanceGtid's leg_id-rank pairing lines payer_i ↔ payee_i up with
 * equal amounts). Because the leg-ready-check reserves each PAYER leg's funds
 * under its own predicted `TX-GT-{leg_id}` (bank/ingress.ts), the M sub-legs
 * reserve M independent suspense blocks from the shared payer account — exactly
 * what the M parallel transfers need.
 *
 * Only a *balanced* one-currency fan-out is normalized: if the payer amount does
 * not equal the sum of payee amounts, the legs are returned unchanged so
 * advanceGtid's balance check cancels the imbalance rather than this masking it.
 * Fan-in (N × 1), aligned squares, and general N × M (both sides > 1) are left
 * untouched — advanceGtid settles or safely cancels them.
 */
export function normalizeFanOutLegs(legs: GtidLegInput[]): GtidLegInput[] {
  const payers = legs.filter((l) => l.role === "PAYER");
  const payees = legs.filter((l) => l.role === "PAYEE");
  if (payers.length !== 1 || payees.length <= 1) return legs;
  const payer = payers[0]!;

  const currencies = new Set<string>([
    payer.amount.currency,
    ...payees.map((p) => p.amount.currency),
  ]);
  if (currencies.size !== 1) return legs; // multi-currency fan-out: leave as-is

  const payeeSum = payees.reduce((s, p) => s + p.amount.value, 0);
  if (payeeSum !== payer.amount.value) return legs; // imbalance: let advanceGtid cancel

  const sortedPayees = [...payees].sort((a, b) =>
    a.leg_id < b.leg_id ? -1 : a.leg_id > b.leg_id ? 1 : 0
  );
  const subLegs: GtidLegInput[] = sortedPayees.map((payee, i) => ({
    leg_id: `${payer.leg_id}~${String(i).padStart(3, "0")}`,
    role: "PAYER",
    bank_id: payer.bank_id,
    account_hash: payer.account_hash,
    amount: { value: payee.amount.value, currency: payee.amount.currency },
    // Provenance: which registered leg this sub-leg came from. The derivation is
    // also visible in the leg_id format, but a format is not a contract —
    // a participant asking "which of my legs settled here" needs a field.
    origin_leg_id: payer.leg_id,
  }));
  return [...subLegs, ...payees];
}

const byLegId = (a: { leg_id: string }, b: { leg_id: string }) =>
  a.leg_id < b.leg_id ? -1 : a.leg_id > b.leg_id ? 1 : 0;

/**
 * Greedy bipartite **waterfall match** of one currency group: walk payers and
 * payees (already in leg_id order) matching min(remaining) each step. Because the
 * group is balanced (Σpayer == Σpayee), every unit is matched and per-leg sums
 * are preserved exactly, yielding K ≤ N+M−1 1:1 pairs. Pure helper shared by the
 * single- and multi-currency decomposition.
 */
function waterfallMatch(
  payers: GtidLegInput[],
  payees: GtidLegInput[]
): Array<{ payer: GtidLegInput; payee: GtidLegInput; amount: number }> {
  const ps = payers.map((p) => ({ leg: p, rem: p.amount.value }));
  const qs = payees.map((q) => ({ leg: q, rem: q.amount.value }));
  const pairs: Array<{ payer: GtidLegInput; payee: GtidLegInput; amount: number }> = [];
  let i = 0;
  let j = 0;
  while (i < ps.length && j < qs.length) {
    const amount = Math.min(ps[i]!.rem, qs[j]!.rem);
    if (amount > 0) pairs.push({ payer: ps[i]!.leg, payee: qs[j]!.leg, amount });
    ps[i]!.rem -= amount;
    qs[j]!.rem -= amount;
    if (ps[i]!.rem === 0) i++;
    if (qs[j]!.rem === 0) j++;
  }
  return pairs;
}

/**
 * Decompose a *balanced, general* N×M GTID (both sides > 1, counts/amounts not
 * rank-aligned) into a set of rank-aligned 1:1 sub-transfers via a greedy
 * bipartite **waterfall match**, so the existing payer-driven, rank-paired
 * settlement path settles it correctly — debiting each payer account exactly its
 * registered total and crediting each payee account exactly its registered total
 * — with no change to the ready-check / execution / finalization wiring. This is
 * the debit/credit-decoupling the general N:M flow needs, realized as a
 * registration-time decomposition rather than a new runtime path.
 *
 * **Multi-currency support**: a GTID whose legs span several currencies is
 * decomposed *per currency group*, never across currencies — so non-fungible
 * units are never netted at par (the invariant that made naive cross-currency
 * netting invalid). This is sound exactly when every currency balances on its
 * own (Σpayer == Σpayee within that currency); each group then waterfall-matches
 * independently and the concatenated pairs carry a single global ordinal so each
 * side sorts the k-th pair to rank k (advanceGtid's leg_id-rank pairing). The
 * result is rank-aligned with matching per-rank currency, satisfying the
 * settlement-shape guard.
 *
 * Out of scope (left untouched → advanceGtid cancels safely): **true cross-
 * currency FX** where a currency does not balance on its own (e.g. JPY paid for
 * USD received) — that needs an FX rate and per-currency ledger settlement of
 * non-equal legs (AMOUNT_BALANCE_MISMATCH); imbalanced shapes; and shapes
 * already settled by an existing path (1×1, fan-in N×1, fan-out 1×M, rank-aligned
 * squares — including multi-currency squares).
 */
export function decomposeGeneralNM(legs: GtidLegInput[]): GtidLegInput[] {
  const payers = legs.filter((l) => l.role === "PAYER");
  const payees = legs.filter((l) => l.role === "PAYEE");
  if (payers.length <= 1 || payees.length <= 1) return legs; // fan-in/out handled elsewhere

  // Per-currency balance: every currency must net to zero on its own. A currency
  // present on only one side, or with unequal totals, is true FX → leave the legs
  // unchanged so advanceGtid's per-currency balance check cancels it safely
  // (AMOUNT_BALANCE_MISMATCH) rather than this netting non-fungible units at par.
  const currencies = [
    ...new Set<string>([
      ...payers.map((p) => p.amount.currency),
      ...payees.map((p) => p.amount.currency),
    ]),
  ].sort();
  for (const ccy of currencies) {
    const pSum = payers
      .filter((p) => p.amount.currency === ccy)
      .reduce((s, p) => s + p.amount.value, 0);
    const qSum = payees
      .filter((p) => p.amount.currency === ccy)
      .reduce((s, p) => s + p.amount.value, 0);
    if (pSum !== qSum) return legs; // unbalanced currency: out of scope (true FX)
  }

  const sortedP = [...payers].sort(byLegId);
  const sortedQ = [...payees].sort(byLegId);

  // A rank-aligned square (per-rank equal amount AND currency) already settles via
  // the existing path; don't churn it into different leg_ids (keeps the aligned-
  // square regression guards stable, single- or multi-currency).
  const alignedSquare =
    sortedP.length === sortedQ.length &&
    sortedP.every(
      (p, i) =>
        p.amount.value === sortedQ[i]!.amount.value &&
        p.amount.currency === sortedQ[i]!.amount.currency
    );
  if (alignedSquare) return legs;

  // Decompose each currency group independently; a single running ordinal across
  // groups keeps each side's k-th pair at rank k after a leg_id sort.
  const subLegs: GtidLegInput[] = [];
  let ordinal = 0;
  for (const ccy of currencies) {
    const cps = sortedP.filter((p) => p.amount.currency === ccy);
    const cqs = sortedQ.filter((q) => q.amount.currency === ccy);
    for (const pair of waterfallMatch(cps, cqs)) {
      const ord = String(ordinal++).padStart(4, "0");
      subLegs.push({
        leg_id: `${ord}~P~${pair.payer.leg_id}`,
        role: "PAYER",
        bank_id: pair.payer.bank_id,
        account_hash: pair.payer.account_hash,
        amount: { value: pair.amount, currency: ccy },
        origin_leg_id: pair.payer.leg_id,
      });
      subLegs.push({
        leg_id: `${ord}~Q~${pair.payee.leg_id}`,
        role: "PAYEE",
        bank_id: pair.payee.bank_id,
        account_hash: pair.payee.account_hash,
        amount: { value: pair.amount, currency: ccy },
        origin_leg_id: pair.payee.leg_id,
      });
    }
  }
  return subLegs;
}

/**
 * Normalize any GTID leg shape into one the payer-driven, rank-paired settlement
 * path can settle faithfully: a balanced single-payer fan-out (1×M) is squared
 * up (`normalizeFanOutLegs`, #14); a balanced general N×M — single- *or* multi-
 * currency, as long as each currency balances on its own — is decomposed into
 * rank-aligned 1:1 sub-transfers (`decomposeGeneralNM`, #18 / #19). Every other
 * shape (1×1, fan-in, aligned squares, imbalanced, true cross-currency FX) is
 * returned unchanged for the existing settle-or-cancel logic.
 */
export function normalizeGtidLegs(legs: GtidLegInput[]): GtidLegInput[] {
  const fannedOut = normalizeFanOutLegs(legs);
  if (fannedOut !== legs) return fannedOut;
  return decomposeGeneralNM(legs);
}
