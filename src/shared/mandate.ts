/**
 * @file Mandate registration and validation — "on whose authority was this
 * instruction issued" as a first-class entity.
 *
 * No new lane/state is introduced. `assertMandateValid` is called at
 * acceptance time to resolve a `mandate_id`, walk the delegation chain via
 * `parent_mandate_id`, and verify amount/purpose/lane are within scope at
 * every link as of "now". `registerMandate` verifies the principal's
 * signature over the mandate terms against `KeyRegistry` (§K).
 *
 * @module shared/mandate
 */
import type { MandateRow } from "../types";
import { nowISO } from "../types";
import { DomainError } from "./errors";
import { transitionEntityWithLog } from "./entity_state_log";
import { newUUID } from "./idempotency";
import { verifyExternalSignature } from "./external_signature";

/** Reason codes `assertMandateValid` may throw, surfaced by `checkMandate`. */
const MANDATE_REASON_CODES = new Set([
  "MANDATE_NOT_FOUND",
  "MANDATE_REVOKED",
  "MANDATE_EXPIRED",
  "MANDATE_BREACH",
]);

/** Maximum delegation-chain depth walked by `assertMandateValid` (cycle guard). */
const MAX_CHAIN_DEPTH = 10;

export interface RegisterMandateParams {
  principalParticipantId: string;
  granteeRef: string;
  parentMandateId?: string | null;
  /** NULL/undefined = no amount limit at this link. */
  maxAmount?: number | null;
  /** NULL/undefined = unrestricted purposes at this link. */
  allowedPurposes?: string[] | null;
  /** NULL/undefined = unrestricted lanes at this link. */
  allowedLanes?: string[] | null;
  validFrom: string;
  validTo: string;
  /** `KeyRegistry.key_id` of the principal. */
  principalKeyId: string;
  nonce: string;
  /** RFC3339 timestamp claimed by the principal. */
  occurredAt: string;
  /** Base64 signature over the mandate terms (see `buildMandatePayload`). */
  signatureB64: string;
}

/** The canonical payload a principal signs when granting a mandate. */
export function buildMandatePayload(params: {
  principalParticipantId: string;
  granteeRef: string;
  parentMandateId?: string | null;
  maxAmount?: number | null;
  allowedPurposes?: string[] | null;
  allowedLanes?: string[] | null;
  validFrom: string;
  validTo: string;
}): Record<string, unknown> {
  return {
    principal_participant_id: params.principalParticipantId,
    grantee_ref: params.granteeRef,
    parent_mandate_id: params.parentMandateId ?? null,
    max_amount: params.maxAmount ?? null,
    allowed_purposes: params.allowedPurposes ?? null,
    allowed_lanes: params.allowedLanes ?? null,
    valid_from: params.validFrom,
    valid_to: params.validTo,
  };
}

/**
 * Verify the principal's signature over the mandate terms (§K) and persist a
 * new `Mandate` row. Does not validate `parent_mandate_id` exists — that is
 * the caller's responsibility (the parent must already be registered).
 */
