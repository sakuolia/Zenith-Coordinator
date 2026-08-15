/**
 * @file als.ts — Mojaloop-style Account Lookup Service (ALS) using Cloudflare KV
 *
 * Provides extremely fast alias resolution (e.g. phone -> bank/account)
 * via KV caches, falling back to db or default generation.
 */
import type { Env } from "../../types";

export interface ResolvedAccount {
  bank_id: string;
  account_hash: string;
  pspr_ref?: string;
}

export async function lookupAlias(alias: string, env: Env): Promise<ResolvedAccount | null> {
  // 1. Try hitting the high-speed KV cache first
  if (env.ALS_KV) {
    try {
      const cached = await env.ALS_KV.get(alias, "json");
      if (cached) return cached as ResolvedAccount;
    } catch (e) {
      console.warn("[ALS] KV lookup failed, falling back to simulation", e);
    }
  }

  // 2. Simulated DB lookup for Mock purposes
  let resolved: ResolvedAccount | null = null;

  if (alias.startsWith("payid:")) {
    // mock resolving a payid to bank_id 444
    resolved = { bank_id: "444", account_hash: `hash_for_${alias}` };
  } else if (alias.startsWith("phone:")) {
    resolved = { bank_id: "888", account_hash: `hash_for_${alias}`, pspr_ref: `pspr_${alias}` };
  } else if (alias.length === 10 && !Number.isNaN(Number(alias))) {
    // 10 digits implies standard bankCode+accountNum
    resolved = { bank_id: alias.slice(0, 3), account_hash: alias };
  }

  // 3. Save back to KV asynchronously (Fire & Forget)
  if (resolved && env.ALS_KV) {
    env.ALS_KV.put(alias, JSON.stringify(resolved)).catch((e) => {
      console.error("[ALS] Failed to update KV cache", e);
    });
  }

  return resolved;
}
