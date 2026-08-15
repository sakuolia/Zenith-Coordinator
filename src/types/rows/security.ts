/**
 * @file rows/security.ts — cryptographic / authority row types (key registry,
 *       condition templates, attestations, mandates, watcher observations).
 * @module types/rows/security
 */
import type { ProofType, ProofVenue } from "../primitives";

/**
 * KeyRegistry table: verification-only public keys for parties other than ZC
 * (participants, attesters, agents, external rails / Watchers). ZC holds the
 * public key only — never a private key for an external owner.
 */
export interface KeyRegistryRow {
  key_id: string;
  owner_type: KeyOwnerType;
  owner_ref: string;
  public_key: string;
  algo: KeyAlgo;
  valid_from: string;
  valid_to: string | null;
  revoked_at: string | null;
  status: KeyStatus;
  created_at: string;
}

// 'ZC' identifies the coordinator's OWN egress signing key(s): unlike the other
// owner types (external parties ZC verifies), a 'ZC' key is one ZC signs with and
// participants verify. Registered/rotated under the same KeyRegistry governance
// (10_requirements.md §3.4).
export type KeyOwnerType = "PARTICIPANT" | "ATTESTER" | "AGENT" | "EXTERNAL_RAIL" | "ZC";
export type KeyAlgo = "ECDSA_P256" | "ED25519";
export type KeyStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

/**
 * ConditionTemplate table: whitelist of condition types ("predicates") that
 * external attesters may attest against. Same governance posture as
 * HtlcAuthWhitelist.
 */
export interface ConditionTemplateRow {
  template_id: string;
  predicate_kind: string;
  /** JSON: {key_ids?: string[], owner_refs?: string[], owner_types?: KeyOwnerType[]} */
  allowed_attester_scope: string;
  status: ConditionTemplateStatus;
  description: string | null;
  registered_at: string;
  /**
   * Distinct attester operators (KeyRegistry.owner_ref) required for this
   * template's Attestations to satisfy a condition leaf. 1 = single-attester
   * (legacy). Mirrors HtlcContracts.onchain_min_watchers.
   */
  min_attester_quorum: number;
  /**
   * When non-NULL, this template is resolved by ZC against its own committed
   * FinalityLog (a `LedgerPredicate`, see zc/platform/ledger_predicate.ts)
   * rather than by an external attester.
   */
  ledger_predicate_json: string | null;
}

export type ConditionTemplateStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

/**
 * Attestation table: a signed "condition satisfied" statement from an
 * external attester. ZC stores only `statement_hash` and `verified_result`,
 * never the statement payload itself.
 */
export interface AttestationRow {
  attestation_id: string;
  template_id: string;
  subject_ref: string;
  attester_key_id: string;
  statement_hash: string;
  signature: string;
  nonce: string;
  occurred_at: string;
  verified_result: AttestationResult;
  created_at: string;
}

export type AttestationResult = "PASS" | "FAIL";

/**
 * Mandate table: "on whose authority was this instruction issued", as a
 * first-class, chainable delegation entity. `allowed_purposes`/`allowed_lanes`
 * are JSON arrays (or NULL = unrestricted at this link of the chain).
 */
export interface MandateRow {
  mandate_id: string;
  principal_participant_id: string;
  grantee_ref: string;
  parent_mandate_id: string | null;
  max_amount: number | null;
  allowed_purposes: string | null;
  allowed_lanes: string | null;
  valid_from: string;
  valid_to: string;
  principal_key_id: string;
  signature: string;
  nonce: string;
  occurred_at: string;
  revoked_at: string | null;
  created_at: string;
}

/**
 * WatcherObservation table: a signed "external rail final event" observation
 * from a Watcher (KeyRegistry owner_type 'EXTERNAL_RAIL'|'ATTESTER'), and the
 * `SettlementProofRef` (JSON) minted from it. `(source, external_ref)` is unique:
 * redundant Watchers reporting the same external event are deduplicated.
 */
export interface WatcherObservationRow {
  observation_id: string;
  source: string;
  external_ref: string;
  venue: ProofVenue;
  proof_type: ProofType;
  issuer_ref: string;
  watcher_key_id: string;
  signature: string;
  nonce: string;
  occurred_at: string;
  /** JSON-serialized SettlementProofRef. */
  proof_ref: string;
  /** Confirmation depth the Watcher attested for this observation, or null. */
  confirmations: number | null;
  created_at: string;
}
