/**
 * @file The guarded-read route table — one declarative place that says which
 *       ZC reads are party-scoped and how each one's parties are found.
 *
 * Kept apart from `access.ts` (the mechanism) so the *policy* — which reads
 * carry another participant's data — is a list a reviewer can read top to
 * bottom, rather than a predicate scattered across the router. Adding a read
 * endpoint that exposes party data means adding a row here; the invariant test
 * `test/invariants/query_access.test.ts` fails when a `GET /api/…` route in the
 * router matches neither this table nor the public allow-list below.
 *
 * @module zc/platform/access_routes
 */
import {
  caseParties,
  collectionParties,
  debitMandateParties,
  gtidParties,
  htlcAuthParties,
  htlcParties,
  reversalParties,
  selfParty,
  txParties,
  type PartyLookup,
} from "./access";

/** How a guarded read is scoped. */
export type GuardedRead =
  /** Single resource: permitted to its parties (and the operator). */
  | { kind: "PARTY"; resource: string; lookup: PartyLookup; id: string }
  /** List / feed: operator-only (§3.3.2.2.3 forbids participant全件検索). */
  | { kind: "AGGREGATE"; resource: string };

/**
 * Reads that are **public by design** and therefore never gated. Each is public
 * because a spec says so, not because it was overlooked — the reason is on the
 * row so the exemption cannot quietly grow.
 */
const PUBLIC_READS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\/api\/openapi\/[^/]+\.yaml$/,
    why: "API 仕様書そのもの（取引データを含まない）",
  },
  {
    pattern: /^\/api\/dns\/[^/]+\/status$/,
    why: "全参加主体向けの公式ステータス。原因行・不足額を含まない（20 §9.4.4 (A)）",
  },
  {
    pattern: /^\/api\/dns\/[^/]+\/hold_detail$/,
    why: "閉域照会。目的コード必須だが拒否は一律 404 という固有の規範を持つ（20 §9.4.4 (B)）",
  },
  { pattern: /^\/api\/system-mode$/, why: "系全体の縮退モード。参加者データを含まない" },
  { pattern: /^\/api\/banks$/, why: "参加行の名簿。取引・フローを含まない" },
  { pattern: /^\/api\/fx\/rates$/, why: "FXP が公示する気配値。取引データではない" },
  {
    pattern: /^\/api\/banks\/[^/]+\/accounts$/,
    why: "参加行自身の勘定一覧（銀行モックの自行データ）",
  },
  { pattern: /^\/api\/accounts\/[^/]+\/name$/, why: "名義照会。当事者キーによる単件照会" },
  { pattern: /^\/api\/proxy\/resolve$/, why: "エイリアス解決。当事者キーによる単件照会" },
  { pattern: /^\/api\/qr\/[^/]+$/, why: "QR の内容。発行時に受取側が公開する情報" },
  { pattern: /^\/api\/rtp\/incoming$/, why: "自行宛の請求一覧（口座番号で自行に閉じる）" },
  { pattern: /^\/api\/htlc\/auth-whitelist$/, why: "ZC 運営が管理する加盟店ホワイトリスト" },
  { pattern: /^\/api\/account-verify\/[^/]+$/, why: "自らが起票した口座確認の結果" },
  { pattern: /^\/api\/edi\/.*$/, why: "参照 ID を知る当事者のみが引ける商流データ" },
  {
    pattern: /^\/api\/richdata\/.*$/,
    why: "参照 ID を知る当事者のみが引ける商流データ（EDI と同型）",
  },
  { pattern: /^\/api\/cross-border\/[^/]+$/, why: "参照 ID を知る当事者のみが引ける越境送金" },
  { pattern: /^\/api\/sse\/events\/[^/]+$/, why: "銀行宛ストリーム（bankId で自行に閉じる）" },
  { pattern: /^\/api\/stream\/connect$/, why: "実験的ストリーミング決済の接続" },
  { pattern: /^\/api\/als\/lookup$/, why: "エイリアス解決キャッシュ" },
  {
    pattern: /^\/api\/directory\/banks\/[^/]+\/collection-profile$/,
    why:
      "払出行の勘定系プロファイルの公開ビュー。取扱時間は約款等で公表される" +
      "運用事実であり、受取人が自力で知り得ない唯一の入力（10 §3.2.8.8 の分界）",
  },
];

export function isPublicRead(path: string): boolean {
  return PUBLIC_READS.some((r) => r.pattern.test(path));
}

/** Expose the table so the invariant test can assert every exemption has a reason. */
export const PUBLIC_READ_TABLE = PUBLIC_READS;

/**
 * Classify a `GET /api/…` path. Returns null when the path is not a guarded
 * read (public, or not a read at all).
 */
