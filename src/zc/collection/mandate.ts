/**
 * @file mandate.ts — the standing collection contract (DebitMandate).
 *
 * Registration rests on the customer's signature over the same canonical
 * payload `registerMandate` already verifies against KeyRegistry. ZC does not
 * create a contract on anyone's behalf, and does not judge whether the payee
 * deserves one: vetting the payee belongs to the bank that holds their account
 * and accepts their collection instructions (docs/specs/10_requirements.md
 * §3.2.8.8). ZC verifies the bank's signed assertion and records it.
 *
 * @module zc/collection/mandate
 */
import type { LegacyProfile } from "../../bank/legacy/adapter";
import type { CollectionMode, DebitMandateRow, Env, NonBusinessDayRule } from "../../types";
import { nowISO } from "../../types";
import { transitionEntityWithLog } from "../../shared/entity_state_log";
import { newUUID } from "../../shared/idempotency";
import { registerMandate, revokeMandate } from "../../shared/mandate";
import type { RegisterMandateParams } from "../../shared/mandate";
import { initBudget } from "./budget";

/**
 * Institutional ceilings (`PR-DD-*`). Values here are illustrative — the ledger
 * in `30_internal_design.md` §12.9 marks them as policy-determined — but the
 * *structure* is normative: a contract may never declare a limit looser than
 * the institution's.
 */
export const PR_DD_LADDER_MAX = 5;
export const PR_DD_LATEFEE_RATE_MAX = 0.146;
export const PR_DD_LATEFEE_CAP = 100_000;
export const PR_DD_PERIOD_AHEAD_MAX_MONTHS = 3;
/** Realtime collection is closed by default; opening it is a policy act. */
export const PR_DD_REALTIME_ENABLED = false;

export interface CollectionCaps {
  per_collection?: number | null;
  month_amount?: number | null;
  month_count?: number | null;
  two_month_amount?: number | null;
  day_count?: number | null;
  lifetime_amount?: number | null;
  lifetime_count?: number | null;
  pending_amount?: number | null;
  pending_count?: number | null;
  latefee_month?: number | null;
  latefee_rate_max?: number | null;
  realtime_month_count?: number | null;
  variance_ratio_max?: number | null;
}

export interface RegisterDebitMandateParams {
  payerBankId: string;
  payerAccountAlias: string;
  payeeBankId: string;
  payeeAccountHash: string;
  productRef: string;
  chargeMode: "PERIODIC" | "ITEMIZED";
  periodCycle?: "MONTHLY" | "YEARLY" | null;
  collectionMode: CollectionMode;
  noticeDaysMin: number;
  amendFreezeHours: number;
  ladderMax: number;
  nonbusinessDayRule?: NonBusinessDayRule;
  caps: CollectionCaps;
  eligibilityAttestationId?: string | null;
  /** Signature material for the underlying customer Mandate. */
  mandate: Omit<RegisterMandateParams, "principalParticipantId" | "granteeRef">;
}

export interface RegisterDebitMandateResult {
  result: "REGISTERED";
  dd_mandate_id: string;
  mandate_id: string;
  effective_collection_mode: CollectionMode;
  demoted: boolean;
  demotion_reason?: string;
}

/**
 * Which modes a paying bank's core can actually honour.
 *
 * A bank whose core has a batch window and no synchronous reserve cannot
 * answer within a request, so it cannot be the payer side of a REALTIME
 * collection however much the payee wants one. Deriving this from the profile
 * rather than trusting the request is what stops a mode from silently
 * behaving as something else (docs/specs/10_requirements.md §3.2.8.2-4).
 */
export function supportedModes(profile: LegacyProfile | null): CollectionMode[] {
  if (!profile) return ["SCHEDULED", "SCHEDULED_LONG"];
  if (profile.role === "PAYEE_ONLY") return [];
  const modes: CollectionMode[] = ["SCHEDULED", "SCHEDULED_LONG"];
  const alwaysOnline = profile.window_open_hour === null || profile.window_close_hour === null;
  if (profile.settlement_mode === "DIRECT" && profile.sync_reserve && alwaysOnline) {
    modes.unshift("REALTIME");
  }
  return modes;
}

/**
 * Resolve the mode actually used, demoting when the payer bank cannot support
 * the requested one. A demotion is always reported back — a caller that thinks
 * it has synchronous settlement but does not would mark receivables settled on
 * a provisional answer.
 */
