/**
 * ChurnZero OData v4 client for /brief
 *
 * Fetches account health, engagement signals, tasks, and recent activity.
 * Auth: HTTP Basic (email:key)
 *
 * Field notes (verified against the live API 2026-06-18): the health score
 * lives on the Account as PrimaryChurnScoreValue (HIGHER = MORE churn risk).
 * Engagement signals live under the Account's Cf (custom fields) object.
 * ChurnScoreCalculation rows use `Score` (not `CurrentScore`) and have no
 * Grade/Trend fields, so trend is derived from recent primary calcs.
 */

const CZ_BASE = 'https://visitingmedia.us1app.churnzero.net/public/v1';

function authHeader(): string {
  const user = process.env.CHURNZERO_ODATA_USER!;
  const key = process.env.CHURNZERO_ODATA_KEY!;
  return `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`;
}

interface ODataResponse<T> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
}

async function czFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${CZ_BASE}/${path}`, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CZ ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Types ──────────────────────────────────────────────────────────

export interface CZAccount {
  Id: number;
  ExternalId?: string;
  Name?: string;
  IsActive?: boolean;
  TotalContractAmount?: number;
  NextRenewalDate?: string;
  StartDate?: string;
  EndDate?: string;
  TenureInDays?: number;
  ContactsCount?: number;
  UsageFrequency?: string;
  PrimaryChurnScoreId?: number;
  PrimaryChurnScoreValue?: number;
  Tags?: string[];
  Cf?: {
    OfPageViewsLast30Days?: number;
    ActivePropertyAdmins?: number;
    LastActivity?: string;
    LastSupportUpdateDate?: string;
    MostRecentBusinessReview?: string;
    NextBusinessReview?: string;
    SupportNextAction?: string;
    CancellationPending?: boolean;
    AtRisk?: boolean;
    AccountType?: string;
    PropertyStatus?: string;
    MigrationCohort?: string;
    ActiveArr?: number;
    LegacyTruetorViews?: number;
    VisitsUsed?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CZTask {
  Id: number;
  Name?: string;
  DueDate?: string;
  StatusName?: string;
  TypeName?: string;
  AccountId?: number;
  [key: string]: unknown;
}

export interface CZEvent {
  Id: number;
  EventDate?: string;
  Description?: string;
  Quantity?: number;
  EventTypeName?: string;
  AccountExternalId?: string;
  ContactExternalId?: string;
  [key: string]: unknown;
}

// ─── Account Lookup ─────────────────────────────────────────────────

export async function getAccountByExternalId(sfAccountId: string): Promise<CZAccount | null> {
  try {
    const result = await czFetch<ODataResponse<CZAccount>>(
      `Account?$filter=ExternalId eq '${sfAccountId}'&$top=1`
    );
    return result.value[0] || null;
  } catch {
    return null;
  }
}

// ─── Health Score Trend ─────────────────────────────────────────────
// The score value itself is read directly off the account
// (PrimaryChurnScoreValue). Here we derive a trend from the recent primary
// score calculations. Remember: HIGHER score = MORE risk.

export async function getScoreTrend(czAccountId: number): Promise<string | null> {
  try {
    const result = await czFetch<ODataResponse<{ Score?: number; CalculationDay?: string }>>(
      `ChurnScoreCalculation?$filter=AccountId eq ${czAccountId} and IsPrimary eq true&$orderby=CalculationDay desc&$top=8`
    );
    const scores = result.value.filter(s => typeof s.Score === 'number');
    if (scores.length < 2) return null;
    const newest = scores[0].Score as number;
    const oldest = scores[scores.length - 1].Score as number;
    if (newest > oldest + 1) return 'rising (worse)';
    if (newest < oldest - 1) return 'falling (improving)';
    return 'flat';
  } catch {
    return null;
  }
}

// ─── Tasks ──────────────────────────────────────────────────────────

export async function getOpenTasks(czAccountId: number): Promise<CZTask[]> {
  try {
    const result = await czFetch<ODataResponse<CZTask>>(
      `Task?$filter=AccountId eq ${czAccountId} and StatusName ne 'Complete'&$top=5&$orderby=DueDate asc`
    );
    return result.value;
  } catch {
    return [];
  }
}

// ─── Recent Events ──────────────────────────────────────────────────

export async function getRecentEvents(sfAccountId: string, limit = 10): Promise<CZEvent[]> {
  try {
    const result = await czFetch<ODataResponse<CZEvent>>(
      `Event?$filter=AccountExternalId eq '${sfAccountId}'&$top=${limit}&$orderby=EventDate desc`
    );
    return result.value;
  } catch {
    return [];
  }
}
