/**
 * @file HTLC claim — preimage / attestation / AND-OR-condition fulfillment.
 *       All three converge on settleAfterPreimage once the unlock is verified.
 * @module zc/lanes/htlc/claim
 */
import type {
  Env,
  HtlcClaimRequest,
  HtlcAttestClaimRequest,
  HtlcConditionsClaimRequest,
  HtlcContractRow,
} from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";
import { sha256hex } from "../../../shared/hmac";
import { recordAttestation, assertAttestationFresh } from "../../../shared/attestation";
import { evaluateAttestationQuorum } from "../../../shared/attestation_quorum";
import {
  validateConditionExpr,
  evaluateConditionExpr,
  collectTemplateIds,
  type ConditionExpr,
} from "../../platform/condition_expr";
import {
  evaluateLedgerPredicate,
  validateLedgerPredicate,
  type LedgerPredicate,
} from "../../platform/ledger_predicate";
import { openCase } from "../../cases/case";
import { settleAfterPreimage, type HtlcFulfillResult } from "./_fulfill";
import { cancelHtlc } from "./cancel";

/**
 * preimage presentation: HTLC_LOCKED → HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE
 */
export async function claimHtlc(req: HtlcClaimRequest, env: Env): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();

  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "NOT_FOUND",
    };
  if (htlc.state !== "HTLC_LOCKED")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  // Check timelock expiry
  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(req.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "DECIDED_CANCEL",
      reason_code: "TIMELOCK_EXPIRED",
    };
  }

  // preimage validation
  const computedHash = await sha256hex(req.preimage);
  if (computedHash !== htlc.hashlock) {
    // Record the validation failure in the FinalityLog (do not emit the actual preimage)
    await writeFinalityLog(db, {
      txid: htlc.txid,
      event_type: "HtlcClaimRejected",
      state_from: "HTLC_LOCKED",
      state_to: "HTLC_LOCKED",
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        reason_code: "INVALID_PREIMAGE",
        computed_hash_prefix: `${computedHash.slice(0, 8)}…`,
      }),
      txid_or_gtid: htlc.txid,
    });
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_PREIMAGE",
    };
  }

  return settleAfterPreimage(
    htlc,
    "HTLC_LOCKED",
    "HtlcFulfillRequested",
    {},
    {
      sql: `UPDATE HtlcContracts SET state='HTLC_FULFILL_REQUESTED', version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_LOCKED'`,
      binds: [now, req.htlc_id],
    },
    env
  );
}

/**
 * Theme C (programmability generalization): fulfill an HTLC via a signed
 * Attestation against its whitelisted `condition_template_id`, instead of
 * presenting the preimage.
 *
 * HTLC's "preimage presented = condition satisfied" is generalized to
 * "a whitelisted ConditionTemplate's PASS attestation was presented". The
 * settlement path (HTLC_LOCKED -> HTLC_FULFILL_REQUESTED -> DECIDED_TO_SETTLE)
 * is identical to `claimHtlc` — state names are unchanged.
 *
 * ZC does not judge whether the underlying condition was actually met; it
 * only verifies the attester's signature, scope, and freshness via
 * `recordAttestation`/`assertAttestationFresh` (§1 P2) and requires
 * `verified_result === 'PASS'`.
 */