export function resolveMode(
  requested: CollectionMode,
  profile: LegacyProfile | null
): { mode: CollectionMode; demoted: boolean; reason?: string } {
  const modes = supportedModes(profile);
  if (modes.includes(requested)) return { mode: requested, demoted: false };
  if (modes.length === 0) {
    return { mode: requested, demoted: false, reason: "MODE_UNSUPPORTED_BY_PAYER_BANK" };
  }
  return {
    mode: "SCHEDULED",
    demoted: true,
    reason: `payer bank cannot support ${requested}; demoted to SCHEDULED`,
  };
}

/** Reject a contract that declares a limit looser than the institution's. */
export function validateAgainstPolicy(
  p: RegisterDebitMandateParams
): { ok: true } | { ok: false; reason_code: string; message: string } {
  if (p.ladderMax > PR_DD_LADDER_MAX) {
    return {
      ok: false,
      reason_code: "LADDER_MAX_EXCEEDED",
      message: `ladder_max ${p.ladderMax} exceeds PR-DD-LADDER-MAX ${PR_DD_LADDER_MAX}`,
    };
  }
  const rate = p.caps.latefee_rate_max;
  if (rate !== undefined && rate !== null && rate > PR_DD_LATEFEE_RATE_MAX) {
    return {
      ok: false,
      reason_code: "CAP_EXCEEDS_POLICY",
      message: `latefee_rate_max ${rate} exceeds PR-DD-LATEFEE-RATE-MAX`,
    };
  }
  const feeCap = p.caps.latefee_month;
  if (feeCap !== undefined && feeCap !== null && feeCap > PR_DD_LATEFEE_CAP) {
    return {
      ok: false,
      reason_code: "CAP_EXCEEDS_POLICY",
      message: `latefee_month ${feeCap} exceeds PR-DD-LATEFEE-CAP`,
    };
  }
  if (p.collectionMode === "REALTIME" && !PR_DD_REALTIME_ENABLED) {
    return {
      ok: false,
      reason_code: "REALTIME_NOT_PERMITTED",
      message:
        "realtime collection is closed by default: it has no notice window, so a " +
        "scope breach cannot be rescued by additional authorisation, and it jumps " +
        "the day's fairly ordered queue",
    };
  }
  return { ok: true };
}

/** Read a payer bank's legacy-core profile, if one is registered. */
async function loadProfile(db: D1Database, bankId: string): Promise<LegacyProfile | null> {
  const row = await db
    .prepare(`SELECT * FROM LegacyProfiles WHERE bank_id = ?`)
    .bind(bankId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    bank_id: row.bank_id as string,
    role: row.role as LegacyProfile["role"],
    reservation_mode: row.reservation_mode as LegacyProfile["reservation_mode"],
    settlement_mode: row.settlement_mode as LegacyProfile["settlement_mode"],
    notify_mode: row.notify_mode as LegacyProfile["notify_mode"],
    sync_reserve: row.sync_reserve === 1,
    realtime_name_check: row.realtime_name_check === 1,
    batch_ingest: row.batch_ingest === 1,
    window_open_hour: (row.window_open_hour as number | null) ?? null,
    window_close_hour: (row.window_close_hour as number | null) ?? null,
  };
}

