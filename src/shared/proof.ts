/**
 * @file Bank proof reference generation for audit trails.
 *
 * Every fund reservation or credit operation produces a `BankProofRef`
 * (the "a" or "b" proof) that links a bank-side journal entry to the
 * ZC transaction. These proofs are stored in the Transactions table and
 * returned in API responses for reconciliation.
 *
 * @module shared/proof
 */
import type {
  BankProofRef,
  ProofType,
  ProofVenue,
  CustodyDetail,
  SettlementProofRef,
} from "../types";
import { nowISO } from "../types";
import { sha256hex } from "./hmac";
import { newUUID } from "./idempotency";
import { DomainError } from "./errors";
import { verifyExternalSignature, type VerifyExternalSignatureParams } from "./external_signature";

/**
 * Create a new `BankProofRef` with a unique proof ID and timestamp.
 *
 * A content digest is computed (SHA-256 over key fields) for audit
 * purposes, though the digest itself is not stored in the proof object.
 *
 * @param issuerBankId - Bank ID that issued this proof (e.g. "001")
 * @param proofType    - Phase of the proof: "a" (reserve) or "b" (credit)
 * @param txid         - Associated transaction ID
 * @param amount       - Transaction amount
 * @param custodyDetail - Optional custody/suspense account details
 * @returns A fully populated BankProofRef
 */
export async function createProof(
  issuerBankId: string,
  proofType: ProofType,
  txid: string,
  amount: number,
  custodyDetail?: CustodyDetail
): Promise<BankProofRef> {
  const proofId = `PROOF-${newUUID()}`;
  // Content digest of the voucher (for auditing)
  await sha256hex(`${issuerBankId}:${proofType}:${txid}:${amount}:${proofId}`);

  const proof: BankProofRef = {
    issuer_bank_id: issuerBankId,
    proof_type: proofType,
    proof_id: proofId,
    recorded_at: nowISO(),
  };
  if (custodyDetail) {
    proof.custody_detail = custodyDetail;
  }
  return proof;
}

/**
 * Create a `SettlementProofRef` for a non-`BANK_LEDGER` venue (IGS/onchain/
 * third-party attestation).
 *
 * The proof is only minted once the accompanying signature has been verified
 * against `KeyRegistry` (docs/specs/31_schema.md § KeyRegistry) — `verifyExternalSignature` throws a
 * `DomainError` (`KEY_NOT_FOUND` / `KEY_EXPIRED` / `KEY_REVOKED` /
 * `EXTERNAL_SIGNATURE_INVALID` / `SIGNATURE_REPLAYED` / `TIMESTAMP_SKEW`) on
 * any failure, so a `SettlementProofRef` cannot exist without a verified
 * external signature.
 *
 * @param db          - D1 database binding (for KeyRegistry lookup + nonce claim)
 * @param issuerRef   - Identifier of the external proof issuer (bank_id / IGS / Watcher owner_ref)
 * @param proofType   - Phase of the proof: "a" (reserve) or "b" (credit)
 * @param venue       - Origin of the proof ("IGS_BOJ" | "ONCHAIN" | "ATTESTATION")
 * @param externalRef - Reference within `venue` (chain tx hash / IGS-ID / attestation ID)
 * @param signature   - External signature to verify (key_id, nonce, occurred_at, signature, payload — payload should include the txid)
 * @returns A `SettlementProofRef` with `venue`/`external_ref`/`signer_key_id`/`verified_at` populated
 */
export async function createSettlementProof(
  db: D1Database,
  issuerRef: string,
  proofType: ProofType,
  venue: Exclude<ProofVenue, "BANK_LEDGER">,
  externalRef: string,
  signature: VerifyExternalSignatureParams
): Promise<SettlementProofRef> {
  const key = await verifyExternalSignature(db, signature);

  return {
    issuer_bank_id: issuerRef,
    proof_type: proofType,
    proof_id: `PROOF-${newUUID()}`,
    recorded_at: nowISO(),
    venue,
    external_ref: externalRef,
    signer_key_id: key.key_id,
    verified_at: nowISO(),
  };
}

/**
 * Theme I (マネー非搭載・ファイナリティ外部依存): assert that `proof` is an
 * externally-trusted `SettlementProofRef`
 * before it is accepted as the basis for a "b" (finality) transition such as
 * DECIDED_TO_SETTLE / PAYEE_EXEC_CONFIRMED.
 *
 * "Trusted" means the proof was minted via `createSettlementProof()` /
 * `recordWatcherObservation()` — i.e. it carries `venue`, `signer_key_id`,
 * and `verified_at`, all populated only after `verifyExternalSignature()`
 * succeeded against `KeyRegistry` (docs/specs/31_schema.md § KeyRegistry). A proof missing these fields
 * (e.g. one wholly fabricated by request payload rather than produced by
 * this module) is rejected with `PROOF_SOURCE_UNTRUSTED` — defense in depth
 * on top of the signature verification already performed at mint time.
 *
 * `venue === "BANK_LEDGER"` proofs (the existing `BankProofRef` shape, no
 * `venue`/`signer_key_id`/`verified_at`) are always trusted: they originate
 * from ZC's own bank-ledger call hub, not an external signer.
 */
export function assertTrustedSettlementProof(proof: BankProofRef | SettlementProofRef): void {
  const venue = (proof as SettlementProofRef).venue;
  if (venue === undefined || venue === "BANK_LEDGER") return;

  const { signer_key_id, verified_at } = proof as SettlementProofRef;
  if (!signer_key_id || !verified_at) {
    throw new DomainError(
      "PROOF_SOURCE_UNTRUSTED",
      `SettlementProofRef (venue=${venue}) is missing signer_key_id/verified_at — not minted via a verified external signature`,
      { proof_id: proof.proof_id, venue }
    );
  }
}

/**
 * Generate a decision proof reference for ZC state finalization.
 *
 * @returns A `DP-{uuid}` formatted reference string
 */
export function newDecisionProofRef(): string {
  return `DP-${newUUID()}`;
}

/**
 * Generate a finality log reference for settlement completion.
 *
 * @returns A `FL-{uuid}` formatted reference string
 */
export function newFinalityLogRef(): string {
  return `FL-${newUUID()}`;
}

/**
 * Serialize a BankProofRef to a JSON string for DB storage.
 *
 * @param proof - The proof reference to serialize
 * @returns JSON string representation
 */
export function serializeProof(proof: BankProofRef): string {
  return JSON.stringify(proof);
}

/**
 * Deserialize a BankProofRef from a JSON string.
 *
 * @param json - JSON string (or null) from D1
 * @returns Parsed BankProofRef, or null on invalid/missing input
 */
export function deserializeProof(json: string | null): BankProofRef | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as BankProofRef;
  } catch {
    return null;
  }
}
