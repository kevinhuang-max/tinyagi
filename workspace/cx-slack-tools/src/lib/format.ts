/**
 * Slack Block Kit formatter for /brief output
 *
 * Leads with the AI narrative (What's happening / What it means / Next steps)
 * and collapses the supporting Salesforce/ChurnZero facts into one Details line.
 */

import type { SFAccount, SFOpportunity, SFCase, SFNps, SFShoot, SFLicense } from './supabase';
import type { ContractTerms } from './contract-terms';
import type { BriefNarrative } from './synthesize';
import type { PropertyUsage } from './tinybird';

interface BriefData {
  account: SFAccount;
  csmName?: string | null;
  childCount?: number;
  totalFamilyArr?: number;
  opportunities: SFOpportunity[];
  cases: SFCase[];
  nps: SFNps[];
  shoots: SFShoot[];
  licenses: SFLicense[];
  czHealthScore?: number | null;
  czTrend?: string | null;
  contractEnd?: string | null;
  usage?: PropertyUsage | null;
  narrative: BriefNarrative;
  contractTerms?: ContractTerms;
}

export function formatBrief(data: BriefData): object {
  const { account, narrative } = data;
  const blocks: object[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: truncate(account.Name, 150), emoji: false },
  });

  const arr = account.Active_ARR__c ? `$${account.Active_ARR__c.toLocaleString()} ARR` : 'ARR N/A';
  const risk = account.At_Risk__c ? ':red_circle: At Risk' : ':large_green_circle: Not flagged';
  let topline = `*${arr}*  ·  ${risk}`;
  if (data.childCount && data.childCount > 0 && data.totalFamilyArr) {
    topline += `  ·  Family: ${data.childCount} properties, $${data.totalFamilyArr.toLocaleString()}`;
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: topline } });

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*What's happening*\n${narrative.whatsHappening}` } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*What it means*\n${narrative.whatItMeans}` } });

  if (narrative.nextSteps && narrative.nextSteps.length > 0) {
    const steps = narrative.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Next steps*\n${steps}` } });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: buildDetails(data) }] });

  return { blocks };
}

function buildDetails(data: BriefData): string {
  const { account } = data;
  const parts: string[] = [];

  parts.push(`CSM: ${data.csmName || account.Support_Rep__c || 'Unassigned'}`);
  if (account.Account_Tier__c) parts.push(`Tier ${account.Account_Tier__c}`);
  if (account.Property_Status__c) parts.push(account.Property_Status__c);

  if (data.czHealthScore !== undefined && data.czHealthScore !== null) {
    const trend = data.czTrend ? `, ${data.czTrend}` : '';
    parts.push(`CZ score ${data.czHealthScore}/100${trend} (higher = more risk)`);
  }

  const ct = data.contractTerms;
  const contractEnd = data.contractEnd || ct?.contract_end || account.Subscription_End_Date__c;
  if (contractEnd) {
    let c = `Contract ends ${contractEnd}`;
    if (ct && ct.auto_renewal !== null && ct.auto_renewal !== undefined) {
      c += ct.auto_renewal ? ', auto-renews' : ', no auto-renew';
    }
    parts.push(c);
  }

  if (data.nps.length > 0) {
    const n = data.nps[0];
    parts.push(`NPS ${n.Net_Promoter_Score__c ?? 'N/A'}/10${n.NPS_Grouping__c ? ` ${n.NPS_Grouping__c}` : ''}`);
  }

  if (data.opportunities.length > 0) parts.push(`${data.opportunities.length} open opp${data.opportunities.length > 1 ? 's' : ''}`);
  if (data.cases.length > 0) parts.push(`${data.cases.length} open case${data.cases.length > 1 ? 's' : ''}`);

  if (data.shoots.length > 0) {
    const s = data.shoots[0];
    parts.push(`Last shoot ${s.Shoot_Date__c || 'TBD'}${s.Shoot_Stage__c ? ` (${s.Shoot_Stage__c})` : ''}`);
  }

  if (data.licenses.length > 0) {
    const licTypes = new Map<string, number>();
    for (const l of data.licenses) {
      const t = l.License_Type__c || 'Other';
      licTypes.set(t, (licTypes.get(t) || 0) + 1);
    }
    parts.push('Licenses: ' + Array.from(licTypes.entries()).map(([t, c]) => `${t} ${c}`).join(', '));
  }

  if (data.usage) {
    const t = data.usage.trendPct != null ? ' (' + (data.usage.trendPct >= 0 ? '+' : '') + data.usage.trendPct + '%)' : '';
    parts.push(data.usage.pageViews30d + ' views/30d' + t);
  }
  if (account.Region__c) parts.push(account.Region__c);
  if (account.Billing_Status__c) parts.push(`Billing ${account.Billing_Status__c}`);
  parts.push(`ID ${account.Id}`);

  return parts.join('  ·  ');
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