export function classifyRead(path: string): GuardedRead | null {
  // --- single transaction and its derived views ---
  const tx = /^\/api\/transactions\/([^/]+)(?:\/(events|explain|story|verify|reversals))?$/.exec(
    path
  );
  if (tx) {
    return {
      kind: "PARTY",
      resource: `transactions/${tx[1]}${tx[2] ? `/${tx[2]}` : ""}`,
      lookup: txParties,
      id: tx[1]!,
    };
  }

  // --- single GTID and its derived views ---
  const gtid = /^\/api\/gtid\/([^/]+)(?:\/(events|verify))?$/.exec(path);
  if (gtid) {
    return {
      kind: "PARTY",
      resource: `gtid/${gtid[1]}${gtid[2] ? `/${gtid[2]}` : ""}`,
      lookup: gtidParties,
      id: gtid[1]!,
    };
  }

  // --- FX transfer status: the conduit GTID's legs are the parties ---
  const fx = /^\/api\/fx\/transfers\/([^/]+)$/.exec(path);
  if (fx) {
    return { kind: "PARTY", resource: `fx/transfers/${fx[1]}`, lookup: gtidParties, id: fx[1]! };
  }

  // --- single payee-initiated authorisation ---
  const auth = /^\/api\/htlc\/auth\/([^/]+)$/.exec(path);
  if (auth) {
    return {
      kind: "PARTY",
      resource: `htlc/auth/${auth[1]}`,
      lookup: htlcAuthParties,
      id: auth[1]!,
    };
  }

  // --- single HTLC ---
  const htlc = /^\/api\/htlc\/([^/]+)$/.exec(path);
  if (htlc && htlc[1] !== "auth-requests" && htlc[1] !== "auth-whitelist") {
    return { kind: "PARTY", resource: `htlc/${htlc[1]}`, lookup: htlcParties, id: htlc[1]! };
  }

  // --- continuous collection: contract and its notices ---
  // A notice names a customer, an amount and a date, so it is party data from
  // registration onward — before any Transaction exists to hang it on.
  const ddm = /^\/api\/debit-mandates\/([^/]+)$/.exec(path);
  if (ddm) {
    return {
      kind: "PARTY",
      resource: `debit-mandates/${ddm[1]}`,
      lookup: debitMandateParties,
      id: ddm[1]!,
    };
  }
  const collection = /^\/api\/collections\/([^/]+)$/.exec(path);
  if (collection) {
    return {
      kind: "PARTY",
      resource: `collections/${collection[1]}`,
      lookup: collectionParties,
      id: collection[1]!,
    };
  }

  // --- single CASE ---
  const kase = /^\/api\/cases\/([^/]+)$/.exec(path);
  if (kase) {
    return { kind: "PARTY", resource: `cases/${kase[1]}`, lookup: caseParties, id: kase[1]! };
  }

  // --- aggregates: lists, feeds, and cross-participant position views ---
  if (path === "/api/transactions") return { kind: "AGGREGATE", resource: "transactions" };
  if (path === "/api/gtid") return { kind: "AGGREGATE", resource: "gtid" };
  if (path === "/api/htlc") return { kind: "AGGREGATE", resource: "htlc" };
  if (path === "/api/htlc/auth-requests")
    return { kind: "AGGREGATE", resource: "htlc/auth-requests" };
  if (path === "/api/events") return { kind: "AGGREGATE", resource: "events" };
  // "Everything this account has authorised" spans every payee that ever
  // obtained a mandate against it, so it is not scoped to any one participant.
  if (path === "/api/debit-mandates") return { kind: "AGGREGATE", resource: "debit-mandates" };
  if (path === "/api/boj/positions") return { kind: "AGGREGATE", resource: "boj/positions" };
  if (path === "/api/circuit-breaker") return { kind: "AGGREGATE", resource: "circuit-breaker" };
  if (/^\/api\/dns\/[^/]+\/position$/.test(path))
    return { kind: "AGGREGATE", resource: path.replace(/^\/api\//, "") };
  if (/^\/api\/dns\/[^/]+\/verify$/.test(path))
    return { kind: "AGGREGATE", resource: path.replace(/^\/api\//, "") };
  // --- single resources keyed by the party itself / by a linked transaction ---
  const cb = /^\/api\/circuit-breaker\/([^/]+)$/.exec(path);
  if (cb) {
    return {
      kind: "PARTY",
      resource: `circuit-breaker/${cb[1]}`,
      lookup: selfParty,
      id: cb[1]!,
    };
  }
  const rev = /^\/api\/reversals\/([^/]+)$/.exec(path);
  if (rev) {
    return {
      kind: "PARTY",
      resource: `reversals/${rev[1]}`,
      lookup: reversalParties,
      id: rev[1]!,
    };
  }

  return null;
}