export async function registerDebitMandate(
  env: Env,
  params: RegisterDebitMandateParams
): Promise<RegisterDebitMandateResult | { result: "ERROR"; reason_code: string; message: string }> {
  const db = env.DB;
  const now = nowISO();

  const policy = validateAgainstPolicy(params);
  if (!policy.ok) {
    return { result: "ERROR", reason_code: policy.reason_code, message: policy.message };
  }

  const profile = await loadProfile(db, params.payerBankId);
  const resolved = resolveMode(params.collectionMode, profile);
  if (resolved.reason === "MODE_UNSUPPORTED_BY_PAYER_BANK") {
    return {
      result: "ERROR",
      reason_code: "MODE_UNSUPPORTED_BY_PAYER_BANK",
      message: `payer bank ${params.payerBankId} cannot be the paying side of a collection`,
    };
  }

  // The customer's signature is verified here; a failure throws a DomainError
  // that the router maps to 401/409.
  const mandate = await registerMandate(db, {
    ...params.mandate,
    principalParticipantId: params.payerBankId,
    granteeRef: `${params.payeeBankId}:${params.productRef}`,
  });

  const ddMandateId = `DDM-${newUUID()}`;
  const c = params.caps;
  await db
    .prepare(
      `INSERT INTO DebitMandate
         (dd_mandate_id, mandate_id, payer_bank_id, payer_account_alias, payee_bank_id,
          payee_account_hash, product_ref, charge_mode, period_cycle, collection_mode,
          notice_days_min, amend_freeze_hours, ladder_max, nonbusiness_day_rule,
          per_collection_cap, month_amount_cap, month_count_cap, two_month_amount_cap,
          day_count_cap, lifetime_amount_cap, lifetime_count_cap, pending_amount_cap,
          pending_count_cap, latefee_month_cap, latefee_rate_max, realtime_month_count_cap,
          variance_ratio_max, eligibility_attestation_id, state, revoked_at,
          created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'ACTIVE', NULL, ?, ?, 0)`
    )
    .bind(
      ddMandateId,
      mandate.mandate_id,
      params.payerBankId,
      params.payerAccountAlias,
      params.payeeBankId,
      params.payeeAccountHash,
      params.productRef,
      params.chargeMode,
      params.periodCycle ?? null,
      resolved.mode,
      params.noticeDaysMin,
      params.amendFreezeHours,
      params.ladderMax,
      params.nonbusinessDayRule ?? "NEXT_BUSINESS",
      c.per_collection ?? null,
      c.month_amount ?? null,
      c.month_count ?? null,
      c.two_month_amount ?? null,
      c.day_count ?? null,
      c.lifetime_amount ?? null,
      c.lifetime_count ?? null,
      c.pending_amount ?? null,
      c.pending_count ?? null,
      c.latefee_month ?? null,
      c.latefee_rate_max ?? null,
      c.realtime_month_count ?? null,
      c.variance_ratio_max ?? null,
      params.eligibilityAttestationId ?? null,
      now,
      now
    )
    .run();

  await initBudget(db, ddMandateId, now);
  await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE DebitMandate SET updated_at = ? WHERE dd_mandate_id = ?`,
      binds: [now, ddMandateId],
    },
    transition: {
      entityType: "DEBIT_MANDATE",
      entityId: ddMandateId,
      eventType: "DebitMandateRegistered",
      stateFrom: null,
      stateTo: "ACTIVE",
      actor: `BANK_${params.payeeBankId}`,
      payload: {
        mandate_id: mandate.mandate_id,
        product_ref: params.productRef,
        collection_mode: resolved.mode,
        demoted: resolved.demoted,
      },
    },
  });

  return {
    result: "REGISTERED",
    dd_mandate_id: ddMandateId,
    mandate_id: mandate.mandate_id,
    effective_collection_mode: resolved.mode,
    demoted: resolved.demoted,
    ...(resolved.demoted ? { demotion_reason: resolved.reason } : {}),
  };
}

const CAP_COLUMNS: Record<keyof CollectionCaps, string> = {
  per_collection: "per_collection_cap",
  month_amount: "month_amount_cap",
  month_count: "month_count_cap",
  two_month_amount: "two_month_amount_cap",
  day_count: "day_count_cap",
  lifetime_amount: "lifetime_amount_cap",
  lifetime_count: "lifetime_count_cap",
  pending_amount: "pending_amount_cap",
  pending_count: "pending_count_cap",
  latefee_month: "latefee_month_cap",
  latefee_rate_max: "latefee_rate_max",
  realtime_month_count: "realtime_month_count_cap",
  variance_ratio_max: "variance_ratio_max",
};

/**
 * Classify a cap change by whether it can hurt the customer.
 *
 * `NULL` means "unconstrained", so moving a cap to NULL is a raise however the
 * numbers compare, and moving away from NULL is a lowering. Getting that
 * backwards would let a payee remove a ceiling without a signature.
 */
export function classifyCapChange(
  current: number | null,
  next: number | null | undefined
): "raise" | "lower" | "same" {
  if (next === undefined) return "same";
  if (current === next) return "same";
  if (next === null) return "raise";
  if (current === null) return "lower";
  return next > current ? "raise" : "lower";
}

export interface UpdateCapsResult {
  result: "CAPS_UPDATED";
  dd_mandate_id: string;
  raised: string[];
  lowered: string[];
}

/**
 * Change a contract's caps mid-flight.
 *
 * Lowering needs nothing: the customer is only ever better off. Raising is
 * substantively a fresh grant of authority, so it needs the customer's
 * signature — the same asymmetry the notice amendment rules use, and the same
 * mechanism as one-shot additional authorisation, differing only in whether it
 * applies once or from now on.
 *
 * Counters are untouched. Otherwise "raise, collect, lower back" would launder
 * the consumption and leave a tidy-looking contract.
 */
export async function updateCaps(
  db: D1Database,
  ddMandateId: string,
  caps: CollectionCaps,
  signature: RegisterMandateParams | null,
  now: string = nowISO()
): Promise<UpdateCapsResult | { result: "ERROR"; reason_code: string; message: string }> {
  const row = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(ddMandateId)
    .first<DebitMandateRow>();
  if (!row) {
    return {
      result: "ERROR",
      reason_code: "DD_MANDATE_NOT_FOUND",
      message: `no such contract: ${ddMandateId}`,
    };
  }

  const raised: string[] = [];
  const lowered: string[] = [];
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];

  for (const [key, column] of Object.entries(CAP_COLUMNS) as Array<
    [keyof CollectionCaps, string]
  >) {
    const next = caps[key];
    if (next === undefined) continue;
    const current = row[column as keyof DebitMandateRow] as number | null;
    const kind = classifyCapChange(current, next);
    if (kind === "same") continue;
    (kind === "raise" ? raised : lowered).push(column);
    sets.push(`${column} = ?`);
    binds.push(next ?? null);
  }

  if (raised.length > 0 && !signature) {
    return {
      result: "ERROR",
      reason_code: "SIGNATURE_REQUIRED_FOR_RAISE",
      message: `raising ${raised.join(", ")} grants new authority and needs the customer's signature`,
    };
  }
  if (sets.length === 0) {
    return { result: "CAPS_UPDATED", dd_mandate_id: ddMandateId, raised: [], lowered: [] };
  }

  // A raise is a fresh grant, so it is recorded as its own signed Mandate
  // rather than mutating the original in place.
  if (signature) await registerMandate(db, signature);

  sets.push(`updated_at = ?`, `version = version + 1`);
  binds.push(now, ddMandateId);
  await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE DebitMandate SET ${sets.join(", ")} WHERE dd_mandate_id = ?`,
      binds,
    },
    transition: {
      entityType: "DEBIT_MANDATE",
      entityId: ddMandateId,
      eventType: "DebitMandateCapsChanged",
      stateFrom: row.state,
      stateTo: row.state,
      actor: "ZC",
      payload: { raised, lowered },
    },
  });

  return { result: "CAPS_UPDATED", dd_mandate_id: ddMandateId, raised, lowered };
}

export interface RevokeDebitMandateResult {
  result: "REVOKED";
  dd_mandate_id: string;
  revoked_at: string;
  superseded_collections: number;
  already: boolean;
}

/**
 * End a contract.
 *
 * Open notices are retired as LAPSED rather than SUPERSEDED: SUPERSEDED means
 * "an earlier rung already succeeded", and saying that about a collection the
 * customer cancelled would misdescribe why it never ran. They are ended rather
 * than deleted so the customer can still be told what happened to them.
 */
export async function revokeDebitMandate(
  db: D1Database,
  ddMandateId: string,
  opts: { reason?: string; actor?: string; now?: string } = {}
): Promise<RevokeDebitMandateResult | null> {
  const now = opts.now ?? nowISO();
  const row = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(ddMandateId)
    .first<DebitMandateRow>();
  if (!row) return null;
  if (row.state === "REVOKED") {
    return {
      result: "REVOKED",
      dd_mandate_id: ddMandateId,
      revoked_at: row.revoked_at ?? now,
      superseded_collections: 0,
      already: true,
    };
  }

  const applied = await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE DebitMandate SET state = 'REVOKED', revoked_at = ?, updated_at = ?,
              version = version + 1
            WHERE dd_mandate_id = ? AND state != 'REVOKED'`,
      binds: [now, now, ddMandateId],
    },
    transition: {
      entityType: "DEBIT_MANDATE",
      entityId: ddMandateId,
      eventType: "DebitMandateRevoked",
      stateFrom: row.state,
      stateTo: "REVOKED",
      actor: opts.actor ?? "ZC",
      payload: opts.reason ? { reason: opts.reason } : null,
    },
  });
  if (!applied) {
    return {
      result: "REVOKED",
      dd_mandate_id: ddMandateId,
      revoked_at: now,
      superseded_collections: 0,
      already: true,
    };
  }

  const lapsed = await db
    .prepare(
      `UPDATE ScheduledCollection
          SET state = 'LAPSED', reason_code = 'MANDATE_REVOKED', updated_at = ?,
              version = version + 1
        WHERE dd_mandate_id = ?
          AND state IN ('SCHEDULED', 'FROZEN', 'AWAITING_ADDITIONAL_AUTH')`
    )
    .bind(now, ddMandateId)
    .run();

  // Revoking the underlying Mandate is what makes the stop structural: after
  // this, no future preimage can be released for this contract at all.
  await revokeMandate(db, row.mandate_id, {
    reason: opts.reason ?? "DEBIT_MANDATE_REVOKED",
    actor: opts.actor,
    now,
  });

  return {
    result: "REVOKED",
    dd_mandate_id: ddMandateId,
    revoked_at: now,
    superseded_collections: lapsed.meta.changes ?? 0,
    already: false,
  };
}