export async function claimHtlcByAttestation(
  req: HtlcAttestClaimRequest,
  env: Env
): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();

  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "HTLC_NOT_FOUND",
    };
  if (!htlc.condition_template_id)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "CONDITION_TEMPLATE_NOT_SET",
    };
  if (req.template_id !== htlc.condition_template_id)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "TEMPLATE_MISMATCH",
    };
  if (htlc.state !== "HTLC_LOCKED")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  // Check timelock expiry (same as claimHtlc)
  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(req.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "DECIDED_CANCEL",
      reason_code: "TIMELOCK_EXPIRED",
    };
  }

  // Verify signature, whitelist, and attester scope (§K / §1 P2). Throws
  // DomainError (TEMPLATE_NOT_WHITELISTED / ATTESTATION_INVALID /
  // ATTESTER_UNAUTHORIZED / signature errors) which propagates to the caller.
  const attestation = await recordAttestation(db, {
    templateId: req.template_id,
    subjectRef: htlc.txid,
    statementHash: req.statement_hash,
    verifiedResult: req.verified_result,
    attesterKeyId: req.attester_key_id,
    nonce: req.nonce,
    occurredAt: req.occurred_at,
    signatureB64: req.signature,
  });

  // Freshness check (docs/specs/30_internal_design.md §11.2-b) — throws ATTESTATION_EXPIRED if stale.
  assertAttestationFresh(attestation, now);

  if (attestation.verified_result !== "PASS") {
    await writeFinalityLog(db, {
      txid: htlc.txid,
      event_type: "HtlcClaimRejected",
      state_from: "HTLC_LOCKED",
      state_to: "HTLC_LOCKED",
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        reason_code: "ATTESTATION_NOT_PASS",
        attestation_id: attestation.attestation_id,
        template_id: req.template_id,
      }),
      txid_or_gtid: htlc.txid,
    });
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "ATTESTATION_NOT_PASS",
    };
  }

  return settleAfterPreimage(
    htlc,
    "HTLC_LOCKED",
    "HtlcFulfillRequestedByAttestation",
    { attestation_id: attestation.attestation_id, template_id: req.template_id },
    {
      sql: `UPDATE HtlcContracts SET state='HTLC_FULFILL_REQUESTED', version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_LOCKED'`,
      binds: [now, req.htlc_id],
    },
    env
  );
}

/**
 * Programmability generalization (30_internal_design.md § 7): fulfill an HTLC whose
 * `condition_expr_json` is an AND/OR tree over whitelisted ConditionTemplates,
 * by presenting one signed Attestation per template the claimant relies on.
 *
 * Each attestation is recorded and verified exactly as in claimHtlcByAttestation
 * (signature, attester scope, freshness via recordAttestation/assertAttestationFresh)
 * — ZC never judges the underlying real-world fact. The set of templates whose
 * attestation is fresh + PASS is fed to the pure boolean evaluator; the HTLC
 * settles (HTLC_LOCKED → HTLC_FULFILL_REQUESTED → …) only when the expression is
 * satisfied. Otherwise an HtlcConditionsEvaluated(false) event is recorded and
 * the claim is rejected (CONDITIONS_NOT_MET) without moving the contract.
 */
