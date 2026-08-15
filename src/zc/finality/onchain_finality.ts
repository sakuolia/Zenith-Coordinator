/**
 * @file onchain_finality.ts — Cross-chain finality classification + quantum-risk
 *       metadata for cross-chain HTLCs (30_internal_design.md § 7 "オンチェーン接続").
 *
 * A cross-chain HTLC's onchain leg settles on some external rail. How a ZC should
 * treat a confirmation there depends on the rail's finality model:
 *
 *   - PUBLIC chains (e.g. a public PoW/PoS L1) have **probabilistic** finality:
 *     a recently-confirmed block can still be reorged, so confirmation *depth*
 *     matters and a deeper gate is required before a release is irreversible.
 *   - PRIVATE / PERMISSIONED chains (e.g. a consortium ledger with BFT finality)
 *     have **deterministic** finality: one confirmation is final, so the depth
 *     gate can be minimal.
 *
 * Separately, the onchain proof's signature suite carries a **quantum-risk**
 * classification so a quantum-vulnerable lock (e.g. secp256k1/ed25519) is
 * auditable as evidence metadata, distinct from a PQ-resistant one.
 *
 * This module is pure classification; the confirmation gate itself lives in the
 * cross-chain fulfilment path (htlc.ts#recordOnchainFulfillment).
 *
 * @module zc/onchain_finality
 */

export type ChainClass = "PUBLIC" | "PRIVATE" | "PERMISSIONED";
export type FinalityClass = "PROBABILISTIC" | "DETERMINISTIC";
export type QuantumRisk = "VULNERABLE" | "RESISTANT" | "UNKNOWN";

/** Map a chain class to its finality model. PUBLIC ⇒ probabilistic; else deterministic. */
export function classifyFinality(chainClass: ChainClass): FinalityClass {
  return chainClass === "PUBLIC" ? "PROBABILISTIC" : "DETERMINISTIC";
}

/** Known post-quantum-resistant signature suites (lower-cased prefixes). */
const PQ_RESISTANT = ["dilithium", "falcon", "sphincs", "kyber", "mldsa", "ml-dsa", "slh-dsa"];
/** Classical suites known to be broken by a CRQC (Shor). */
const QUANTUM_VULNERABLE = [
  "secp256k1",
  "secp256r1",
  "ed25519",
  "ecdsa",
  "rsa",
  "bls12-381",
  "bls",
];

/**
 * Classify a signature suite's exposure to a cryptographically-relevant quantum
 * computer. Unknown suites are UNKNOWN (not silently treated as safe).
 */
export function classifyQuantumRisk(cryptoSuite: string): QuantumRisk {
  const s = cryptoSuite.trim().toLowerCase();
  if (PQ_RESISTANT.some((p) => s.startsWith(p) || s.includes(p))) return "RESISTANT";
  if (QUANTUM_VULNERABLE.some((p) => s.startsWith(p) || s.includes(p))) return "VULNERABLE";
  return "UNKNOWN";
}

/**
 * The effective confirmation depth required before an onchain release may be
 * treated as final, given the chain's finality model and the HTLC's configured
 * minimum:
 *   - DETERMINISTIC (private/permissioned): one block is final, so cap the gate
 *     at 1 — but never introduce a gate the operator did not ask for (0 ⇒ 0).
 *   - PROBABILISTIC / unclassified (public): honour the configured depth as-is.
 */
export function requiredConfirmations(
  finalityClass: FinalityClass | null,
  configuredMin: number
): number {
  if (finalityClass === "DETERMINISTIC") return configuredMin > 0 ? 1 : 0;
  return configuredMin;
}
