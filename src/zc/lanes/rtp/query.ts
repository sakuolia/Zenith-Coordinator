/**
 * @file RTP read-only queries and cron timeout sweep.
 * @module zc/lanes/rtp/query
 */
import type { RtpRequestRow, RtpState } from "../../../types";
import { nowISO } from "../../../types";

/**
 * RTP lookup
 *
 * Since the RTP consolidation the state column is the sole source of state, so return it as-is.
 */
export async function getRtpStatus(
  db: D1Database,
  rtpId: string
): Promise<{ rtpId: string; status: RtpState; rows: unknown[] } | null> {
  const row = await db
    .prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `)
    .bind(rtpId)
    .first<RtpRequestRow>();

  if (!row) return null;

  return { rtpId, status: row.state, rows: [row] };
}

/**
 * RTP timeout processing (for cron)
 *
 * Sets RTPs with expires_at < now and in CREATED / NOTIFIED state to EXPIRED.
 */
export async function expireRtpRequests(db: D1Database): Promise<number> {
  const now = nowISO();

  const result = await db
    .prepare(`
    UPDATE RtpRequests
    SET state = 'EXPIRED', updated_at = ?
    WHERE expires_at < ? AND state IN ('CREATED', 'NOTIFIED')
  `)
    .bind(now, now)
    .run();

  return result.meta.changes ?? 0;
}
