/**
 * @file finality_anchor.ts — Transparency anchoring + participant co-signing.
 *
 * ZC stays the single writer to FinalityLog; this module makes *verification*
 * multi-party (Certificate Transparency style) without introducing an external
 * consensus algorithm:
 *
 *  - `createFinalityAnchor()` periodically snapshots every chain's tip hash
 *    (`finality_chain.ts`) at an `event_seq` high-water mark into an
 *    append-only `FinalityAnchor` row. This is the "fixed, ZC-cannot-rewrite"
 *    reference point participants check against.
 *  - `verifyChainInclusion()` lets anyone recompute a chain's tip hash as of an
 *    anchor's watermark and confirm it matches what the anchor recorded — i.e.
 *    the chain was not silently rewritten after anchoring.
 *  - `recordFinalityCosign()` lets a participant bank that is a party to a
 *    transaction (payer or payee) co-sign its FinalityLog chain's current tip
 *    hash, verified against `KeyRegistry` (§K, `owner_type='PARTICIPANT'`).
 *
 * @module zc/finality_anchor
 */
import type { FinalityAnchorRow, FinalityCosignRow, CosignPolicyRow } from "../../types";
import { nowISO } from "../../types";
import { DomainError } from "../../shared/errors";
import { newUUID } from "../../shared/idempotency";
import { sha256hex } from "../../shared/hmac";
import {
  verifyExternalSignature,
  type VerifyExternalSignatureParams,
} from "../../shared/external_signature";
import { writeFinalityLog } from "../orchestrator";
import {
  getChainTipHash,
  getChainTipHashAsOf,
  isNonTxChainId,
  verifyChain,
  type ChainVerification,
  GENESIS_PREV_HASH,
  GLOBAL_CHAIN_ID,
} from "../finality/finality_chain";
import { listChainIds } from "../finality/finality_audit";

/** The kind of FinalityLog chain a co-signature targets. */
export type CosignChainKind = "TX" | "GTID" | "DNS";

/** Classify a chain id into its co-signable kind, or null if not co-signable. */
export function cosignChainKind(chainId: string): CosignChainKind | null {
  if (chainId.startsWith("TX-")) return "TX";
  if (chainId.startsWith("GT-") || chainId.startsWith("GTID-")) return "GTID";
  if (chainId.startsWith("DNS-")) return "DNS";
  return null;
}

/**
 * Resolve the set of participant bank_ids that are parties to a chain (and may
 * therefore co-sign it). TX ⇒ payer/payee; GTID ⇒ every leg bank; DNS ⇒ every
 * bank in the cycle's net positions. Empty set ⇒ unknown / no parties.
 */
async function chainParties(
  db: D1Database,
  chainId: string,
  kind: CosignChainKind
): Promise<Set<string>> {
  if (kind === "TX") {
    const tx = await db
      .prepare(`SELECT payer_bank_id, payee_bank_id FROM Transactions WHERE txid = ?`)
      .bind(chainId)
      .first<{ payer_bank_id: string; payee_bank_id: string }>();
    return tx ? new Set([tx.payer_bank_id, tx.payee_bank_id]) : new Set();
  }
  if (kind === "GTID") {
    const rows = await db
      .prepare(`SELECT DISTINCT bank_id FROM GtidLegs WHERE gtid = ?`)
      .bind(chainId)
      .all<{ bank_id: string }>();
    return new Set((rows.results ?? []).map((r) => r.bank_id));
  }
  // DNS
  const rows = await db
    .prepare(`SELECT DISTINCT bank_id FROM DnsNetPositions WHERE cycle_id = ?`)
    .bind(chainId)
    .all<{ bank_id: string }>();
  return new Set((rows.results ?? []).map((r) => r.bank_id));
}

export interface ChainTip {
  chain_id: string;
  tip_hash: string;
}

// ---------------------------------------------------------------------------
// Basis entry: what a co-signature is actually taken over.
// ---------------------------------------------------------------------------
/**
 * The FinalityLog `state_to` whose entry records a chain's point of
 * irreversibility, per chain kind. TX ⇒ b (`PAYEE_EXEC_CONFIRMED`);
 * GTID ⇒ `GT_SETTLED`; DNS ⇒ the cycle's `SETTLED` event.
 */
