/**
 * Supabase/Salesforce query client for /brief
 *
 * Queries the read-only Salesforce replica via Supabase REST API.
 * Requires Accept-Profile: salesforce header for all requests.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;

interface SupabaseQueryOptions {
  table: string;
  select: string;
  filters?: string;
  order?: string;
  limit?: number;
}

async function query<T>(opts: SupabaseQueryOptions): Promise<T[]> {
  const params = new URLSearchParams();
  params.set('select', opts.select);
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));

  let url = `${SUPABASE_URL}/rest/v1/${opts.table}?${params}`;
  if (opts.filters) url += `&${opts.filters}`;

  // The Salesforce replica kills long-running queries with a statement timeout
  // (Postgres 57014). Unindexed Name searches (findAccount) full-scan ~76k rows
  // and intermittently trip it under load. Retry transient timeouts / gateway
  // errors a few times — there is ample budget since the Slack ack already went
  // out and the work runs in waitUntil (up to maxDuration).
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Accept-Profile': 'salesforce',
      },
    });

    if (res.ok) return res.json();

    const text = await res.text();
    const transient =
      text.includes('57014') ||
      text.toLowerCase().includes('statement timeout') ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504;

    if (transient && attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, attempt * 600));
      continue;
    }

    throw new Error(`Supabase ${res.status}: ${text}`);
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface SFAccount {
  Id: string;
  Name: string;
  Active_ARR__c: number | null;
  Property_Status__c: string | null;
  Account_Tier__c: string | null;
  At_Risk__c: boolean | null;
  ChurnZero_Churn_Score__c: number | null;
  Support_Rep__c: string | null;
  Subscription_End_Date__c: string | null;
  Termination_Date__c: string | null;
  Region__c: string | null;
  Billing_Status__c: string | null;
  ParentId: string | null;
}

export interface SFOpportunity {
  Name: string;
  StageName: string;
  Amount: number | null;
  ARR__c: number | null;
  CloseDate: string | null;
  Type: string | null;
  Contract_End_Date__c: string | null;
}

export interface SFCase {
  CaseNumber: string;
  Subject: string | null;
  Status: string;
  Priority: string | null;
  CreatedDate: string | null;
}

export interface SFNps {
  Net_Promoter_Score__c: number | null;
  NPS_Grouping__c: string | null;
  Comments__c: string | null;
  CreatedDate: string | null;
}

export interface SFShoot {
  Name: string;
  Shoot_Date__c: string | null;
  Shoot_Stage__c: string | null;
  Scene_Count__c: number | null;
  Content_Type__c: string | null;
}

export interface SFLicense {
  Name: string;
  License_Type__c: string | null;
  Status__c: string | null;
}

// ─── Account Lookup ─────────────────────────────────────────────────

export async function findAccount(searchTerm: string): Promise<SFAccount[]> {
  // No server-side `order`: sorting over a full-table ILIKE scan roughly doubles
  // query time (~2.4s -> ~1.3s measured) and pushes it over the replica's
  // statement timeout. Fetch a wider candidate set unsorted, then rank by ARR
  // client-side (instant) and cap for display. Preserves the caller contract:
  // result[0] is the highest-ARR match.
  const accounts = await query<SFAccount>({
    table: 'Account',
    select: 'Id,Name,Active_ARR__c,Property_Status__c,Account_Tier__c,At_Risk__c,ChurnZero_Churn_Score__c,Support_Rep__c,Subscription_End_Date__c,Termination_Date__c,Region__c,Billing_Status__c,ParentId',
    filters: `Name=ilike.*${encodeURIComponent(searchTerm)}*`,
    limit: 25,
  });

  return accounts
    .sort((a, b) => (b.Active_ARR__c ?? -Infinity) - (a.Active_ARR__c ?? -Infinity))
    .slice(0, 5);
}

// ─── Related Data ───────────────────────────────────────────────────

export async function getOpenOpportunities(accountId: string): Promise<SFOpportunity[]> {
  return query<SFOpportunity>({
    table: 'Opportunity',
    select: 'Name,StageName,Amount,ARR__c,CloseDate,Type,Contract_End_Date__c',
    filters: `AccountId=eq.${accountId}&StageName=neq.Closed Won&StageName=neq.Closed Lost`,
    order: 'CloseDate.asc.nullslast',
    limit: 5,
  });
}

export async function getRecentCases(accountId: string): Promise<SFCase[]> {
  return query<SFCase>({
    table: 'Case',
    select: 'CaseNumber,Subject,Status,Priority,CreatedDate',
    filters: `AccountId=eq.${accountId}&Status=neq.Closed`,
    order: 'CreatedDate.desc',
    limit: 5,
  });
}

export async function getNpsScores(accountId: string): Promise<SFNps[]> {
  return query<SFNps>({
    table: 'NPS_Score__c',
    select: 'Net_Promoter_Score__c,NPS_Grouping__c,Comments__c,CreatedDate',
    filters: `Account__c=eq.${accountId}`,
    order: 'CreatedDate.desc',
    limit: 3,
  });
}

export async function getRecentShoots(accountId: string): Promise<SFShoot[]> {
  return query<SFShoot>({
    table: 'Shoot__c',
    select: 'Name,Shoot_Date__c,Shoot_Stage__c,Scene_Count__c,Content_Type__c',
    filters: `Account__c=eq.${accountId}`,
    order: 'Shoot_Date__c.desc.nullslast',
    limit: 3,
  });
}

export async function getLicenses(accountId: string): Promise<SFLicense[]> {
  return query<SFLicense>({
    table: 'License__c',
    select: 'Name,License_Type__c,Status__c',
    filters: `Account__c=eq.${accountId}&Status__c=eq.Active`,
    limit: 20,
  });
}

// ─── Parent Account Children ────────────────────────────────────────

export async function getChildAccounts(parentId: string): Promise<SFAccount[]> {
  return query<SFAccount>({
    table: 'Account',
    select: 'Id,Name,Active_ARR__c,Property_Status__c',
    filters: `ParentId=eq.${parentId}&Property_Status__c=eq.Active`,
    order: 'Active_ARR__c.desc.nullslast',
    limit: 50,
  });
}
