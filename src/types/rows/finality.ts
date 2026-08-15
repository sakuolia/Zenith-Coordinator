/**
 * @file rows/finality.ts — FinalityLog and transparency-anchor row types.
 * @module types/rows/finality
 */

/** FinalityLog table: Immutable audit trail of every state transition and event. */
export interface FinalityLogRow {
  log_id: string;
  txid: string | null;
  gtid: string | null;
  event_type: string;
  state_from: string | null;
  state_to: string;
  payload_json: string;
  event_seq: number;
  occurred_at: string;
}

/**
 * FinalityAnchor table: a periodic snapshot of every FinalityLog chain's tip
 * hash, fixed at an `event_seq` high-water mark.
 */
export interface FinalityAnchorRow {
  anchor_id: string;
  anchor_seq: number;
  high_watermark_seq: number;
  /** JSON array of `{chain_id, tip_hash}`, sorted by `chain_id`. */
  chain_tips_json: string;
  root_hash: string;
  created_at: string;
}

/**
 * FinalityCosign table: a participant's signed co-signature over the current
 * tip hash of a FinalityLog chain (txid) they are a party to.
 */
export interface FinalityCosignRow {
  cosign_id: string;
  chain_id: string;
  participant_id: string;
  entry_hash: string;
  signer_key_id: string;
  signature: string;
  nonce: string;
  occurred_at: string;
  created_at: string;
  /** TX|GTID|DNS|ANCHOR — which kind of chain this co-signature targets. */
  chain_kind: string | null;
}

/** CosignPolicy row — per chain-kind co-signing requirement. */
export interface CosignPolicyRow {
  chain_kind: string;
  min_cosigners: number;
  is_mandatory: number;
  updated_at: string;
}
