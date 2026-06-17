/**
 * /brief [account name] — Slack slash command handler
 *
 * Queries Salesforce (via Supabase) and ChurnZero to build a one-screen
 * account summary for CSMs before customer calls.
 *
 * Flow:
 * 1. Acknowledge Slack immediately (must respond within 3s)
 * 2. Query Supabase for account match
 * 3. Query ChurnZero for health score, tasks, events
 * 4. Run Claude Haiku synthesis on CZ timeline
 * 5. Post formatted result to Slack via response_url
 *
 * Cold-start note: the heavy data/AI libs (supabase, churnzero, synthesize,
 * format, contract-terms — the last of which pulls in the Anthropic SDK) are
 * loaded lazily INSIDE processAndRespond via dynamic import(), so the initial
 * Slack ack path keeps a near-empty module graph and returns within Slack's
 * 3s window even on a cold lambda. A keep-warm cron (see vercel.json) hits the
 * GET handler below to keep this function hot during business hours.
 */

import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { verifySlackRequest } from '@/lib/slack-verify';

export const maxDuration = 30;

// Keep-warm endpoint. Vercel Cron pings this (GET) on a schedule so the lambda
// stays hot and the real Slack POST acks well inside the 3s deadline. Returns
// fast with no data/AI work.
export async function GET() {
  return NextResponse.json({ ok: true, warm: true });
}

export async function POST(req: NextRequest) {
  // Read raw body for signature verification
  const rawBody = await req.text();
  const timestamp = req.headers.get('x-slack-request-timestamp') || '';
  const signature = req.headers.get('x-slack-signature') || '';

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Parse form-encoded body
  const params = new URLSearchParams(rawBody);
  const searchTerm = (params.get('text') || '').trim();
  const responseUrl = params.get('response_url') || '';

  if (!searchTerm) {
    return NextResponse.json({
      response_type: 'ephemeral',
      text: 'Usage: `/brief [account name]` — e.g., `/brief Marriott Downtown`',
    });
  }

  // Acknowledge immediately, then do the heavy lifting async
  // Slack requires a response within 3 seconds
  // Use waitUntil to keep the serverless function alive after the response is sent
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
  const { synthesizeTimeline } = await import('@/lib/synthesize');
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

  // If multiple matches, use the top one (highest ARR) but mention alternatives
  const account = accounts[0];
  const alternatives = accounts.length > 1
    ? accounts.slice(1).map(a => a.Name).join(', ')
    : null;

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

  // Step 3: If CZ account found, get health score + timeline data
  let czHealthScore: number | null = null;
  let czGrade: string | null = null;
  let czTrend: string | null = null;
  let czSynthesis: string | undefined;

  if (czAccount) {
    const [scoreCalc, scoreFactors, czTasks, czEvents] = await Promise.all([
      getScoreCalculation(czAccount.Id),
      getScoreFactors(czAccount.Id),
      getOpenTasks(czAccount.Id),
      getRecentEvents(account.Id),
    ]);

    if (scoreCalc) {
      czHealthScore = scoreCalc.CurrentScore ?? null;
      czGrade = scoreCalc.Grade ?? null;
      czTrend = scoreCalc.ScoreTrend ?? null;
    }

    // Step 4: AI synthesis of CZ timeline
    czSynthesis = await synthesizeTimeline({
      accountName: account.Name,
      czTasks: czTasks.map(t => ({
        name: t.Name,
        dueDate: t.DueDate,
        status: t.StatusName,
        type: t.TypeName,
      })),
      czEvents: czEvents.map(e => ({
        date: e.EventDate,
        description: e.Description,
        type: e.EventTypeName,
        quantity: e.Quantity,
      })),
      czScore: scoreCalc ? {
        value: scoreCalc.CurrentScore,
        trend: scoreCalc.ScoreTrend,
        grade: scoreCalc.Grade,
      } : null,
      czFactors: scoreFactors.map(f => ({
        name: `Factor ${f.ChurnScoreFactorId}`,
        score: f.CurrentScore,
        impact: f.Impact,
      })),
      czAccount: {
        lastActivity: czAccount.Cf?.LastActivity as string | undefined,
        pageViews30d: czAccount.Cf?.OfPageViewsLast30Days as number | undefined,
        activeAdmins: czAccount.Cf?.ActivePropertyAdmins as number | undefined,
        supportNextAction: czAccount.Cf?.SupportNextAction as string | undefined,
        lastSupportUpdate: czAccount.Cf?.LastSupportUpdateDate as string | undefined,
        lastBusinessReview: czAccount.Cf?.MostRecentBusinessReview as string | undefined,
        cancellationPending: czAccount.Cf?.CancellationPending as boolean | undefined,
        atRisk: czAccount.Cf?.AtRisk as boolean | undefined,
      },
    });
  }

  // Step 5: Compute family ARR if this is a parent account
  let childCount: number | undefined;
  let totalFamilyArr: number | undefined;
  if (children.length > 0) {
    childCount = children.length;
    totalFamilyArr = children.reduce((sum, c) => sum + (c.Active_ARR__c || 0), 0) + (account.Active_ARR__c || 0);
  }

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
    czSynthesis,
    contractTerms: contractTerms ?? undefined,
  });

  const payload = {
    response_type: 'ephemeral' as const,
    ...message,
  };

  // Add alternatives note if multiple matches
  if (alternatives) {
    (payload as Record<string, unknown>).text = `Showing top match. Also found: ${alternatives}`;
  }

  await postToSlack(responseUrl, payload);
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
