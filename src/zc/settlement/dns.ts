/**
 * @file DNS (Deferred Net Settlement) lane — barrel re-export.
 *
 * Split across `settlement/dns/` submodules (acyclic: cycle → settle → reserve):
 *   - reserve.ts   — BOJ shortfall / recovery-reserve math, RINGFENCED_PLUS
 *   - settle.ts    — settleDns net-position settlement run
 *   - cycle.ts     — kick / resume / hold / intraday-cutoff / getOrCreateDnsCycle
 *   - admission.ts — checkIgsAdmission gate (IgsAdmissionDecision)
 *   - query.ts     — read-only status / net-position / BOJ-position queries
 *   - disclosure.ts— public_message_id template ids + hold-disclosure resolution
 *
 * Keep this barrel so external imports (`from '.../settlement/dns'`) resolve
 * unchanged.
 *
 * @module zc/settlement/dns
 */
export {
  computeBojShortfalls,
  computeDnsRecoveryReserve,
  promoteRingfencePlus,
  type DnsRecoveryReserve,
} from "./dns/reserve";
export { settleDns } from "./dns/settle";
export {
  kickDns,
  resumeDns,
  holdDns,
  runIntradayDnsCutoff,
  getOrCreateDnsCycle,
} from "./dns/cycle";
export { checkIgsAdmission, type IgsAdmissionDecision } from "./dns/admission";
export {
  getDnsStatus,
  getDnsNetPositions,
  getBojPositions,
  getDnsHoldDetail,
  type DnsHoldDetail,
  type HoldDetailScope,
} from "./dns/query";
export {
  dnsHoldMessageId,
  igsHoldMessageId,
  resolveHoldDisclosure,
  IGS_HOLD_REASON_CODES,
  type HoldDisclosure,
} from "./dns/disclosure";
