/**
 * @file Attestation recording — the "P2" generalization of HTLC's
 * preimage-presented-means-condition-satisfied model.
 *
 * ZC does not judge whether a condition was actually satisfied. It only
 * records, for a whitelisted `ConditionTemplate`, that a `KeyRegistry`-
 * registered attester signed a statement (identified by `statement_hash`)
 * with a `verified_result` of PASS/FAIL at a given `occurred_at`. The
 * statement payload itself is never stored — only its hash.
 *
 * @module shared/attestation
 */
import type {
  AttestationRow,
  AttestationResult,
  ConditionTemplateRow,
  KeyOwnerType,
  KeyRegistryRow,
} from "../types";
import { nowISO } from "../types";
import { DomainError } from "./errors";
import { newUUID } from "./idempotency";
import {
  buildSignedMessage,
  verifyExternalSignature,
  SIGNATURE_SKEW_MS,
} from "./external_signature";

/** Scope expression stored in `ConditionTemplate.allowed_attester_scope`. */
export interface AttesterScope {
  key_ids?: string[];
  owner_refs?: string[];
  owner_types?: KeyOwnerType[];
}

const STATEMENT_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Default attestation freshness window in seconds (60 minutes),
 * ("対象取引の終端＋60分", following the HTLC preimage retention norm).
 */
export const ATTESTATION_DEFAULT_TTL_SECONDS = 60 * 60;

/**
 * Outer signature-timestamp-skew bound used when recording an Attestation
 * (passed as `maxSkewMs` to `verifyExternalSignature`).
 *
 * This must stay *wider* than `ATTESTATION_DEFAULT_TTL_SECONDS`: the generic
 * trust-anchor layer's timestamp check (`assertTimestampFresh`, default
 * `SIGNATURE_SKEW_MS` = 5 minutes) is calibrated for payloads representing a
 * live action signed at call time. An Attestation is signed once by the
 * attester at `occurred_at` and is then expected to be relayed/submitted up
 * to `ATTESTATION_DEFAULT_TTL_SECONDS` later — that documented window is the
 * actual, business-meaningful freshness rule (enforced by
 * `assertAttestationFresh` / `ATTESTATION_EXPIRED`), not the generic 5-minute
 * one. If the generic check stayed at its tighter default, it would always
 * reject (with `TIMESTAMP_SKEW`) before the 60-minute rule ever got a chance
 * to apply, making `ATTESTATION_EXPIRED` unreachable. Widening it here turns
 * the generic check back into what it should be for this payload: an outer
 * sanity bound against grossly stale or clock-bogus timestamps, while
 * `assertAttestationFresh` remains the narrower, operative gate.
 */
export const ATTESTATION_SIGNATURE_SKEW_MS =
  ATTESTATION_DEFAULT_TTL_SECONDS * 1000 + SIGNATURE_SKEW_MS;

/** Whether `key` is permitted to attest under `scope`. Fails closed: an empty scope authorizes nobody. */
export function attesterInScope(key: KeyRegistryRow, scope: AttesterScope): boolean {
  if (scope.key_ids?.includes(key.key_id)) return true;
  if (scope.owner_refs?.includes(key.owner_ref)) return true;
  if (scope.owner_types?.includes(key.owner_type)) return true;
  return false;
}

export interface RecordAttestationParams {
  templateId: string;
  subjectRef: string;
  /** sha256 hex digest of the (off-ZC-held) statement payload. */
  statementHash: string;
  verifiedResult: AttestationResult;
  /** `KeyRegistry.key_id` of the claimed attester. */
  attesterKeyId: string;
  nonce: string;
  /** RFC3339 timestamp claimed by the attester. */
  occurredAt: string;
  /** Base64 signature over `{template_id, subject_ref, statement_hash, verified_result}`. */
  signatureB64: string;
}

/**
 * Verify and record an `Attestation`.
 *
 *  1. Look up `ConditionTemplate` (`TEMPLATE_NOT_WHITELISTED` if missing or not ACTIVE).
 *  2. Validate `statement_hash` is a sha256 hex digest (`ATTESTATION_INVALID`).
 *  3. Verify the attester's signature via `KeyRegistry` (§K reason codes), using
 *     the widened `ATTESTATION_SIGNATURE_SKEW_MS` outer bound rather than the
 *     generic 5-minute default — see that constant for why.
 *  4. Check the attester is within `allowed_attester_scope` (`ATTESTER_UNAUTHORIZED`).
 *  5. Insert the `Attestation` row.
 *
 * Callers that act on the returned row to satisfy a condition must still call
 * `assertAttestationFresh` themselves — recording an Attestation does not by
 * itself imply it is fresh enough to use (docs/specs/30_internal_design.md §11.2-b, 60 minutes).
 */
