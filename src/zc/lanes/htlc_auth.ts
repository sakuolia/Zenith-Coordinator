/**
 * @file HTLC Auth lane — barrel re-export.
 *
 * The HTLC-Auth (payee-initiated authorization) flow is split across
 * `lanes/htlc_auth/` submodules:
 *   - whitelist.ts  — register / revoke / list admin entries
 *   - request.ts    — payee auth request + payer decline
 *   - approve.ts    — payer approve (mints HTLC contract)
 *   - capture.ts    — payee capture + void
 *   - query.ts      — read-only lookups
 *
 * Keep this barrel so external imports (`from '../lanes/htlc_auth'`) continue
 * to resolve. Add new HTLC-Auth APIs to the appropriate submodule and re-export
 * here.
 *
 * @module zc/lanes/htlc_auth
 */
export {
  registerAuthWhitelist,
  revokeAuthWhitelist,
  listAuthWhitelist,
} from "./htlc_auth/whitelist";
export {
  createAuthRequest,
  declineAuthRequest,
} from "./htlc_auth/request";
export { approveAuthRequest } from "./htlc_auth/approve";
export {
  captureHtlcAuth,
  voidHtlcAuth,
} from "./htlc_auth/capture";
export {
  getAuthRequest,
  listAuthRequests,
} from "./htlc_auth/query";
