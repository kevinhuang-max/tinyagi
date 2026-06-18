/**
 * /brief [account name] — Slack slash command handler
 *
 * Builds a CSM-facing pre-call brief: a narrative (What's happening / What it
 * means / Next steps) over the full Salesforce + ChurnZero picture, plus one
 * collapsed Details line.
 *
 * Flow:
 * 1. Acknowledge Slack immediately (must respond within 3s)
 * 2. Query Supabase (Salesforce) + ChurnZero for the account picture
 * 3. Run Claude Haiku to synthesize the narrative
 * 4. Post the formatted result to Slack via response_url
 *
 * Cold-start note: the heavy data/AI libs are loaded lazily INSIDE
 * processAndRespond via dynamic import(), so the initial Slack ack path keeps a
 * near-empty module graph and returns within Slack's 3s window even on a cold
 * lambda. A keep-warm cron (see vercel.json) hits the GET handler below.
 */

import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifySlackRequest } from '@/lib/slack-verify';

export const maxDuration = 30;

// Keep-warm endpoint. Vercel Cron pings this (GET) on a schedule so the lambda
// stays hot and the real Slack POST acks well inside the 3s deadline.
export async function GET() {
  return NextResponse.json({ ok: true, warm: true });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const timestamp = req.headers.get('x-slack-request-timestamp') || '';
  const signature = req.headers.get('x-slack-signature') || '';

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const searchTerm = (params.get('text') || '').trim();
  const responseUrl = params.get('response_url') || '';

  if (!searchTerm) {
    return NextResponse.json({
      response_type: 'ephemeral',
      text: 'Usage: `/brief [account name]` — e.g., `/brief Marriott Downtown`',
    });
  }

  // Acknowledge immediately (Slack requires a response within 3 seconds), then
  // do the heavy lifting async via waitUntil.
  waitUntil(
    processAndRespond(searchTerm, responseUrl).catch(err => {
      console.error('Brief processing error:', err);
      postToSlack(responseUrl, {
        response_type: 'ephemeral',
        text: `Error processing /brief: ${err.message}`,
      });
    })
  );

  return NextResponse.json({
    response_type: 'ephemeral',
    text: `Looking up "${searchTerm}"...`,
  });
}