const COSIGN_BASIS_STATE: Record<CosignChainKind, string> = {
  TX: "PAYEE_EXEC_CONFIRMED",
  GTID: "GT_SETTLED",
  DNS: "SETTLED",
};

/** Where a chain's basis entry came from. */
export type CosignBasisKind = "IRREVERSIBILITY" | "ANCHOR";

export interface CosignBasis {
  chain_id: string;
  chain_kind: CosignChainKind;
  /** The hash the parties sign. Fixed: it does not move as the chain grows. */
  entry_hash: string;
  basis_kind: CosignBasisKind;
  /** `event_seq` of the basis entry, or the anchor's high watermark. */
  basis_seq: number;
  /** Set when `basis_kind === 'ANCHOR'`. */
  anchor_id: string | null;
}

/**
 * Resolve the **basis entry** of a chain — the entry a co-signature is taken
 * over. This must NOT be the chain's current tip.
 *
 * A quorum is "k distinct parties signed the same entry". The tip moves on every
 * ordinary business append, so a second party asked to sign "the tip" signs a
 * *different* hash and the count over any one hash can never exceed 1. Putting
 * the `FinalityCosigned` audit event on the GLOBAL chain (see
 * `recordFinalityCosign`) removes only the co-signing traffic from that drift;
 * ordinary settlement events still move the tip between two parties' signatures.
 * So the basis is pinned to an entry that is already written and never moves:
 *
 *   1. the entry recording this chain's point of irreversibility, if written; else
 *   2. the chain's tip as fixed by the most recent anchor (`FinalityAnchor`).
 *
 * A chain with neither has no stable basis yet — `COSIGN_BASIS_NOT_FOUND` rather
 * than a silent fall back to the tip, which would reintroduce the defect.
 */
export async function resolveCosignBasis(db: D1Database, chainId: string): Promise<CosignBasis> {
  const kind = cosignChainKind(chainId);
  if (chainId === GLOBAL_CHAIN_ID || !kind) {
    throw new DomainError(
      "COSIGN_NOT_APPLICABLE",
      `Co-signing is only defined for TX/GTID/DNS chains, got ${chainId}`,
      { chain_id: chainId }
    );
  }

  if ((await getChainTipHash(db, chainId)) === GENESIS_PREV_HASH) {
    throw new DomainError(
      "COSIGN_ENTRY_NOT_FOUND",
      `Chain ${chainId} has no FinalityLog entries to co-sign`,
      { chain_id: chainId }
    );
  }

  // 1. The irreversibility entry. Earliest match: b is recorded once, and if a
  //    later event repeated the state we would still want the original point.
  const column = isNonTxChainId(chainId) ? "gtid" : "txid";
  const point = await db
    .prepare(
      `SELECT entry_hash, event_seq FROM FinalityLog
       WHERE ${column} = ? AND state_to = ? AND entry_hash IS NOT NULL
       ORDER BY event_seq ASC LIMIT 1`
    )
    .bind(chainId, COSIGN_BASIS_STATE[kind])
    .first<{ entry_hash: string; event_seq: number }>();
  if (point) {
    return {
      chain_id: chainId,
      chain_kind: kind,
      entry_hash: point.entry_hash,
      basis_kind: "IRREVERSIBILITY",
      basis_seq: point.event_seq,
      anchor_id: null,
    };
  }

  // 2. The most recent anchor. `createFinalityAnchor` snapshots every chain that
  //    existed at that moment, so a chain missing from the latest anchor is one
  //    created after it — no fixed basis yet.
  const anchor = await db
    .prepare(
      `SELECT anchor_id, high_watermark_seq, chain_tips_json FROM FinalityAnchor
       ORDER BY anchor_seq DESC LIMIT 1`
    )
    .first<{ anchor_id: string; high_watermark_seq: number; chain_tips_json: string }>();
  if (anchor) {
    const tips = JSON.parse(anchor.chain_tips_json) as ChainTip[];
    const tip = tips.find((t) => t.chain_id === chainId);
    if (tip && tip.tip_hash !== GENESIS_PREV_HASH) {
      return {
        chain_id: chainId,
        chain_kind: kind,
        entry_hash: tip.tip_hash,
        basis_kind: "ANCHOR",
        basis_seq: anchor.high_watermark_seq,
        anchor_id: anchor.anchor_id,
      };
    }
  }

  throw new DomainError(
    "COSIGN_BASIS_NOT_FOUND",
    `Chain ${chainId} has no basis entry to co-sign yet: neither a ${COSIGN_BASIS_STATE[kind]} entry nor an anchor covering it`,
    { chain_id: chainId, chain_kind: kind }
  );
}

