/**
 * @file Request-to-Pay (RTP) stub — re-exports from lanes/rtp.ts.
 * @module zc/rtp
 */
export {
  attemptRtp,
  settleRtp,
  registerRtpRequest,
  respondToRtp,
  getRtpStatus,
  expireRtpRequests,
} from "./lanes/rtp";