async function processAndRespond(searchTerm: string, responseUrl: string) {
  // Heavy libs loaded lazily so they don't inflate the cold-start ack path above.
  const {
    findAccount,
    getOpenOpportunities,
    getRecentCases,
    getNpsScores,
    getRecentShoots,
    getLicenses,
    getChildAccounts,
  } = await import('@/lib/supabase');
  const {
    getAccountByExternalId,
    getScoreCalculation,
    getScoreFactors,
    getOpenTasks,
    getRecentEvents,
  } = await import('@/lib/churnzero');
  const { synthesizeNarrative } = await import('@/lib/synthesize');
  const { formatBrief } = await import('@/lib/format');
  const { getContractTerms } = await import('@/lib/contract-terms');

  // Step 1: Find account in Salesforce
  const accounts = await findAccount(searchTerm);

  if (accounts.length === 0) {
    await postToSlack(responseUrl, {
      response_type: 'ephemeral',
      text: `No accounts found matching "${searchTerm}". Try a different name or partial match.`,
    });
    return;
  }

  const account = accounts[0];
  const alternatives = accounts.length > 1 ? accounts.slice(1).map(a => a.Name).join(', ') : null;

  // Step 2: Query all data sources in parallel
  const [
    opportunities,
    cases,
    nps,
    shoots,
    licenses,
    children,
    czAccount,
    contractTerms,
  ] = await Promise.all([
    getOpenOpportunities(account.Id),
    getRecentCases(account.Id),
    getNpsScores(account.Id),
    getRecentShoots(account.Id),
    getLicenses(account.Id),
    account.ParentId ? [] : getChildAccounts(account.Id),
    getAccountByExternalId(account.Id),
    getContractTerms(account.Id),
  ]);

  // Step 3: ChurnZero health + timeline (when the account exists in CZ)
  let czHealthScore: number | null = null;
  let czGrade: string | null = null;
  let czTrend: string | null = null;
  let czTasks: Array<{ name?: string; dueDate?: string; status?: string }> = [];
  let czEvents: Array<{ date?: string; description?: string; type?: string }> = [];
  let czSignals: BriefSignals | null = null;

  if (czAccount) {
    const [scoreCalc, scoreFactors, tasks, events] = await Promise.all([
      getScoreCalculation(czAccount.Id),
      getScoreFactors(czAccount.Id),
      getOpenTasks(czAccount.Id),
      getRecentEvents(account.Id),
    ]);
    void scoreFactors;

    if (scoreCalc) {
      czHealthScore = scoreCalc.CurrentScore ?? null;
      czGrade = scoreCalc.Grade ?? null;
      czTrend = scoreCalc.ScoreTrend ?? null;
    }

    czTasks = tasks.map(t => ({ name: t.Name, dueDate: t.DueDate, status: t.StatusName }));
    czEvents = events.map(e => ({ date: e.EventDate, description: e.Description, type: e.EventTypeName }));
    czSignals = {
      lastActivity: czAccount.Cf?.LastActivity as string | undefined,
      pageViews30d: czAccount.Cf?.OfPageViewsLast30Days as number | undefined,
      activeAdmins: czAccount.Cf?.ActivePropertyAdmins as number | undefined,
      supportNextAction: czAccount.Cf?.SupportNextAction as string | undefined,
      cancellationPending: czAccount.Cf?.CancellationPending as boolean | undefined,
    };
  }

  // Step 4: Family ARR if this is a parent account
  let childCount: number | undefined;
  let totalFamilyArr: number | undefined;
  if (children.length > 0) {
    childCount = children.length;
    totalFamilyArr = children.reduce((sum, c) => sum + (c.Active_ARR__c || 0), 0) + (account.Active_ARR__c || 0);
  }

  // Step 5: Synthesize the narrative over the full picture (always run)
  const today = new Date().toISOString().slice(0, 10);
  const narrative = await synthesizeNarrative({
    accountName: account.Name,
    arr: account.Active_ARR__c,
    tier: account.Account_Tier__c,
    status: account.Property_Status__c,
    atRisk: account.At_Risk__c,
    csm: account.Support_Rep__c,
    contractEnd: contractTerms?.contract_end || account.Subscription_End_Date__c,
    autoRenew: contractTerms?.auto_renewal ?? null,
    cancellationNoticeDays: contractTerms?.cancellation_notice_days ?? null,
    health: { value: czHealthScore, grade: czGrade, trend: czTrend },
    opportunities: opportunities.map(o => ({ name: o.Name, stage: o.StageName, amount: o.Amount, closeDate: o.CloseDate })),
    cases: cases.map(c => ({ number: c.CaseNumber, subject: c.Subject, status: c.Status, priority: c.Priority, createdDate: c.CreatedDate })),
    nps: nps.map(n => ({ score: n.Net_Promoter_Score__c, grouping: n.NPS_Grouping__c, comment: n.Comments__c, date: n.CreatedDate })),
    shoots: shoots.map(s => ({ name: s.Name, stage: s.Shoot_Stage__c, date: s.Shoot_Date__c })),
    czSignals,
    czTasks,
    czEvents,
    today,
  });

  // Step 6: Format and send
  const message = formatBrief({
    account,
    childCount,
    totalFamilyArr,
    opportunities,
    cases,
    nps,
    shoots,
    licenses,
    czHealthScore,
    czGrade,
    czTrend,
    narrative,
    contractTerms: contractTerms ?? undefined,
  });

  const payload = {
    response_type: 'ephemeral' as const,
    ...message,
  };

  if (alternatives) {
    (payload as Record<string, unknown>).text = `Showing top match. Also found: ${alternatives}`;
  }

  await postToSlack(responseUrl, payload);
}

interface BriefSignals {
  lastActivity?: string;
  pageViews30d?: number;
  activeAdmins?: number;
  supportNextAction?: string;
  cancellationPending?: boolean;
}

async function postToSlack(responseUrl: string, payload: object) {
  if (!responseUrl) return;

  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('Slack response_url failed:', res.status, await res.text());
  }
}
