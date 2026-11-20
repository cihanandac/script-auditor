/** Markdown summary of a run, for the terminal and the CI job summary. */
import type { RunReport } from './report.js';
import { scriptLink } from './report.js';

export function formatSummary(report: RunReport): string {
  const { stats } = report;
  const lines: string[] = [];
  lines.push(`## ${report.title}`);
  lines.push('');
  if (report.baseline) {
    lines.push(
      'First run: every script found was recorded as the starting point. Changes from now on are reviewed.',
    );
    lines.push('');
  }
  lines.push(
    '| Pages | Failed | Third-party scripts | Hosts | Changes | Reviewed | Reviews waiting |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(
    `| ${stats.pages} | ${stats.pagesFailed} | ${stats.scripts} | ${stats.hosts} | ${stats.changes} | ${stats.reviewed} | ${stats.pendingReviews} |`,
  );
  lines.push('');
  if (report.alerts.length > 0) {
    lines.push(`### Alerts (${report.alerts.length})`);
    for (const alert of report.alerts) {
      const verdict = alert.review ? `**${alert.review.verdict}**` : '**new host**';
      const details = scriptLink(report, alert.scriptId);
      lines.push(
        `- ${verdict} ${md(alert.url)}${alert.newHost ? ` (new host ${md(alert.host)})` : ''}${
          alert.review ? `: ${md(alert.review.summary)}` : ''
        }${details ? ` ([details](${details}))` : ''}`,
      );
    }
    lines.push('');
  }
  if (report.changes.length > 0) {
    lines.push(`### Changes (${report.changes.length})`);
    for (const change of report.changes.slice(0, 50)) {
      lines.push(
        `- ${change.kind}: ${md(change.url)}${change.review ? ` – ${change.review.verdict}` : ''}`,
      );
    }
    if (report.changes.length > 50) {
      lines.push(`- …and ${report.changes.length - 50} more`);
    }
    lines.push('');
  }
  if (report.errors.length > 0) {
    lines.push(`### Problems (${report.errors.length})`);
    for (const error of report.errors) {
      lines.push(`- ${md(error)}`);
    }
    lines.push('');
  }
  if (report.siteUrl) {
    lines.push(`Status site: ${report.siteUrl}`);
  }
  return lines.join('\n');
}

/** Backticks keep URLs and model text from being rendered as markdown or HTML. */
function md(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}