export async function claimHtlcByConditions(
  req: HtlcConditionsClaimRequest,
  env: Env
): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();
  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "HTLC_NOT_FOUND",
    };
  if (!htlc.condition_expr_json)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "CONDITION_EXPR_NOT_SET",
    };
  if (htlc.state !== "HTLC_LOCKED")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(req.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "DECIDED_CANCEL",
      reason_code: "TIMELOCK_EXPIRED",
    };
  }

  const expr = JSON.parse(htlc.condition_expr_json) as ConditionExpr;
  // Defensive re-validation (the stored tree was validated at create, but a
  // corrupt row must not crash the evaluator).
  const v = validateConditionExpr(expr);
  if (!v.ok)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "CONDITION_EXPR_INVALID",
    };
  const exprTemplates = [...new Set(collectTemplateIds(expr))];

  // Resolve the templates the expression references: their kind (attestation vs
  // ledger-predicate) and, for attestation templates, the distinct-operator
  // quorum they require.
  const templateRows = exprTemplates.length
    ? ((
        await db
          .prepare(
            `SELECT template_id, min_attester_quorum, ledger_predicate_json
               FROM ConditionTemplate
              WHERE template_id IN (${exprTemplates.map(() => "?").join(", ")})`
          )
          .bind(...exprTemplates)
          .all<{
            template_id: string;
            min_attester_quorum: number;
            ledger_predicate_json: string | null;
          }>()
      ).results ?? [])
    : [];
  const templateById = new Map(templateRows.map((r) => [r.template_id, r]));
  const isLedger = (tid: string) => templateById.get(tid)?.ledger_predicate_json != null;

  // 1. Record + verify each presented attestation (signature, attester scope,
  //    freshness via recordAttestation/assertAttestationFresh). Ledger-predicate
  //    templates take no attestation — ZC resolves them itself — so any presented
  //    attestation for one is ignored rather than recorded.
  for (const a of req.attestations ?? []) {
    if (!exprTemplates.includes(a.template_id)) continue; // ignore irrelevant templates
    if (isLedger(a.template_id)) continue; // ledger predicates are not attested
    const attestation = await recordAttestation(db, {
      templateId: a.template_id,
      subjectRef: htlc.txid,
      statementHash: a.statement_hash,
      verifiedResult: a.verified_result,
      attesterKeyId: a.attester_key_id,
      nonce: a.nonce,
      occurredAt: a.occurred_at,
      signatureB64: a.signature,
    });
    assertAttestationFresh(attestation, now);
  }

  // 2. Evaluate each referenced template into the satisfied set. Attestation
  //    templates require a distinct-operator quorum and must not equivocate;
  //    ledger-predicate templates are resolved against committed FinalityLog.
  const satisfied = new Set<string>();
  const quorumDetail: Record<
    string,
    { pass_operators: number; required: number; equivocation: boolean }
  > = {};
  const ledgerDetail: Record<string, boolean> = {};
  const equivocatingTemplates: string[] = [];

  for (const tid of exprTemplates) {
    if (isLedger(tid)) {
      const pred = JSON.parse(templateById.get(tid)!.ledger_predicate_json!) as LedgerPredicate;
      const ok = validateLedgerPredicate(pred).ok
        ? await evaluateLedgerPredicate(db, pred, now)
        : false;
      ledgerDetail[tid] = ok;
      if (ok) satisfied.add(tid);
    } else {
      const requiredQuorum = templateById.get(tid)?.min_attester_quorum ?? 1;
      const q = await evaluateAttestationQuorum(db, {
        templateId: tid,
        subjectRef: htlc.txid,
        requiredQuorum,
        now,
      });
      quorumDetail[tid] = {
        pass_operators: q.passOperators,
        required: q.required,
        equivocation: q.equivocation,
      };
      if (q.equivocation) equivocatingTemplates.push(tid);
      if (q.satisfied) satisfied.add(tid);
    }
  }

  const met = evaluateConditionExpr(expr, satisfied);

  await writeFinalityLog(db, {
    txid: htlc.txid,
    event_type: "HtlcConditionsEvaluated",
    state_from: "HTLC_LOCKED",
    state_to: "HTLC_LOCKED",
    payload_json: JSON.stringify({
      htlc_id: req.htlc_id,
      satisfied: [...satisfied].sort(),
      required_templates: [...exprTemplates].sort(),
      quorum: quorumDetail,
      ledger: ledgerDetail,
      equivocating_templates: equivocatingTemplates.sort(),
      evaluated_at: now,
      met,
    }),
    txid_or_gtid: htlc.txid,
  });

  // Equivocation is fail-closed: a contradicted template never enters the
  // satisfied set (so it cannot contribute to `met`), and we converge it into a
  // CASE for audit. An independent branch may still satisfy the expression.
  if (equivocatingTemplates.length > 0) {
    await openCase(db, {
      related_txid: htlc.txid,
      reason_code: "ATTESTATION_EQUIVOCATION",
      description: `Equivocating condition templates: ${equivocatingTemplates.join(", ")}`,
      opened_by: "ZC",
    });
  }

  if (!met) {
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "CONDITIONS_NOT_MET",
    };
  }

  return settleAfterPreimage(
    htlc,
    "HTLC_LOCKED",
    "HtlcFulfillRequestedByAttestation",
    { condition_expr_satisfied: [...satisfied].sort(), quorum: quorumDetail, ledger: ledgerDetail },
    {
      sql: `UPDATE HtlcContracts SET state='HTLC_FULFILL_REQUESTED', version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_LOCKED'`,
      binds: [now, req.htlc_id],
    },
    env
  );
}
