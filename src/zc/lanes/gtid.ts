/**
 * @file GTID (Global Transaction ID) coordinated multi-leg lane — barrel.
 *
 * Split across `lanes/gtid/` submodules:
 *   - legs.ts     — pure leg normalization (fan-out / fan-in / general N×M)
 *   - register.ts — registerGtid
 *   - advance.ts  — advanceGtid, recoverStuckPrecheckedGtid, finalizeGtidCancelled
 *
 * Keep this barrel so external imports (`from '.../lanes/gtid'`) resolve
 * unchanged.
 *
 * @module zc/lanes/gtid
 */
export { normalizeFanOutLegs, decomposeGeneralNM, normalizeGtidLegs } from "./gtid/legs";
export { registerGtid } from "./gtid/register";
export { advanceGtid, recoverStuckPrecheckedGtid } from "./gtid/advance";
