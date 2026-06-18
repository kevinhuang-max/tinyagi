/**
 * AI synthesis layer for /brief
 *
 * Uses Claude Haiku to turn the full account picture (Salesforce + ChurnZero)
 * into a CSM-facing narrative: What's happening / What it means / Next steps.
 * Falls back to a deterministic narrative if the model call fails.
 *
 * Dates: relative phrases ("29 months ago", "in 167 days") are precomputed in
 * code via rel() and handed to the model, which is told to use them verbatim.
 * The model is bad at date arithmetic, so we never make it do that.
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export interface BriefNarrativeInput {
  accountName: string;
  arr: number | null;
  tier: string | null;
  status: string | null;
  atRisk: boolean | null;
  csm: string | null;
  contractEnd: string | null;
  autoRenew: boolean | null;
  cancellationNoticeDays: number | null;
  health: { value?: number | null; trend?: string | null } | null;
  opportunities: Array<{ name: string; stage: string; amount: number | null; closeDate: string | null }>;
  cases: Array<{ number: string; subject: string | null; status: string; priority: string | null; createdDate: string | null }>;
  nps: Array<{ score: number | null; grouping: string | null; comment: string | null; date: string | null }>;
  shoots: Array<{ name: string; stage: string | null; date: string | null }>;
  czSignals: {
    usageFrequency?: string;
    nextRenewalDate?: string;
    pageViews30d?: number;
    activeAdmins?: number;
    lastActivity?: string;
    lastBusinessReview?: string;
    supportNextAction?: string;
    cancellationPending?: boolean;
  } | null;
  czTasks: Array<{ name?: string; dueDate?: string; status?: string }>;
  czEvents: Array<{ date?: string; description?: string; type?: string }>;
  today: string;
}

export interface BriefNarrative {
  whatsHappening: string;
  whatItMeans: string;
  nextSteps: string[];
}

// Precompute a human relative-time phrase so the model never does date math.
function rel(dateStr: string | null | undefined, today: string): string {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).slice(0, 10));
  const t = new Date(String(today).slice(0, 10));
  if (isNaN(d.getTime()) || isNaN(t.getTime())) return '';
  const days = Math.round((t.getTime() - d.getTime()) / 86400000);
  const ago = days >= 0;
  const n = Math.abs(days);
  let phrase: string;
  if (n < 45) phrase = `${n} day${n === 1 ? '' : 's'}`;
  else if (n < 365) phrase = `${Math.round(n / 30.44)} months`;
  else phrase = `${(n / 365).toFixed(1)} years`;
  return ago ? `${phrase} ago` : `in ${phrase}`;
}

function withRel(dateStr: string | null | undefined, today: string): string {
  if (!dateStr) return '';
  const date = String(dateStr).slice(0, 10);
  const r = rel(dateStr, today);
  return r ? `${date} (${r})` : date;
}

export async function synthesizeNarrative(input: BriefNarrativeInput): Promise<BriefNarrative> {
  const prompt = buildPrompt(input);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    const raw = block && block.type === 'text' ? block.text.trim() : '';
    const parsed = parseNarrative(raw);
    return parsed ?? fallbackNarrative(input);
  } catch (err) {
    console.error('Synthesis error:', err);
    return fallbackNarrative(input);
  }
}

function buildPrompt(input: BriefNarrativeInput): string {
  const today = input.today;
  const d: string[] = [];
  d.push(`Account: ${input.accountName}`);
  d.push(`ARR: ${input.arr != null ? '$' + input.arr.toLocaleString() : 'N/A'} | Tier: ${input.tier ?? 'N/A'} | Status: ${input.status ?? 'N/A'} | At-risk flag: ${input.atRisk ? 'YES' : 'no'} | CSM: ${input.csm ?? 'Unassigned'}`);
  if (input.contractEnd) {
    d.push(`Contract end: ${withRel(input.contractEnd, today)}${input.autoRenew === null ? '' : input.autoRenew ? ' (auto-renews)' : ' (NO auto-renew)'}${input.cancellationNoticeDays ? ` | Cancellation notice: ${input.cancellationNoticeDays} days` : ''}`);
  }
  if (input.health && input.health.value != null) {
    d.push(`ChurnZero score: ${input.health.value}/100${input.health.trend ? `, trend ${input.health.trend}` : ''} (HIGHER = MORE risk)`);
  }
  if (input.czSignals) {
    const s = input.czSignals;
    const sig: string[] = [];
    if (s.usageFrequency) sig.push(`usage frequency ${s.usageFrequency}`);
    if (s.pageViews30d !== undefined) sig.push(`${s.pageViews30d} page views in last 30 days`);
    if (s.activeAdmins !== undefined) sig.push(`${s.activeAdmins} active property admins`);
    if (s.lastActivity) sig.push(`last activity ${withRel(s.lastActivity, today)}`);
    if (s.lastBusinessReview) sig.push(`last business review ${withRel(s.lastBusinessReview, today)}`);
    if (s.nextRenewalDate) sig.push(`next renewal ${withRel(s.nextRenewalDate, today)}`);
    if (s.supportNextAction) sig.push(`support next action ${withRel(s.supportNextAction, today)}`);
    if (s.cancellationPending) sig.push('CANCELLATION PENDING');
    if (sig.length) d.push(`Engagement signals: ${sig.join('; ')}`);
  }
  if (input.opportunities.length) {
    d.push('Open opportunities:');
    for (const o of input.opportunities) d.push(`  - ${o.name}: ${o.stage}${o.amount != null ? ` (ARR $${o.amount.toLocaleString()})` : ''}${o.closeDate ? `, close ${withRel(o.closeDate, today)}` : ''}`);
  }
  if (input.cases.length) {
    d.push('Open cases:');
    for (const c of input.cases) d.push(`  - #${c.number}: ${c.subject ?? 'no subject'}${c.priority ? ` [${c.priority}]` : ''} (${c.status}${c.createdDate ? `, opened ${withRel(c.createdDate, today)}` : ''})`);
  }
  if (input.nps.length) {
    d.push('Recent NPS:');
    for (const n of input.nps) d.push(`  - ${n.score ?? 'N/A'}/10${n.grouping ? ` (${n.grouping})` : ''}${n.comment ? ` "${n.comment}"` : ''}${n.date ? ` [${withRel(n.date, today)}]` : ''}`);
  }
  if (input.shoots.length) {
    d.push('Recent shoots:');
    for (const s of input.shoots) d.push(`  - ${s.name}: ${s.stage ?? 'unknown'}${s.date ? ` (${withRel(s.date, today)})` : ''}`);
  }
  if (input.czTasks.length) {
    d.push('Open CS tasks:');
    for (const t of input.czTasks) d.push(`  - ${t.name ?? 'task'} (due ${t.dueDate ? withRel(t.dueDate, today) : 'none'}, ${t.status ?? 'open'})`);
  }
  if (input.czEvents.length) {
    d.push('Recent activity:');
    for (const e of input.czEvents) d.push(`  - ${e.date ? withRel(e.date, today) : ''}: ${e.type ?? 'event'} ${e.description ?? ''}`);
  }

  return `You are a CX intelligence assistant for Visiting Media (B2B SaaS, hospitality tech: virtual tours and sales-enablement media). A CSM is about to talk to this hotel account and needs a sharp pre-call brief.

Today is ${today}.

Using ONLY the data below, write three sections for the CSM:
- "whatsHappening": 2 to 3 sentences on the current state. Lead with the single most important fact (contract timing, score trend, usage drop, open high-priority cases). Use real numbers and dates.
- "whatItMeans": 1 to 2 sentences interpreting the signals together. Is this account healthy, at risk, or an expansion opportunity, and why? Connect the dots rather than restating facts. Watch for quiet risk in the data provided (an overdue business review, a stalled or near-term renewal, open high-priority cases) even when the at-risk flag is off. Do NOT comment on platform usage, page views, or active admins - that data is not included here, so never claim the account is unused or abandoned.
- "nextSteps": 2 to 4 specific actions the CSM should take before or on the call. Each must tie to a concrete fact above (a case number, a date, a contract term). No generic advice.

Rules:
- ChurnZero score: HIGHER means MORE churn risk. A rising score is getting WORSE; a falling score is improving. Frame trends accordingly.
- Relative time phrases in parentheses (e.g. "29 months ago", "in 167 days") are PRECOMPUTED and correct. Use them exactly as given. Do NOT recompute or estimate any "X ago" / "in X" values yourself.
- Dollar amounts: quote them EXACTLY as written. Never rescale or add k/M/B suffixes ($759.81 is not $759.8k; $9,117 is not $9.1k).
- Be direct and concrete. Plain language a normal person would use. No jargon, no consultant-speak, no em dashes.
- If data is thin, say what is missing instead of inventing.

Return ONLY valid JSON, no markdown code fences, exactly this shape:
{"whatsHappening":"...","whatItMeans":"...","nextSteps":["...","..."]}

DATA:
${d.join('\n')}`;
}

function parseNarrative(raw: string): BriefNarrative | null {
  if (!raw) return null;
  const text = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const whatsHappening = typeof obj.whatsHappening === 'string' ? obj.whatsHappening.trim() : '';
    const whatItMeans = typeof obj.whatItMeans === 'string' ? obj.whatItMeans.trim() : '';
    const nextSteps = Array.isArray(obj.nextSteps) ? obj.nextSteps.filter((s: unknown) => typeof s === 'string' && s.trim()).map((s: string) => s.trim()) : [];
    if (!whatsHappening || !whatItMeans) return null;
    return { whatsHappening, whatItMeans, nextSteps };
  } catch {
    return null;
  }
}

function fallbackNarrative(input: BriefNarrativeInput): BriefNarrative {
  const happening: string[] = [];
  if (input.health && input.health.value != null) {
    happening.push(`ChurnZero score ${input.health.value}/100${input.health.trend ? `, trend ${input.health.trend}` : ''} (higher = more risk).`);
  }
  if (input.contractEnd) happening.push(`Contract ends ${withRel(input.contractEnd, input.today)}${input.autoRenew === false ? ' with auto-renew off' : ''}.`);
  if (input.czSignals && input.czSignals.pageViews30d !== undefined) happening.push(`${input.czSignals.pageViews30d} page views in 30 days.`);
  if (input.cases.length) happening.push(`${input.cases.length} open case${input.cases.length > 1 ? 's' : ''}.`);
  if (input.opportunities.length) happening.push(`${input.opportunities.length} open opportunit${input.opportunities.length > 1 ? 'ies' : 'y'}.`);

  const steps: string[] = [];
  const p1 = input.cases.find(c => (c.priority || '').toLowerCase().includes('high') || (c.priority || '').includes('1'));
  if (p1) steps.push(`Check status of case #${p1.number} (${p1.subject ?? 'open case'}) before the call.`);
  if (input.autoRenew === false && input.contractEnd) steps.push(`Confirm renewal intent. Contract ends ${withRel(input.contractEnd, input.today)} and auto-renew is off.`);
  if (input.czSignals && input.czSignals.activeAdmins === 0) steps.push('Re-engage the account: zero active property admins on record.');
  if (input.opportunities.length) steps.push(`Review the ${input.opportunities.length} open opportunit${input.opportunities.length > 1 ? 'ies' : 'y'} and confirm next step.`);
  if (!steps.length) steps.push('Confirm the account goals and look for expansion or reference opportunities.');

  return {
    whatsHappening: happening.join(' ') || 'Limited data available for this account. (AI synthesis was unavailable.)',
    whatItMeans: input.atRisk
      ? 'Flagged at risk. Work the open items below before the conversation.'
      : 'No risk flag set, but confirm the engagement signals below before assuming healthy.',
    nextSteps: steps,
  };
}
