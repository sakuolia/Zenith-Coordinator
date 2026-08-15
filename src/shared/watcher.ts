/**
 * @file Watcher observation recording.
 *
 * The `Watcher` is the component that observes external-rail final events
 * (onchain transfers, IGS/BOJ confirmations, third-party attestations) and
 * turns them into `SettlementProofRef`s (§1 P1) that ZC ingress can accept.
 * ZC core never observes external rails directly — it only trusts
 * Watcher-signed observations verified against `KeyRegistry` (docs/specs/31_schema.md § KeyRegistry), where
 * the Watcher is registered with `owner_type` `'EXTERNAL_RAIL'` or
 * `'ATTESTER'`.
 *
 * Watchers may be redundant, and that redundancy is the basis of an n-of-m
 * quorum: multiple DISTINCT Watcher operators can independently attest the same
 * external event, each recording one vote. `(source, external_ref,
 * watcher_key_id)` is the idempotency key — a repeated observation by the SAME
 * Watcher dedups (returns its existing record without re-verifying), while a
 * different Watcher's observation is verified and recorded as an additional
 * vote. {@link countDistinctWatchers} counts the distinct *operators*
 * (KeyRegistry.owner_ref, not key_id, so one operator cannot fake a quorum with
 * several keys) that have attested an event; callers gate settlement on it.
 *
 * @module shared/watcher
 */
import type { ProofType, ProofVenue, SettlementProofRef, WatcherObservationRow } from "../types";
import { nowISO } from "../types";
import { DomainError } from "./errors";
import { newUUID } from "./idempotency";
import { verifyExternalSignature, type VerifyExternalSignatureParams } from "./external_signature";

export interface RecordWatcherObservationParams {
  /** Rail/watcher identifier, e.g. `'ONCHAIN:ETH'`, `'IGS_BOJ'`. */
  source: string;
  /** Reference within `source` (chain tx hash / IGS confirmation id / attestation id). */
  externalRef: string;
  venue: Exclude<ProofVenue, "BANK_LEDGER">;
  proofType: ProofType;
  /** Carried into the resulting `SettlementProofRef.issuer_bank_id`. */
  issuerRef: string;
  /** `KeyRegistry.key_id` of the observing Watcher (`owner_type` 'EXTERNAL_RAIL'|'ATTESTER'). */
  watcherKeyId: string;
  nonce: string;
  /** RFC3339 timestamp claimed by the Watcher for this observation. */
  occurredAt: string;
  /** Base64 signature over `buildWatcherObservationPayload(params)`. */
  signatureB64: string;
  /**
   * Theme A confirmation depth: depth the Watcher attests for
   * this observation. Signed when present; omitted observations keep the
   * legacy payload shape (treated as 0 downstream).
   */
  confirmations?: number;
}

/** The canonical payload a Watcher signs to attest an observed external event. */
export function buildWatcherObservationPayload(params: {
  source: string;
  externalRef: string;
  venue: Exclude<ProofVenue, "BANK_LEDGER">;
  proofType: ProofType;
  issuerRef: string;
  confirmations?: number;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    source: params.source,
    external_ref: params.externalRef,
    venue: params.venue,
    proof_type: params.proofType,
    issuer_ref: params.issuerRef,
  };
  // Backward compatible: only signed/included when the Watcher supplies it, so
  // existing observations (no confirmations) keep their exact signed payload.
  if (params.confirmations !== undefined) payload.confirmations = params.confirmations;
  return payload;
}

export interface RecordWatcherObservationResult {
  observation: WatcherObservationRow;
  proofRef: SettlementProofRef;
  /** `true` if this `(source, external_ref, watcher_key_id)` was already recorded (no new row written). */
  deduped: boolean;
  /**
   * Distinct Watcher *operators* (KeyRegistry.owner_ref) that have now attested
   * `(source, external_ref)`, including this one. Callers compare it against the
   * required quorum before treating the event as final.
   */
  distinctWatchers: number;
}

/**
 * Count the distinct Watcher *operators* (KeyRegistry.owner_ref) that have
 * attested an external event. Counting owner_ref rather than key_id means a
 * single operator holding several keys still counts once — it cannot
 * manufacture a quorum on its own.
 */
export async function countDistinctWatchers(
  db: D1Database,
  source: string,
  externalRef: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT k.owner_ref) AS n
         FROM WatcherObservation o
         JOIN KeyRegistry k ON k.key_id = o.watcher_key_id
        WHERE o.source = ? AND o.external_ref = ?`
    )
    .bind(source, externalRef)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The confirmation depth an external event can be treated at, taken as the
 * **minimum across distinct Watcher operators**. A single Watcher can no longer
 * unblock a reorg-depth gate by inflating its own `confirmations`: the event is
 * only as deep as the *shallowest* independent observer reports. Per operator we
 * take their deepest attestation (`MAX`), then the most conservative operator
 * (`MIN`) across operators. Missing/NULL confirmations count as 0. Returns 0
 * when no operator has attested yet.
 */
export async function minConfirmationsAcrossWatchers(
  db: D1Database,
  source: string,
  externalRef: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MIN(c) AS m FROM (
         SELECT COALESCE(MAX(o.confirmations), 0) AS c
           FROM WatcherObservation o
           JOIN KeyRegistry k ON k.key_id = o.watcher_key_id
          WHERE o.source = ? AND o.external_ref = ?
          GROUP BY k.owner_ref
       )`
    )
    .bind(source, externalRef)
    .first<{ m: number | null }>();
  return row?.m ?? 0;
}