export async function recordAttestation(
  db: D1Database,
  params: RecordAttestationParams
): Promise<AttestationRow> {
  const template = await db
    .prepare(`SELECT * FROM ConditionTemplate WHERE template_id = ?`)
    .bind(params.templateId)
    .first<ConditionTemplateRow>();
  if (!template || template.status !== "ACTIVE") {
    throw new DomainError(
      "TEMPLATE_NOT_WHITELISTED",
      `ConditionTemplate not active: ${params.templateId}`,
      {
        template_id: params.templateId,
      }
    );
  }

  if (!STATEMENT_HASH_RE.test(params.statementHash)) {
    throw new DomainError("ATTESTATION_INVALID", `statement_hash is not a sha256 hex digest`, {
      statement_hash: params.statementHash,
    });
  }

  const payload = {
    template_id: params.templateId,
    subject_ref: params.subjectRef,
    statement_hash: params.statementHash,
    verified_result: params.verifiedResult,
  };
  const key = await verifyExternalSignature(db, {
    keyId: params.attesterKeyId,
    nonce: params.nonce,
    occurredAt: params.occurredAt,
    signatureB64: params.signatureB64,
    payload,
    maxSkewMs: ATTESTATION_SIGNATURE_SKEW_MS,
  });

  const scope = JSON.parse(template.allowed_attester_scope) as AttesterScope;
  if (!attesterInScope(key, scope)) {
    throw new DomainError(
      "ATTESTER_UNAUTHORIZED",
      `Key ${key.key_id} is not in scope for template ${params.templateId}`,
      {
        key_id: key.key_id,
        template_id: params.templateId,
      }
    );
  }

  const row: AttestationRow = {
    attestation_id: `ATT-${newUUID()}`,
    template_id: params.templateId,
    subject_ref: params.subjectRef,
    attester_key_id: params.attesterKeyId,
    statement_hash: params.statementHash,
    signature: params.signatureB64,
    nonce: params.nonce,
    occurred_at: params.occurredAt,
    verified_result: params.verifiedResult,
    created_at: nowISO(),
  };

  await db
    .prepare(
      `INSERT INTO Attestation (attestation_id, template_id, subject_ref, attester_key_id, statement_hash, signature, nonce, occurred_at, verified_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.attestation_id,
      row.template_id,
      row.subject_ref,
      row.attester_key_id,
      row.statement_hash,
      row.signature,
      row.nonce,
      row.occurred_at,
      row.verified_result,
      row.created_at
    )
    .run();

  return row;
}

/**
 * Assert that `attestation` is still within its freshness window as of `now`:
 * `occurred_at + ttlSeconds >= now`.
 *
 * Throws `ATTESTATION_EXPIRED` if the window has elapsed. Callers that act on
 * an `Attestation` to satisfy a condition (e.g. release a hold) should call
 * this first — the `Attestation` row itself is retained indefinitely as an
 * audit record regardless of freshness.
 */
export function assertAttestationFresh(
  attestation: AttestationRow,
  now: string = nowISO(),
  ttlSeconds: number = ATTESTATION_DEFAULT_TTL_SECONDS
): void {
  const occurredAtMs = Date.parse(attestation.occurred_at);
  const nowMs = Date.parse(now);
  const expiresAtMs = occurredAtMs + ttlSeconds * 1000;

  if (nowMs > expiresAtMs) {
    throw new DomainError(
      "ATTESTATION_EXPIRED",
      `Attestation ${attestation.attestation_id} expired at ${new Date(expiresAtMs).toISOString()} (occurred_at=${attestation.occurred_at}, ttl=${ttlSeconds}s)`,
      {
        attestation_id: attestation.attestation_id,
        occurred_at: attestation.occurred_at,
        ttl_seconds: ttlSeconds,
        now,
      }
    );
  }
}

/**
 * Re-export for callers that need to build the exact payload bytes an
 * attester must sign (e.g. test fixtures, off-ZC attester tooling).
 */
export function buildAttestationMessage(
  templateId: string,
  subjectRef: string,
  statementHash: string,
  verifiedResult: AttestationResult,
  attesterKeyId: string,
  nonce: string,
  occurredAt: string
): Uint8Array {
  return buildSignedMessage(
    {
      template_id: templateId,
      subject_ref: subjectRef,
      statement_hash: statementHash,
      verified_result: verifiedResult,
    },
    attesterKeyId,
    nonce,
    occurredAt
  );
}
