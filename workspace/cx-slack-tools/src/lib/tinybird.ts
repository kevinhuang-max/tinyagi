/**
 * Tinybird usage client for /brief
 *
 * Real product usage (page views) from the `vmp` Tinybird workspace. We use
 * this instead of ChurnZero's usage fields, which are unreliable (read 0 while
 * the account has real traffic).
 *
 * Join: Salesforce and Tinybird share no common ID, so we match the SF account
 * name to Tinybird's property_name with a fuzzy (ngram) ranking and accept only
 * a confident, unambiguous winner. If the match is not confident we return null
 * and the brief simply shows no usage — never usage for the wrong property.
 *
 * Internal/staff views are excluded (is_internal_viewer=0). Usage is reported
 * as its own signal and kept separate from the ChurnZero score (no double-count).
 */

const TB_HOST = process.env.TINYBIRD_HOST || 'https://api.us-west-2.aws.tinybird.co';
const TB_TOKEN = process.env.TINYBIRD_TOKEN;

export interface PropertyUsage {
  propertyId: number;
  propertyName: string;
  pageViews30d: number;
  pageViewsPrev30d: number;
  trendPct: number | null;
  sessions30d: number;
  lastView: string | null;
}

interface TBResponse<T> { data: T[] }

async function tbSql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!TB_TOKEN) throw new Error('TINYBIRD_TOKEN not set');
  const url = `${TB_HOST}/v0/sql?q=${encodeURIComponent(sql + ' FORMAT JSON')}&token=${TB_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tinybird ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as TBResponse<T>;
  return json.data || [];
}

const sqlStr = (s: string) => s.replace(/'/g, "''");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

interface PropMatch { id: number; name: string }

// Resolve a Salesforce account name to a Tinybird property_id by fuzzy name
// match. Returns null unless the best match is confident and unambiguous.
async function resolvePropertyId(accountName: string): Promise<PropMatch | null> {
  if (!accountName) return null;
  const rows = await tbSql<{ property_id: number; property_name: string; dist: number }>(
    `SELECT property_id, property_name, ngramDistanceCaseInsensitive(property_name, '${sqlStr(accountName)}') AS dist ` +
    `FROM viewer_events WHERE is_internal_viewer = 0 GROUP BY property_id, property_name ORDER BY dist ASC LIMIT 5`
  );
  if (!rows.length) return null;
  const top = rows[0];
  const second = rows[1];
  const a = norm(accountName);
  const b = norm(top.property_name);
  const contains = b.length > 0 && (a.includes(b) || b.includes(a));
  const clearWinner = !second || second.dist - top.dist > 0.1;
  // Accept a strong fuzzy score with clear separation, or a clean normalized
  // containment that is still the unambiguous best.
  if ((top.dist < 0.35 && clearWinner) || (contains && top.dist < 0.6 && clearWinner)) {
    return { id: top.property_id, name: top.property_name };
  }
  return null;
}

export async function getPropertyUsage(accountName: string): Promise<PropertyUsage | null> {
  try {
    const match = await resolvePropertyId(accountName);
    if (!match) return null;
    const rows = await tbSql<{ pv30: number; pv_prev30: number; sessions30: number; last_view: string | null }>(
      `SELECT ` +
      `countIf(event_name = 'page_view' AND timestamp >= now() - INTERVAL 30 DAY) AS pv30, ` +
      `countIf(event_name = 'page_view' AND timestamp >= now() - INTERVAL 60 DAY AND timestamp < now() - INTERVAL 30 DAY) AS pv_prev30, ` +
      `uniqExactIf(session_id, event_name = 'page_view' AND timestamp >= now() - INTERVAL 30 DAY) AS sessions30, ` +
      `maxIf(toDate(timestamp), event_name = 'page_view') AS last_view ` +
      `FROM viewer_events WHERE is_internal_viewer = 0 AND property_id = ${match.id}`
    );
    const m = rows[0] || ({} as Record<string, unknown>);
    const pv30 = Number(m.pv30 || 0);
    const prev = Number(m.pv_prev30 || 0);
    const trendPct = prev > 0 ? Math.round(((pv30 - prev) / prev) * 100) : null;
    const lastView = typeof m.last_view === 'string' && !m.last_view.startsWith('1970') ? m.last_view : null;
    return {
      propertyId: match.id,
      propertyName: match.name,
      pageViews30d: pv30,
      pageViewsPrev30d: prev,
      trendPct,
      sessions30d: Number(m.sessions30 || 0),
      lastView,
    };
  } catch (err) {
    console.error('Tinybird usage error:', err);
    return null;
  }
}