/**
 * Record a Watcher's signed observation of an external-rail final event and
 * mint the corresponding `SettlementProofRef`.
 *
 * 1. If `(source, external_ref)` was already observed, return the existing
 *    record (`deduped: true`) without re-verifying the signature — redundant
 *    Watchers reporting the same event is expected, not an error.
 * 2. Otherwise verify the Watcher's signature against `KeyRegistry` (§K):
 *    `KEY_NOT_FOUND` / `KEY_EXPIRED` / `KEY_REVOKED` /
 *    `EXTERNAL_SIGNATURE_INVALID` / `SIGNATURE_REPLAYED` / `TIMESTAMP_SKEW`.
 * 3. The verified key's `owner_type` must be `'EXTERNAL_RAIL'` or
 *    `'ATTESTER'` (`WATCHER_UNAUTHORIZED` otherwise).
 * 4. Persist the observation and the minted `SettlementProofRef`.
 */
export async function recordWatcherObservation(
  db: D1Database,
  params: RecordWatcherObservationParams
): Promise<RecordWatcherObservationResult> {
  const existing = await db
    .prepare(
      `SELECT * FROM WatcherObservation WHERE source = ? AND external_ref = ? AND watcher_key_id = ?`
    )
    .bind(params.source, params.externalRef, params.watcherKeyId)
    .first<WatcherObservationRow>();
  if (existing) {
    return {
      observation: existing,
      proofRef: JSON.parse(existing.proof_ref) as SettlementProofRef,
      deduped: true,
      distinctWatchers: await countDistinctWatchers(db, params.source, params.externalRef),
    };
  }

  const payload = buildWatcherObservationPayload({
    source: params.source,
    externalRef: params.externalRef,
    venue: params.venue,
    proofType: params.proofType,
    issuerRef: params.issuerRef,
    confirmations: params.confirmations,
  });
  const signature: VerifyExternalSignatureParams = {
    keyId: params.watcherKeyId,
    nonce: params.nonce,
    occurredAt: params.occurredAt,
    signatureB64: params.signatureB64,
    payload,
  };
  const key = await verifyExternalSignature(db, signature);

  if (key.owner_type !== "EXTERNAL_RAIL" && key.owner_type !== "ATTESTER") {
    throw new DomainError(
      "WATCHER_UNAUTHORIZED",
      `Key ${key.key_id} (owner_type=${key.owner_type}) is not a registered Watcher`,
      {
        key_id: key.key_id,
        owner_type: key.owner_type,
      }
    );
  }

  // Equivocation guard (trust minimization): an n-of-m quorum only means
  // anything if the distinct Watchers attest the *same* event. Two authenticated
  // Watchers reporting the same `(source, external_ref)` with a different
  // `proof_type` or `venue` contradict each other about what happened on the
  // rail — counting both toward a quorum would let disagreement masquerade as
  // agreement. We reject the conflicting vote (it is never recorded, so it
  // cannot pad the count) and surface it so the caller converges it into a CASE.
  // `confirmations` is deliberately NOT an equivocation trigger: honest Watchers
  // observing at different times legitimately report different depths, handled
  // conservatively by {@link minConfirmationsAcrossWatchers}.
  const conflict = await db
    .prepare(
      `SELECT watcher_key_id, proof_type, venue FROM WatcherObservation
        WHERE source = ? AND external_ref = ? AND (proof_type != ? OR venue != ?)
        LIMIT 1`
    )
    .bind(params.source, params.externalRef, params.proofType, params.venue)
    .first<{ watcher_key_id: string; proof_type: string; venue: string }>();
  if (conflict) {
    throw new DomainError(
      "WATCHER_EQUIVOCATION",
      `Watcher ${key.key_id} attests (${params.venue}/${params.proofType}) for ${params.source}:${params.externalRef}, ` +
        `conflicting with existing observation by ${conflict.watcher_key_id} (${conflict.venue}/${conflict.proof_type})`,
      {
        source: params.source,
        external_ref: params.externalRef,
        incoming_key_id: key.key_id,
        incoming_proof_type: params.proofType,
        incoming_venue: params.venue,
        existing_key_id: conflict.watcher_key_id,
        existing_proof_type: conflict.proof_type,
        existing_venue: conflict.venue,
      }
    );
  }

  const proofRef: SettlementProofRef = {
    issuer_bank_id: params.issuerRef,
    proof_type: params.proofType,
    proof_id: `PROOF-${newUUID()}`,
    recorded_at: nowISO(),
    venue: params.venue,
    external_ref: params.externalRef,
    signer_key_id: key.key_id,
    verified_at: nowISO(),
  };

  const row: WatcherObservationRow = {
    observation_id: `WOBS-${newUUID()}`,
    source: params.source,
    external_ref: params.externalRef,
    venue: params.venue,
    proof_type: params.proofType,
    issuer_ref: params.issuerRef,
    watcher_key_id: params.watcherKeyId,
    signature: params.signatureB64,
    nonce: params.nonce,
    occurred_at: params.occurredAt,
    proof_ref: JSON.stringify(proofRef),
    confirmations: params.confirmations ?? null,
    created_at: nowISO(),
  };

  await db
    .prepare(
      `INSERT INTO WatcherObservation (observation_id, source, external_ref, venue, proof_type, issuer_ref, watcher_key_id, signature, nonce, occurred_at, proof_ref, confirmations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.observation_id,
      row.source,
      row.external_ref,
      row.venue,
      row.proof_type,
      row.issuer_ref,
      row.watcher_key_id,
      row.signature,
      row.nonce,
      row.occurred_at,
      row.proof_ref,
      row.confirmations,
      row.created_at
    )
    .run();

  return {
    observation: row,
    proofRef,
    deduped: false,
    distinctWatchers: await countDistinctWatchers(db, params.source, params.externalRef),
  };
}
