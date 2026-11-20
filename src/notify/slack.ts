/** Slack through an incoming webhook, formatted with Block Kit. */
import type { Alert, ChangeSummary, RunReport } from '../report.js';
import { scriptLink } from '../report.js';
import type { Review } from '../state.js';
import type { NotifyEvent, Notifier } from './types.js';
import { hasNews } from './types.js';

type Block = Record<string, unknown>;

export interface SlackMessage {
  text: string;
  blocks: Block[];
}

const MAX_ALERTS = 15;
const MAX_ITEMS = 15;
// Slack rejects section texts over 3000 characters and messages over 50 blocks
const MAX_SECTION = 2900;

export class SlackNotifier implements Notifier {
  readonly name = 'slack';

  constructor(
    private readonly webhookUrl: string,
    private readonly on: NotifyEvent[],
    private readonly post: typeof fetch = fetch,
  ) {}

  async notify(report: RunReport): Promise<boolean> {
    const message = buildSlackMessage(report, this.on);
    if (!message) {
      return false;
    }
    const response = await this.post(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      // Never put the webhook URL into an error message: it is the secret
      const body = (await response.text()).slice(0, 200);
      throw new Error(`Slack answered ${response.status}: ${body}`);
    }
    return true;
  }
}

/** The message for a report, or undefined if nothing in it is subscribed to. */
export function buildSlackMessage(report: RunReport, on: NotifyEvent[]): SlackMessage | undefined {
  if (!hasNews(report, on)) {
    return undefined;
  }
  const alerts = on.includes('alert') ? report.alerts : [];
  const errors = on.includes('error') ? report.errors : [];
  const changes = on.includes('change') ? report.changes : [];

  const blocks: Block[] = [];
  const headline = headlineOf(report, alerts, errors, changes);
  blocks.push({ type: 'header', text: { type: 'plain_text', text: headline.slice(0, 150) } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextLine(report) }] });

  for (const alert of alerts.slice(0, MAX_ALERTS)) {
    blocks.push({ type: 'divider' });
    blocks.push(section(alertText(report, alert)));
  }
  if (alerts.length > MAX_ALERTS) {
    blocks.push(section(`…and ${alerts.length - MAX_ALERTS} more alerts.${siteHint(report)}`));
  }

  if (changes.length > 0) {
    blocks.push({ type: 'divider' });
    const lines = changes.slice(0, MAX_ITEMS).map((change) => changeLine(report, change));
    if (changes.length > MAX_ITEMS) {
      lines.push(`…and ${changes.length - MAX_ITEMS} more.${siteHint(report)}`);
    }
    blocks.push(section(`*Script changes*\n${lines.join('\n')}`));
  }

  if (errors.length > 0) {
    blocks.push({ type: 'divider' });
    const lines = errors.slice(0, MAX_ITEMS).map((error) => `• ${escape(error)}`);
    if (errors.length > MAX_ITEMS) {
      lines.push(`…and ${errors.length - MAX_ITEMS} more.`);
    }
    blocks.push(section(`*Problems during the run*\n${lines.join('\n')}`));
  }

  return { text: headline, blocks: blocks.slice(0, 50) };
}

function headlineOf(
  report: RunReport,
  alerts: Alert[],
  errors: string[],
  changes: ChangeSummary[],
): string {
  const malicious = alerts.some((alert) => alert.review?.verdict === 'malicious');
  if (alerts.length > 0) {
    return `${malicious ? '🚨' : '⚠️'} ${report.title}: ${plural(alerts.length, 'script needs', 'scripts need')} attention`;
  }
  if (changes.length > 0) {
    return `📝 ${report.title}: ${plural(changes.length, 'script changed', 'scripts changed')}`;
  }
  return `🛠️ ${report.title}: ${plural(errors.length, 'problem', 'problems')} during the run`;
}

function contextLine(report: RunReport): string {
  const parts = [
    `${report.stats.pages} pages`,
    `${report.stats.scripts} third-party scripts`,
    `${report.stats.hosts} hosts`,
  ];
  if (report.siteUrl) {
    parts.push(link(report.siteUrl, 'status page'));
  }
  if (report.runUrl) {
    parts.push(link(report.runUrl, 'run log'));
  }
  return parts.join(' · ');
}

function alertText(report: RunReport, alert: Alert): string {
  const lines: string[] = [];
  const title = alert.review ? verdictLabel(alert.review) : '*🆕 NEW HOST*';
  lines.push(`${title} ${link(alert.url, shortUrl(alert.url))}`);
  if (alert.newHost) {
    lines.push(`First script ever loaded from \`${escape(alert.host)}\``);
  }
  if (alert.review) {
    lines.push(escape(alert.review.summary));
    for (const reason of alert.review.reasons) {
      lines.push(`• ${escape(reason)}`);
    }
  } else if (alert.newHost) {
    lines.push('Not reviewed yet.');
  }
  const pages = alert.pages.slice(0, 3).map((page) => link(page, shortUrl(page)));
  if (alert.pages.length > 3) {
    pages.push(`+${alert.pages.length - 3} more`);
  }
  if (pages.length > 0) {
    lines.push(`Pages: ${pages.join(', ')}`);
  }
  const details = scriptLink(report, alert.scriptId);
  if (details) {
    lines.push(link(details, 'Details and history'));
  }
  return lines.join('\n');
}

function changeLine(report: RunReport, change: ChangeSummary): string {
  const target = scriptLink(report, change.scriptId) ?? change.url;
  const verdict = change.review ? ` — ${change.review.verdict}` : '';
  return `• ${change.kind}: ${link(target, shortUrl(change.url))}${verdict}`;
}

function verdictLabel(review: Review): string {
  const confidence = `${Math.round(review.confidence * 100)}%`;
  return review.verdict === 'malicious'
    ? `*🔴 MALICIOUS* (${confidence})`
    : `*🟠 SUSPICIOUS* (${confidence})`;
}

function section(text: string): Block {
  const trimmed = text.length > MAX_SECTION ? `${text.slice(0, MAX_SECTION)}…` : text;
  return { type: 'section', text: { type: 'mrkdwn', text: trimmed } };
}

function siteHint(report: RunReport): string {
  return report.siteUrl ? ` See the ${link(report.siteUrl, 'status page')}.` : '';
}

/** Slack link syntax; the URL must not contain characters that end the link. */
function link(url: string, label: string): string {
  const safeUrl = url.replace(/[<>|]/g, encodeURIComponent);
  return `<${safeUrl}|${escape(label)}>`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const text = `${parsed.host}${parsed.pathname}`;
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  } catch {
    return url.slice(0, 80);
  }
}

/** Slack mrkdwn needs &, < and > escaped; everything else is shown as is. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
