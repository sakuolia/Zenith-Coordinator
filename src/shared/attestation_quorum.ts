/**
 * @file attestation_quorum.ts — k-of-n quorum & equivocation for ConditionTemplate
 *       Attestations, mirroring the Watcher settlement-proof quorum.
 *
 * A `ConditionTemplate` leaf is satisfied only when **≥ `min_attester_quorum`
 * distinct attester operators** have a fresh PASS Attestation for the subject,
 * and those operators do not equivocate (some PASS, some FAIL on the same
 * subject). This is the exact trust-minimization policy the Watcher path applies
 * to external-rail observations (`shared/watcher.ts`); both share the pure
 * decision logic in `shared/operator_quorum.ts` so the rule ("distinct operators,
 * not keys; disagreement is not agreement") lives in one place.
 *
 * Freshness: only Attestations whose `occurred_at` is within `ttlSeconds` of
 * `now` count — a stale PASS cannot pad a quorum (same window as
 * `assertAttestationFresh`).
 *
 * @module shared/attestation_quorum
 */
import { nowISO } from "../types";
import { ATTESTATION_DEFAULT_TTL_SECONDS } from "./attestation";
import { detectEquivocation, distinctOperatorCount, meetsQuorum } from "./operator_quorum";

export interface AttestationQuorumParams {
  templateId: string;
  /** The subject the attestations are about (txid / gtid / leg_id). */
  subjectRef: string;
  /** Distinct attester operators required. Clamped to ≥1 by `meetsQuorum`. */
  requiredQuorum: number;
  now?: string;
  ttlSeconds?: number;
}

export interface AttestationQuorumResult {
  /** True iff quorum met AND no equivocation. */
  satisfied: boolean;
  /** Distinct operators (owner_ref) with a fresh PASS attestation. */
  passOperators: number;
  /** Required distinct operators (after the ≥1 clamp). */
  required: number;
  /** True when fresh attestations for this subject disagree (PASS vs FAIL). */
  equivocation: boolean;
  /** Distinct result claims seen across operators, for evidence/logging. */
  distinctClaims: string[];
}

/**
 * Evaluate the attester quorum for `(templateId, subjectRef)` over *fresh*
 * attestations. Counts distinct operators (`KeyRegistry.owner_ref`), so one
 * operator with several keys counts once — it cannot manufacture a quorum.
 */
export async function evaluateAttestationQuorum(
  db: D1Database,
  params: AttestationQuorumParams
): Promise<AttestationQuorumResult> {
  const now = params.now ?? nowISO();
  const ttl = params.ttlSeconds ?? ATTESTATION_DEFAULT_TTL_SECONDS;
  const cutoffISO = new Date(Date.parse(now) - ttl * 1000).toISOString();

  const rows = await db
    .prepare(
      `SELECT k.owner_ref AS owner_ref, a.verified_result AS claim
         FROM Attestation a
         JOIN KeyRegistry k ON k.key_id = a.attester_key_id
        WHERE a.template_id = ? AND a.subject_ref = ? AND a.occurred_at >= ?`
    )
    .bind(params.templateId, params.subjectRef, cutoffISO)
    .all<{ owner_ref: string; claim: string }>();

  const all = rows.results ?? [];
  const equ = detectEquivocation(all);
  const passOperators = distinctOperatorCount(all.filter((r) => r.claim === "PASS"));
  const required = Math.max(1, params.requiredQuorum);
  const satisfied = !equ.conflict && meetsQuorum(passOperators, required);

  return {
    satisfied,
    passOperators,
    required,
    equivocation: equ.conflict,
    distinctClaims: equ.distinctClaims,
  };
}