export async function registerMandate(
  db: D1Database,
  params: RegisterMandateParams
): Promise<MandateRow> {
  const payload = buildMandatePayload(params);
  await verifyExternalSignature(db, {
    keyId: params.principalKeyId,
    nonce: params.nonce,
    occurredAt: params.occurredAt,
    signatureB64: params.signatureB64,
    payload,
  });

  const row: MandateRow = {
    mandate_id: `MANDATE-${newUUID()}`,
    principal_participant_id: params.principalParticipantId,
    grantee_ref: params.granteeRef,
    parent_mandate_id: params.parentMandateId ?? null,
    max_amount: params.maxAmount ?? null,
    allowed_purposes: params.allowedPurposes ? JSON.stringify(params.allowedPurposes) : null,
    allowed_lanes: params.allowedLanes ? JSON.stringify(params.allowedLanes) : null,
    valid_from: params.validFrom,
    valid_to: params.validTo,
    principal_key_id: params.principalKeyId,
    signature: params.signatureB64,
    nonce: params.nonce,
    occurred_at: params.occurredAt,
    revoked_at: null,
    created_at: nowISO(),
  };

  await db
    .prepare(
      `INSERT INTO Mandate (mandate_id, principal_participant_id, grantee_ref, parent_mandate_id, max_amount, allowed_purposes, allowed_lanes, valid_from, valid_to, principal_key_id, signature, nonce, occurred_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.mandate_id,
      row.principal_participant_id,
      row.grantee_ref,
      row.parent_mandate_id,
      row.max_amount,
      row.allowed_purposes,
      row.allowed_lanes,
      row.valid_from,
      row.valid_to,
      row.principal_key_id,
      row.signature,
      row.nonce,
      row.occurred_at,
      row.revoked_at,
      row.created_at
    )
    .run();

  return row;
}

/**
 * Set `revoked_at` on a mandate so `assertMandateValid` starts rejecting it.
 *
 * Revocation does not reach backwards: the check is `now >= revoked_at`, so
 * instructions that were authorised before this call keep their authority. Nor
 * does it need to walk the chain — a child inherits its ancestors' scope, so
 * revoking a parent already blocks every descendant.
 *
 * Idempotent: a repeat call returns the original `revoked_at` with
 * `already: true` rather than moving the timestamp forward, because moving it
 * would silently re-authorise the window between the two calls.
 *
 * The `revoked_at` column and its check predate this function; what was missing
 * was any production path that writes it (only tests did, via raw SQL). A
 * standing collection mandate is only as safe as the customer's ability to stop
 * it, so the write path is a prerequisite for continuous collection
 * (`docs/specs/32_api_contracts.md § POST /api/mandates/:mandate_id/revoke`).
 */
export async function revokeMandate(
  db: D1Database,
  mandateId: string,
  opts: { reason?: string; actor?: string; now?: string } = {}
): Promise<{ revoked_at: string; already: boolean } | null> {
  const { reason, actor } = opts;
  const now = opts.now ?? nowISO();
  const existing = await db
    .prepare(`SELECT revoked_at FROM Mandate WHERE mandate_id = ?`)
    .bind(mandateId)
    .first<{ revoked_at: string | null }>();
  if (!existing) return null;
  if (existing.revoked_at !== null) {
    return { revoked_at: existing.revoked_at, already: true };
  }

  // CAS + paired audit fact in one batch: `revoked_at IS NULL` is the guard, and
  // the log INSERT is gated on `changes() > 0` so the fact is written iff the
  // UPDATE actually hit a row.
  const applied = await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE Mandate SET revoked_at = ? WHERE mandate_id = ? AND revoked_at IS NULL`,
      binds: [now, mandateId],
    },
    transition: {
      entityType: "MANDATE",
      entityId: mandateId,
      eventType: "MandateRevoked",
      stateFrom: "ACTIVE",
      stateTo: "REVOKED",
      actor: actor ?? "ZC",
      payload: reason ? { reason } : null,
    },
  });

  // Lost the CAS to a concurrent revoke: report that revocation, not ours.
  if (!applied) {
    const raced = await db
      .prepare(`SELECT revoked_at FROM Mandate WHERE mandate_id = ?`)
      .bind(mandateId)
      .first<{ revoked_at: string | null }>();
    return { revoked_at: raced?.revoked_at ?? now, already: true };
  }

  return { revoked_at: now, already: false };
}

export interface MandateCheck {
  /** Instruction amount; checked against `max_amount` at every link of the chain. */
  amount?: number;
  /** Purpose code (e.g. 'P01'..'P07'); checked against `allowed_purposes`. */
  purpose?: string;
  /** Lane name (e.g. 'EXPRESS'); checked against `allowed_lanes`. */
  lane?: string;
}

/**
 * Resolve `mandateId`, walk its delegation chain (via `parent_mandate_id`),
 * and assert every link is valid as of `now` and within the scope of
 * `check`. Delegation only narrows: a sub-mandate's limits do not relax the
 * principal's.
 *
 * Throws `DomainError`:
 *  - `MANDATE_NOT_FOUND` — `mandateId` (or an ancestor) does not exist.
 *  - `MANDATE_REVOKED` — a link's `revoked_at` is at/before `now`.
 *  - `MANDATE_EXPIRED` — `now` is outside a link's `[valid_from, valid_to)`.
 *  - `MANDATE_BREACH` — `check.amount`/`purpose`/`lane` exceeds a link's scope.
 *
 * @returns The chain from the referenced mandate (index 0) up to its root.
 */
