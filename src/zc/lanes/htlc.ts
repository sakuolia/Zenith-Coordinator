/**
 * @file HTLC lane — barrel re-export.
 *
 * The HTLC lane is split across `lanes/htlc/` submodules:
 *   - create.ts     — createHtlc, lockHtlc (RECEIVED → HTLC_LOCKED)
 *   - claim.ts      — claimHtlc / claimHtlcByAttestation / claimHtlcByConditions
 *   - crosschain.ts — recordCrossChainLock, recordOnchainFulfillment (テーマA)
 *   - cancel.ts     — cancelHtlc
 *   - _fulfill.ts   — settleAfterPreimage core (HtlcFulfillResult)
 *
 * Keep this barrel so external imports (`from '../lanes/htlc'`) continue to
 * resolve unchanged.
 *
 * @module zc/lanes/htlc
 */
export { createHtlc, lockHtlc } from "./htlc/create";
export { claimHtlc, claimHtlcByAttestation, claimHtlcByConditions } from "./htlc/claim";
export { recordCrossChainLock, recordOnchainFulfillment } from "./htlc/crosschain";
export { cancelHtlc } from "./htlc/cancel";
export type { HtlcFulfillResult } from "./htlc/_fulfill";
