/**
 * @file RTP (Request-to-Pay) lane — barrel re-export.
 *
 * The RTP lane is split across `lanes/rtp/` submodules:
 *   - register.ts — request creation, attempt linking, payer notification
 *   - respond.ts  — payer accept (auto-creates tx) / reject
 *   - query.ts    — read-only lookups + cron timeout sweep
 *
 * Keep this barrel so external imports (`from '../lanes/rtp'`) continue
 * to resolve.
 *
 * @module zc/lanes/rtp
 */
export {
  attemptRtp,
  settleRtp,
  registerRtpRequest,
} from "./rtp/register";
export { respondToRtp } from "./rtp/respond";
export {
  getRtpStatus,
  expireRtpRequests,
} from "./rtp/query";
