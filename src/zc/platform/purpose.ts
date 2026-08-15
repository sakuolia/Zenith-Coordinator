/**
 * @file Purpose codes (P01–P07) and real-time access blocking.
 *
 * docs/specs/10_requirements.md §3.3.2.2.1 requires every access to closed-domain data to
 * carry a *purpose code* naming why the data is being read, and §3.3.2.2.1.1-2
 * requires an access with no purpose code (or no approver) to be **blocked in
 * real time** and raise `DataAccessViolationDetected` — not merely logged for a
 * later review.
 *
 * This module holds the small, shared half of that: the closed code set and the
 * violation record. The full Access Audit Log of §3.3.2.2.1.1-1 (every access,
 * with approver, scope, and export ref) is a larger subsystem and remains a
 * Roadmap item; what is implemented here is the blocking gate plus an audited
 * trail on the GLOBAL FinalityLog chain for the one endpoint that today serves
 * closed-domain data.
 *
 * @module zc/platform/purpose
 */

/**
 * Purpose codes from docs/specs/10_requirements.md §3.3.2.2.1. Closed set: an
 * unrecognised value is treated exactly like a missing one.
 *
 * P01 customer-facing status inquiry · P02 CASE handling · P03 fraud kill-switch ·
 * P04 audit · P05 supervisory request · P06 incident analysis · P07 fund payout.
 */
export const PURPOSE_CODES = ["P01", "P02", "P03", "P04", "P05", "P06", "P07"] as const;

export type PurposeCode = (typeof PURPOSE_CODES)[number];

export function isPurposeCode(value: string | null | undefined): value is PurposeCode {
  return !!value && (PURPOSE_CODES as readonly string[]).includes(value);
}

/** Why a closed-domain read was refused. */
export type AccessDenialReason = "PURPOSE_CODE_MISSING" | "REQUESTER_UNIDENTIFIED";

/**
 * Record a blocked closed-domain access on the GLOBAL FinalityLog chain.
 *
 * The subject is recorded as given (bank id / "UNIDENTIFIED"); no attempt is
 * made to resolve identity further, because a caller that failed the gate is by
 * definition unauthenticated for this purpose.
 */
export async function recordDataAccessViolation(
  db: D1Database,
  input: {
    resource: string;
    subject: string;
    purpose_code: string | null;
    reason: AccessDenialReason;
  }
): Promise<void> {
  const { writeFinalityLog } = await import("../orchestrator");
  await writeFinalityLog(db, {
    txid: null,
    event_type: "DataAccessViolationDetected",
    state_from: null,
    state_to: "BLOCKED",
    payload_json: JSON.stringify(input),
    txid_or_gtid: null,
  });
}

/**
 * Record a *permitted* closed-domain access on the GLOBAL chain.
 *
 * Kept deliberately narrow: this is the audit trail for reads of the hold detail
 * (shortfall figures and the identity of the defaulting participant), which is
 * the most sensitive data ZC serves. It answers "who looked at the defaulter's
 * shortfall, under what purpose, and when".
 */
export async function recordClosedDomainAccess(
  db: D1Database,
  input: { resource: string; subject: string; purpose_code: PurposeCode; scope: string }
): Promise<void> {
  const { writeFinalityLog } = await import("../orchestrator");
  await writeFinalityLog(db, {
    txid: null,
    event_type: "ClosedDomainAccessGranted",
    state_from: null,
    state_to: "GRANTED",
    payload_json: JSON.stringify(input),
    txid_or_gtid: null,
  });
}