export async function assertMandateValid(
  db: D1Database,
  mandateId: string,
  check: MandateCheck = {},
  now: string = nowISO()
): Promise<MandateRow[]> {
  const chain: MandateRow[] = [];
  let currentId: string | null = mandateId;

  for (let depth = 0; currentId !== null; depth++) {
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new DomainError(
        "MANDATE_BREACH",
        `Mandate delegation chain exceeds ${MAX_CHAIN_DEPTH} links`,
        {
          mandate_id: mandateId,
        }
      );
    }

    const mandate: MandateRow | null = await db
      .prepare(`SELECT * FROM Mandate WHERE mandate_id = ?`)
      .bind(currentId)
      .first<MandateRow>();
    if (!mandate) {
      throw new DomainError("MANDATE_NOT_FOUND", `Mandate not found: ${currentId}`, {
        mandate_id: currentId,
        requested_mandate_id: mandateId,
      });
    }

    if (mandate.revoked_at !== null && now >= mandate.revoked_at) {
      throw new DomainError(
        "MANDATE_REVOKED",
        `Mandate ${mandate.mandate_id} was revoked before ${now}`,
        {
          mandate_id: mandate.mandate_id,
          revoked_at: mandate.revoked_at,
        }
      );
    }

    if (now < mandate.valid_from || now >= mandate.valid_to) {
      throw new DomainError(
        "MANDATE_EXPIRED",
        `Mandate ${mandate.mandate_id} is not valid at ${now}`,
        {
          mandate_id: mandate.mandate_id,
          valid_from: mandate.valid_from,
          valid_to: mandate.valid_to,
        }
      );
    }

    if (
      check.amount !== undefined &&
      mandate.max_amount !== null &&
      check.amount > mandate.max_amount
    ) {
      throw new DomainError(
        "MANDATE_BREACH",
        `Amount ${check.amount} exceeds max_amount of mandate ${mandate.mandate_id}`,
        {
          mandate_id: mandate.mandate_id,
          amount: check.amount,
          max_amount: mandate.max_amount,
        }
      );
    }

    if (check.purpose !== undefined && mandate.allowed_purposes !== null) {
      const purposes = JSON.parse(mandate.allowed_purposes) as string[];
      if (!purposes.includes(check.purpose)) {
        throw new DomainError(
          "MANDATE_BREACH",
          `Purpose ${check.purpose} not allowed by mandate ${mandate.mandate_id}`,
          {
            mandate_id: mandate.mandate_id,
            purpose: check.purpose,
            allowed_purposes: purposes,
          }
        );
      }
    }

    if (check.lane !== undefined && mandate.allowed_lanes !== null) {
      const lanes = JSON.parse(mandate.allowed_lanes) as string[];
      if (!lanes.includes(check.lane)) {
        throw new DomainError(
          "MANDATE_BREACH",
          `Lane ${check.lane} not allowed by mandate ${mandate.mandate_id}`,
          {
            mandate_id: mandate.mandate_id,
            lane: check.lane,
            allowed_lanes: lanes,
          }
        );
      }
    }

    chain.push(mandate);
    currentId = mandate.parent_mandate_id;
  }

  return chain;
}

export interface MandateCheckResult {
  ok: boolean;
  /** Set when `ok` is false: one of MANDATE_NOT_FOUND/REVOKED/EXPIRED/BREACH. */
  reason_code?: string;
  message?: string;
}

/**
 * Non-throwing wrapper around `assertMandateValid`, for use at acceptance
 * (precheck) time (Theme B: Agentic Commerce). Callers route
 * `{ok: false}` to PRECHECKED_SUSPENDED + a Case using `reason_code` rather
 * than hard-rejecting the transaction.
 */
export async function checkMandate(
  db: D1Database,
  mandateId: string,
  check: MandateCheck = {},
  now: string = nowISO()
): Promise<MandateCheckResult> {
  try {
    await assertMandateValid(db, mandateId, check, now);
    return { ok: true };
  } catch (e) {
    if (e instanceof DomainError && MANDATE_REASON_CODES.has(e.reason_code)) {
      return { ok: false, reason_code: e.reason_code, message: e.message };
    }
    throw e;
  }
}
