/**
 * Status section for a README, between two marker comments:
 *
 *   <!-- script-auditor:start -->
 *   <!-- script-auditor:end -->
 *
 * Shows only what needs a human: flagged scripts, failed reviews, pages that could not be
 * scanned. It holds no timestamps or counters, so it only changes, and is only committed,
 * when the findings change.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { scriptId, SiteModel } from './site.js';
import type { State, Verdict } from './state.js';
import { VERDICT_RANK } from './state.js';

export const README_START = '<!-- script-auditor:start -->';
export const README_END = '<!-- script-auditor:end -->';

const VERDICT_ICON: Record<Verdict, string> = { malicious: '🔴', suspicious: '🟠', benign: '⚪' };
const MAX_PAGES = 3;

export function renderReadmeSection(state: State, config: Config): string {
  const site = new SiteModel(state, config);
  const siteUrl = config.site.url?.replace(/\/$/, '');
  const attention = site
    .attention()
    .map((script) => ({ script, review: site.currentReview(script)! }))
    .sort(
      (a, b) =>
        VERDICT_RANK[b.review.verdict] - VERDICT_RANK[a.review.verdict] ||
        a.script.key.localeCompare(b.script.key),
    );
  const failedReviews = site.reviewFailures();
  const failedPages = site.pages.filter((page) => page.error);
  const consentFailed = state.lastRun?.consentConfigured && !state.lastRun.consentAccepted;

  const lines: string[] = [];
  if (attention.length > 0) {
    const count = attention.length;
    lines.push(`🔴 **${count} script${count === 1 ? ' needs' : 's need'} attention**`);
    // A list rather than a table: GitHub cannot wrap a long script URL in a table cell, so
    // the other columns get squeezed to a few letters
    for (const { script, review } of attention) {
      const pages = script.pages.map((url) => state.pages[url]?.name ?? url);
      const pageList =
        pages
          .slice(0, MAX_PAGES)
          .map((name) => text(name))
          .join(', ') + (pages.length > MAX_PAGES ? ` and ${pages.length - MAX_PAGES} more` : '');
      const details = siteUrl
        ? ` ([details](${siteUrl}/scripts/${scriptId(script.key)}.html))`
        : '';
      // A backslash at the end of a line is a line break
      lines.push(
        '',
        `- ${VERDICT_ICON[review.verdict]} **${review.verdict}** ${code(script.key)}${details}\\`,
        `  Pages: ${pageList}\\`,
        `  ${text(review.summary, 400)}`,
      );
    }
  } else if (state.runs === 0) {
    lines.push('⚪ **Not audited yet**');
  } else {
    lines.push('🟢 **No findings**: no third-party script is flagged.');
  }

  const problems: string[] = [];
  if (failedReviews.length > 0) {
    problems.push(
      `- Review failed for ${failedReviews.map((script) => code(script.key)).join(', ')}`,
    );
  }
  if (failedPages.length > 0) {
    problems.push(
      `- Could not be scanned in the last run: ${failedPages.map((page) => text(page.name)).join(', ')}`,
    );
  }
  if (consentFailed) {
    problems.push('- The consent banner was not accepted in the last run');
  }
  if (problems.length > 0) {
    lines.push('');
    lines.push('🟠 **Problems**');
    lines.push('');
    lines.push(...problems);
  }

  if (siteUrl) {
    lines.push('');
    lines.push(`[Status site](${siteUrl})`);
  }
  return lines.join('\n');
}

export type ReadmeResult = 'updated' | 'unchanged' | 'no-markers';

/** Replaces what is between the markers in `file` with `section`. */
export async function updateReadme(file: string, section: string): Promise<ReadmeResult> {
  const content = await readFile(file, 'utf8');
  const start = content.indexOf(README_START);
  const end = content.indexOf(README_END, start + README_START.length);
  if (start === -1 || end === -1) {
    return 'no-markers';
  }
  const updated =
    content.slice(0, start + README_START.length) + `\n${section}\n` + content.slice(end);
  if (updated === content) {
    return 'unchanged';
  }
  await writeFile(file, updated);
  return 'updated';
}

/**
 * Script URLs, page names and the model's summaries are untrusted: a compromised script
 * could steer the review text. Markdown and HTML characters become entities so they render
 * as text, and a word joiner after "@" keeps GitHub from turning it into a mention.
 */
function text(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const short = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return short
    .replace(/[&<>[\]()`*_~|\\#!:.]/g, (char) => `&#${char.charCodeAt(0)};`)
    .replace(/@/g, '@⁠');
}

/** A code span: nothing inside is rendered, and a backtick cannot close it early. */
function code(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').replace(/`/g, "'");
  return `\`${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}\``;
}