/**
 * Snapshot every FinalityLog chain's tip hash at the current `event_seq`
 * high-water mark and persist it as a new `FinalityAnchor` row.
 *
 * Returns `null` if FinalityLog is empty (nothing to anchor yet).
 */
export async function createFinalityAnchor(db: D1Database): Promise<FinalityAnchorRow | null> {
  const watermarkRow = await db
    .prepare(`SELECT MAX(event_seq) AS seq FROM FinalityLog`)
    .first<{ seq: number | null }>();
  const highWatermarkSeq = watermarkRow?.seq ?? null;
  if (highWatermarkSeq === null) {
    return null;
  }

  const chainIds = await listChainIds(db);
  const tips: ChainTip[] = [];
  for (const chainId of chainIds) {
    const tipHash = await getChainTipHashAsOf(db, chainId, highWatermarkSeq);
    tips.push({ chain_id: chainId, tip_hash: tipHash });
  }
  tips.sort((a, b) => a.chain_id.localeCompare(b.chain_id));

  const chainTipsJson = JSON.stringify(tips);
  const rootHash = await sha256hex(chainTipsJson);

  const seqRow = await db
    .prepare(`SELECT MAX(anchor_seq) AS seq FROM FinalityAnchor`)
    .first<{ seq: number | null }>();
  const anchorSeq = (seqRow?.seq ?? 0) + 1;

  const row: FinalityAnchorRow = {
    anchor_id: `ANCHOR-${newUUID()}`,
    anchor_seq: anchorSeq,
    high_watermark_seq: highWatermarkSeq,
    chain_tips_json: chainTipsJson,
    root_hash: rootHash,
    created_at: nowISO(),
  };

  await db
    .prepare(
      `INSERT INTO FinalityAnchor (anchor_id, anchor_seq, high_watermark_seq, chain_tips_json, root_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.anchor_id,
      row.anchor_seq,
      row.high_watermark_seq,
      row.chain_tips_json,
      row.root_hash,
      row.created_at
    )
    .run();

  return row;
}

export interface ChainInclusionResult {
  anchor_id: string;
  chain_id: string;
  /** Tip hash recorded in the anchor for this chain. */
  anchored_tip_hash: string;
  /** Tip hash recomputed now, as of the anchor's `high_watermark_seq`. */
  recomputed_tip_hash: string;
  /** `true` iff the chain has not been rewritten since anchoring. */
  included: boolean;
}

/**
 * Verify that `chainId`'s tip hash at the time of `anchorId` has not been
 * rewritten: recompute the chain's tip hash as of the anchor's
 * `high_watermark_seq` and compare it to what the anchor recorded.
 *
 * Throws `ANCHOR_NOT_FOUND` if `anchorId` does not exist, or
 * `CHAIN_NOT_ANCHORED` if `chainId` was not present in that anchor's snapshot
 * (e.g. the chain did not exist yet at anchor time).
 */
export async function verifyChainInclusion(
  db: D1Database,
  anchorId: string,
  chainId: string
): Promise<ChainInclusionResult> {
  const anchor = await db
    .prepare(`SELECT * FROM FinalityAnchor WHERE anchor_id = ?`)
    .bind(anchorId)
    .first<FinalityAnchorRow>();
  if (!anchor) {
    throw new DomainError("ANCHOR_NOT_FOUND", `FinalityAnchor not found: ${anchorId}`, {
      anchor_id: anchorId,
    });
  }

  const tips = JSON.parse(anchor.chain_tips_json) as ChainTip[];
  const tip = tips.find((t) => t.chain_id === chainId);
  if (!tip) {
    throw new DomainError(
      "CHAIN_NOT_ANCHORED",
      `Chain ${chainId} is not present in anchor ${anchorId}`,
      {
        anchor_id: anchorId,
        chain_id: chainId,
      }
    );
  }

  const recomputed = await getChainTipHashAsOf(db, chainId, anchor.high_watermark_seq);

  return {
    anchor_id: anchorId,
    chain_id: chainId,
    anchored_tip_hash: tip.tip_hash,
    recomputed_tip_hash: recomputed,
    included: recomputed === tip.tip_hash,
  };
}

export interface RecordFinalityCosignParams {
  /** FinalityLog chain id (txid) being co-signed. */
  chainId: string;
  /** bank_id of the co-signing participant. */
  participantId: string;
  /** `KeyRegistry.key_id` of the participant (owner_type='PARTICIPANT', owner_ref=participantId). */
  signerKeyId: string;
  nonce: string;
  occurredAt: string;
  /** Base64 signature over `buildFinalityCosignPayload({chain_id, entry_hash})`. */
  signatureB64: string;
}

/** The canonical payload a participant signs to co-sign a chain's basis entry. */
export function buildFinalityCosignPayload(params: {
  chainId: string;
  entryHash: string;
}): Record<string, unknown> {
  return { chain_id: params.chainId, entry_hash: params.entryHash };
}

/**
 * Record a participant's co-signature over the **basis entry** of `chainId`'s
 * FinalityLog hash chain (`resolveCosignBasis` — NOT the moving tip). Co-signing
 * extends to **TX, GTID, and DNS** chains (30_internal_design.md § 7): a participant
 * that is a party to the chain — payer/payee for TX, a leg bank for GTID, a
 * net-position bank for DNS — may co-sign it.
 *
 * 1. `chainId` must be a co-signable chain (`COSIGN_NOT_APPLICABLE` for the
 *    GLOBAL chain or an unrecognized prefix) where `participantId` is a party.
 * 2. The chain must have at least one FinalityLog entry (`COSIGN_ENTRY_NOT_FOUND`
 *    if the tip is still GENESIS) and a fixed basis entry
 *    (`COSIGN_BASIS_NOT_FOUND` otherwise).
 * 3. The signature over `{chain_id, entry_hash}` is verified against KeyRegistry
 *    (§K): `KEY_*` / `EXTERNAL_SIGNATURE_INVALID` / `SIGNATURE_REPLAYED` /
 *    `TIMESTAMP_SKEW`.
 * 4. The verified key must be `owner_type='PARTICIPANT'` with
 *    `owner_ref=participantId` (`COSIGN_PARTICIPANT_MISMATCH` otherwise).
 *
 * Re-cosigning the same `(chain_id, participant_id, entry_hash)` returns the
 * existing row idempotently. A first co-signature emits a `FinalityCosigned`
 * event onto the chain.
 */
export async function recordFinalityCosign(
  db: D1Database,
  params: RecordFinalityCosignParams
): Promise<FinalityCosignRow> {
  const kind = cosignChainKind(params.chainId);
  if (params.chainId === GLOBAL_CHAIN_ID || !kind) {
    throw new DomainError(
      "COSIGN_NOT_APPLICABLE",
      `Co-signing is only defined for TX/GTID/DNS chains, got ${params.chainId}`,
      {
        chain_id: params.chainId,
      }
    );
  }

  const parties = await chainParties(db, params.chainId, kind);
  if (!parties.has(params.participantId)) {
    throw new DomainError(
      "COSIGN_NOT_APPLICABLE",
      `Participant ${params.participantId} is not a party to ${params.chainId}`,
      {
        chain_id: params.chainId,
        participant_id: params.participantId,
      }
    );
  }

  const basis = await resolveCosignBasis(db, params.chainId);
  const entryHash = basis.entry_hash;

  const existing = await db
    .prepare(
      `SELECT * FROM FinalityCosign WHERE chain_id = ? AND participant_id = ? AND entry_hash = ?`
    )
    .bind(params.chainId, params.participantId, entryHash)
    .first<FinalityCosignRow>();
  if (existing) {
    return existing;
  }

  const payload = buildFinalityCosignPayload({ chainId: params.chainId, entryHash });
  const signature: VerifyExternalSignatureParams = {
    keyId: params.signerKeyId,
    nonce: params.nonce,
    occurredAt: params.occurredAt,
    signatureB64: params.signatureB64,
    payload,
  };
  const key = await verifyExternalSignature(db, signature);

  if (key.owner_type !== "PARTICIPANT" || key.owner_ref !== params.participantId) {
    throw new DomainError(
      "COSIGN_PARTICIPANT_MISMATCH",
      `Key ${key.key_id} (owner_type=${key.owner_type}, owner_ref=${key.owner_ref}) does not represent participant ${params.participantId}`,
      {
        key_id: key.key_id,
        owner_type: key.owner_type,
        owner_ref: key.owner_ref,
        participant_id: params.participantId,
      }
    );
  }

  const row: FinalityCosignRow = {
    cosign_id: `COSIGN-${newUUID()}`,
    chain_id: params.chainId,
    participant_id: params.participantId,
    entry_hash: entryHash,
    signer_key_id: params.signerKeyId,
    signature: params.signatureB64,
    nonce: params.nonce,
    occurred_at: params.occurredAt,
    created_at: nowISO(),
    chain_kind: kind,
  };

  await db
    .prepare(
      `INSERT INTO FinalityCosign (cosign_id, chain_id, participant_id, entry_hash, signer_key_id, signature, nonce, occurred_at, created_at, chain_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.cosign_id,
      row.chain_id,
      row.participant_id,
      row.entry_hash,
      row.signer_key_id,
      row.signature,
      row.nonce,
      row.occurred_at,
      row.created_at,
      row.chain_kind
    )
    .run();

  // Emit the audit event onto the GLOBAL chain, NOT the co-signed chain: appending
  // it to the co-signed chain would shift that chain's tip hash. That is one of the
  // two ways the signed hash could drift out from under a quorum; the other —
  // ordinary business appends — is handled by signing a fixed basis entry rather
  // than the tip (`resolveCosignBasis`). Both are needed: removing only the
  // co-signing traffic still leaves settlement events moving the tip. The
  // FinalityCosign row is the system of record; this event is cross-cutting
  // transparency.
  await writeFinalityLog(db, {
    txid: null,
    event_type: "FinalityCosigned",
    state_from: null,
    state_to: "COSIGNED",
    payload_json: JSON.stringify({
      chain_id: params.chainId,
      chain_kind: kind,
      participant_id: params.participantId,
      entry_hash: entryHash,
      basis_kind: basis.basis_kind,
      basis_seq: basis.basis_seq,
      anchor_id: basis.anchor_id,
    }),
    txid_or_gtid: null,
  });

  return row;
}

// ---------------------------------------------------------------------------
// Mandatory co-sign policy (per chain kind).
// ---------------------------------------------------------------------------

/** Set (or clear) the co-sign requirement for a chain kind. */
export async function setCosignPolicy(
  db: D1Database,
  chainKind: CosignChainKind,
  policy: { minCosigners: number; isMandatory: boolean }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO CosignPolicy (chain_kind, min_cosigners, is_mandatory, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_kind) DO UPDATE SET
         min_cosigners = excluded.min_cosigners,
         is_mandatory  = excluded.is_mandatory,
         updated_at    = excluded.updated_at`
    )
    .bind(chainKind, Math.max(1, policy.minCosigners), policy.isMandatory ? 1 : 0, nowISO())
    .run();
}

/** Read the co-sign policy for a chain kind (null = no policy / not mandatory). */
export async function getCosignPolicy(
  db: D1Database,
  chainKind: CosignChainKind
): Promise<CosignPolicyRow | null> {
  return db
    .prepare(`SELECT * FROM CosignPolicy WHERE chain_kind = ?`)
    .bind(chainKind)
    .first<CosignPolicyRow>();
}

export interface CosignRequirementResult {
  chain_id: string;
  chain_kind: CosignChainKind | null;
  required: boolean;
  min_cosigners: number;
  cosign_count: number;
  satisfied: boolean;
  /** Which entry the count is taken over, and where it came from. */
  basis_kind: CosignBasisKind | null;
  basis_entry_hash: string | null;
}

/**
 * Evaluate whether a chain meets its mandatory co-sign requirement. A chain whose
 * kind has `is_mandatory=1` is satisfied only when at least `min_cosigners`
 * distinct participants have co-signed its **basis entry** (`resolveCosignBasis`).
 * A non-mandatory (or unclassified) chain is trivially satisfied. This is the
 * enforceable hook for "副署の必須化"; callers gate external-verification claims
 * on `satisfied`.
 *
 * Counting over the basis entry rather than the tip is what makes a quorum of 2+
 * reachable, and it also makes `satisfied` monotonic: once k parties have signed
 * the fixed basis, later appends to the chain cannot take the count back to 0.
 * A chain with no basis entry yet counts 0 (and so is unsatisfied when required)
 * rather than throwing — `/verify` must stay answerable for any chain.
 */
export async function checkCosignRequirement(
  db: D1Database,
  chainId: string
): Promise<CosignRequirementResult> {
  const kind = cosignChainKind(chainId);
  if (!kind) {
    return {
      chain_id: chainId,
      chain_kind: null,
      required: false,
      min_cosigners: 0,
      cosign_count: 0,
      satisfied: true,
      basis_kind: null,
      basis_entry_hash: null,
    };
  }
  const policy = await getCosignPolicy(db, kind);
  const required = !!policy && policy.is_mandatory === 1;
  const minCosigners = policy?.min_cosigners ?? 0;

  let basis: CosignBasis | null = null;
  try {
    basis = await resolveCosignBasis(db, chainId);
  } catch {
    basis = null;
  }

  let cosignCount = 0;
  if (basis) {
    const countRow = await db
      .prepare(
        `SELECT COUNT(DISTINCT participant_id) AS n FROM FinalityCosign WHERE chain_id = ? AND entry_hash = ?`
      )
      .bind(chainId, basis.entry_hash)
      .first<{ n: number }>();
    cosignCount = countRow?.n ?? 0;
  }

  return {
    chain_id: chainId,
    chain_kind: kind,
    required,
    min_cosigners: minCosigners,
    cosign_count: cosignCount,
    satisfied: !required || cosignCount >= minCosigners,
    basis_kind: basis?.basis_kind ?? null,
    basis_entry_hash: basis?.entry_hash ?? null,
  };
}

export interface ChainVerificationWithCosign extends ChainVerification {
  cosign: CosignRequirementResult;
  /**
   * The chain is final *and externally verifiable*: its hash chain is intact
   * (`valid`) AND its mandatory co-sign policy is met (`cosign.satisfied`). This
   * is the live enforcement of "副署の必須化" — a verifier asking whether a
   * settlement is externally final gets `false` until the required distinct
   * participants have co-signed the current tip.
   */
  finality_confirmed: boolean;
}

/**
 * Verify a chain's hash integrity *and* its mandatory co-sign requirement in
 * one call. Powers the `/verify` endpoints so an external verification claim is
 * only affirmative once both hold. Co-signing does not perturb the chain tip
 * (the `FinalityCosigned` audit event lands on GLOBAL), so a chain can be both
 * `valid` and awaiting co-signatures.
 */
export async function verifyChainWithCosign(
  db: D1Database,
  chainId: string
): Promise<ChainVerificationWithCosign> {
  const verification = await verifyChain(db, chainId);
  const cosign = await checkCosignRequirement(db, chainId);
  return { ...verification, cosign, finality_confirmed: verification.valid && cosign.satisfied };
}
