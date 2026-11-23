/**
 * Static status site, generated from the state after every run:
 *
 *   index.html            overview: scripts needing attention, pages, hosts, activity
 *   pages/<id>.html       one audited page: which third-party scripts it runs
 *   scripts/<id>.html     one script: pages, versions, verdicts
 *   data.json             the same data for other tools
 *
 * Plain HTML and CSS, no JavaScript, so it can be hosted anywhere (GitHub/GitLab Pages).
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { matchesAny } from './config.js';
import { shortId } from './script-key.js';
import type {
  HistoryEvent,
  PageRecord,
  Review,
  ScriptRecord,
  ScriptVersion,
  State,
} from './state.js';
import { VERDICT_RANK } from './state.js';

/** Everything buildSite writes; it only ever deletes these. */
const SITE_ENTRIES = new Set(['index.html', 'pages', 'scripts', 'data.json', '.nojekyll']);

export async function buildSite(state: State, config: Config, outDir: string): Promise<void> {
  await clearSite(outDir);
  await mkdir(join(outDir, 'pages'), { recursive: true });
  await mkdir(join(outDir, 'scripts'), { recursive: true });
  const site = new SiteModel(state, config);

  await writeFile(join(outDir, 'index.html'), renderIndex(site));
  for (const page of site.pages) {
    await writeFile(join(outDir, 'pages', `${pageId(page.url)}.html`), renderPage(site, page));
  }
  for (const script of site.scripts) {
    await writeFile(
      join(outDir, 'scripts', `${scriptId(script.key)}.html`),
      renderScript(site, script),
    );
  }
  await writeFile(join(outDir, 'data.json'), `${JSON.stringify(exportData(site), null, 1)}\n`);
  // GitHub Pages would otherwise run the files through Jekyll
  await writeFile(join(outDir, '.nojekyll'), '');
}

export const pageId = (url: string) => shortId(url);
export const scriptId = (key: string) => shortId(key);

class SiteModel {
  readonly pages: PageRecord[];
  readonly scripts: ScriptRecord[];

  constructor(
    readonly state: State,
    readonly config: Config,
  ) {
    const order = new Map(config.pages.map((page, index) => [page.url, index]));
    this.pages = Object.values(state.pages).sort(
      (a, b) => (order.get(a.url) ?? 1e9) - (order.get(b.url) ?? 1e9),
    );
    this.scripts = Object.values(state.scripts).sort((a, b) => a.key.localeCompare(b.key));
  }

  get title(): string {
    return this.config.site.title;
  }

  /** Review of the script's current version, if it has one. */
  currentReview(script: ScriptRecord): Review | undefined {
    const version = currentVersion(script);
    return version?.reviewKey ? this.state.reviews[version.reviewKey] : undefined;
  }

  isPending(script: ScriptRecord): boolean {
    return this.state.pending.some(
      (item) => item.key === script.key && item.newSha256 === script.sha256,
    );
  }

  /** Scripts whose current version could not be reviewed. */
  reviewFailures(): ScriptRecord[] {
    return this.scripts.filter((script) => currentVersion(script)?.reviewFailed);
  }

  /** Scripts whose current version is flagged. */
  attention(): ScriptRecord[] {
    const min = VERDICT_RANK[this.config.alerts.minVerdict];
    return this.scripts
      .filter((script) => {
        const review = this.currentReview(script);
        return review && VERDICT_RANK[review.verdict] >= min;
      })
      .sort((a, b) => b.lastChanged.localeCompare(a.lastChanged));
  }

  scriptsOf(page: PageRecord): ScriptRecord[] {
    return page.scriptKeys
      .map((key) => this.state.scripts[key])
      .filter((script): script is ScriptRecord => script !== undefined);
  }

  isQuiet(host: string): boolean {
    return matchesAny(host, this.config.hosts.quiet);
  }
}

// ---------------------------------------------------------------------------------------
// Pages

function renderIndex(site: SiteModel): string {
  const { state } = site;
  const attention = site.attention();
  const failedPages = site.pages.filter((page) => page.error);
  const failedReviews = site.reviewFailures();
  const hosts = Object.entries(state.hosts)
    .map(([host, record]) => ({
      host,
      record,
      scripts: site.scripts.filter((script) => script.host === host),
    }))
    .filter((entry) => entry.scripts.length > 0)
    .sort((a, b) => b.scripts.length - a.scripts.length || a.host.localeCompare(b.host));

  const status =
    attention.length > 0
      ? badge('alert', `${attention.length} need${attention.length === 1 ? 's' : ''} attention`)
      : failedReviews.length > 0
        ? badge(
            'warn',
            `${failedReviews.length} review${failedReviews.length === 1 ? '' : 's'} failed`,
          )
        : failedPages.length > 0 ||
            (state.lastRun?.consentConfigured && !state.lastRun.consentAccepted)
          ? badge('warn', 'run had problems')
          : badge('ok', 'no findings');

  const body = `
<header>
  <h1>${esc(site.title)}</h1>
  <p class="muted">Third-party JavaScript on ${site.pages.length} pages, checked ${state.runs} times.
  Last run ${state.lastRun ? time(state.lastRun.finishedAt) : 'never'}. ${status}</p>
</header>
${consentWarning(site)}
<section class="cards">
  ${card('Pages', String(site.pages.length))}
  ${card('Third-party scripts', String(site.scripts.length))}
  ${card('Hosts', String(hosts.length))}
  ${card('Reviews waiting', String(state.pending.length))}
</section>

<h2>Needs attention</h2>
${
  attention.length === 0
    ? '<p class="muted">No script is flagged.</p>'
    : table(
        ['Script', 'Verdict', 'Summary', 'Changed'],
        attention.map((script) => {
          const review = site.currentReview(script)!;
          return [
            scriptLink(script, '.'),
            verdictBadge(review),
            esc(review.summary),
            time(script.lastChanged),
          ];
        }),
      )
}

<h2>Pages</h2>
${table(
  ['Page', 'Scripts', 'Hosts', 'Last scanned', ''],
  site.pages.map((page) => {
    const scripts = site.scriptsOf(page);
    const flagged = scripts.filter((script) => attention.includes(script)).length;
    return [
      `<a href="pages/${pageId(page.url)}.html">${esc(page.name)}</a><div class="muted small">${esc(page.url)}</div>`,
      String(scripts.length),
      String(new Set(scripts.map((script) => script.host)).size),
      time(page.lastScanned),
      page.error ? badge('warn', 'error') : flagged > 0 ? badge('alert', `${flagged} flagged`) : '',
    ];
  }),
)}

<h2>Hosts</h2>
${table(
  ['Host', 'Scripts', 'Pages', 'First seen'],
  hosts.map(({ host, record, scripts }) => [
    `${esc(host)}${site.isQuiet(host) ? ' <span class="muted small">(quiet)</span>' : ''}`,
    String(scripts.length),
    String(new Set(scripts.flatMap((script) => script.pages)).size),
    time(record.firstSeen),
  ]),
)}

<h2>Activity</h2>
${activity(site, state.history.slice(-100).reverse(), '.')}
`;
  return layout(site.title, body);
}

function renderPage(site: SiteModel, page: PageRecord): string {
  const scripts = site.scriptsOf(page);
  const byHost = new Map<string, ScriptRecord[]>();
  for (const script of scripts) {
    byHost.set(script.host, [...(byHost.get(script.host) ?? []), script]);
  }
  const groups = [...byHost.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = `
<p><a href="../index.html">← ${esc(site.title)}</a></p>
<header>
  <h1>${esc(page.name)}</h1>
  <p><a href="${esc(page.url)}" rel="noreferrer noopener">${esc(page.url)}</a>
  ${page.finalUrl ? `<br><span class="muted">redirects to ${esc(page.finalUrl)}</span>` : ''}</p>
  <p class="muted">Scanned ${time(page.lastScanned)}: ${scripts.length} third-party scripts from ${groups.length} hosts.</p>
</header>
${page.error ? `<p class="notice warn">The last scan failed: ${esc(page.error)}</p>` : ''}
${groups
  .map(
    ([host, hostScripts]) => `
<h2>${esc(host)}${site.isQuiet(host) ? ' <span class="muted small">(quiet host)</span>' : ''}</h2>
${table(
  ['Script', 'Size', 'Last changed', 'Review'],
  hostScripts.map((script) => [
    scriptLink(script, '..'),
    size(script.size),
    time(script.lastChanged),
    reviewCell(site, script),
  ]),
)}`,
  )
  .join('\n')}
`;
  return layout(`${page.name} – ${site.title}`, body);
}

function renderScript(site: SiteModel, script: ScriptRecord): string {
  const pages = site.pages.filter((page) => page.scriptKeys.includes(script.key));
  const versions = [...script.versions].reverse();
  const history = site.state.history.filter((event) => event.key === script.key).reverse();
  const body = `
<p><a href="../index.html">← ${esc(site.title)}</a></p>
<header>
  <h1 class="break">${esc(script.key)}</h1>
  <p class="muted">Host ${esc(script.host)}${site.isQuiet(script.host) ? ' (quiet)' : ''} ·
  first seen ${time(script.firstSeen)} · last seen ${time(script.lastSeen)} ·
  last changed ${time(script.lastChanged)}</p>
  <p class="small break">Loaded from <code>${esc(script.url)}</code></p>
  <p>${reviewCell(site, script)}</p>
</header>

<h2>Runs on ${pages.length} page${pages.length === 1 ? '' : 's'}</h2>
${
  pages.length === 0
    ? '<p class="muted">Not seen on any page in the last run.</p>'
    : `<ul>${pages.map((page) => `<li><a href="../pages/${pageId(page.url)}.html">${esc(page.name)}</a></li>`).join('')}</ul>`
}

<h2>Versions</h2>
${versions
  .map((version) => {
    const review = version.reviewKey ? site.state.reviews[version.reviewKey] : undefined;
    return `
<article class="version">
  <p>${review ? verdictBadge(review) : badge('muted', 'not reviewed')}
  <strong>${time(version.firstSeen)}</strong> to ${time(version.lastSeen)} · ${size(version.size)} ·
  <code title="${esc(version.sha256)}">${esc(version.sha256.slice(0, 12))}</code></p>
  ${
    review
      ? `<p>${esc(review.summary)}</p>${
          review.reasons.length
            ? `<ul>${review.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`
            : ''
        }<p class="muted small">${esc(review.provider)} / ${esc(review.model)}, ${Math.round(review.confidence * 100)}% confidence, ${time(review.reviewedAt)}</p>`
      : ''
  }
</article>`;
  })
  .join('\n')}

<h2>History</h2>
${activity(site, history, '..')}
`;
  return layout(`${script.key} – ${site.title}`, body);
}

function consentWarning(site: SiteModel): string {
  const run = site.state.lastRun;
  if (!run?.consentConfigured || run.consentAccepted) {
    return '';
  }
  return `<p class="notice warn">The consent button was not found in the last run, so scripts that only load after consent were not checked.</p>`;
}

function activity(site: SiteModel, events: HistoryEvent[], root: string): string {
  if (events.length === 0) {
    return '<p class="muted">Nothing yet.</p>';
  }
  return table(
    ['When', 'What', ''],
    events.map((event) => [time(event.at), eventLabel(event), eventDetail(site, event, root)]),
  );
}

function eventLabel(event: HistoryEvent): string {
  switch (event.type) {
    case 'reviewed':
      return event.verdict ? verdictBadge({ verdict: event.verdict }) : 'reviewed';
    case 'error':
      return badge('warn', 'error');
    case 'new-host':
      return badge('info', 'new host');
    case 'new-script':
      return badge('info', 'new script');
    case 'changed':
      return badge('info', 'changed');
    case 'removed':
      return badge('muted', 'removed');
    case 'baseline':
      return badge('muted', 'baseline');
    case 'review-skipped':
      return badge('muted', 'not reviewed');
  }
}

function eventDetail(site: SiteModel, event: HistoryEvent, root: string): string {
  const parts: string[] = [];
  const script = event.key ? site.state.scripts[event.key] : undefined;
  if (script) {
    parts.push(scriptLink(script, root));
  } else if (event.url) {
    parts.push(`<span class="break">${esc(event.url)}</span>`);
  } else if (event.host) {
    parts.push(esc(event.host));
  }
  if (event.page) {
    parts.push(esc(event.page));
  }
  if (event.message) {
    parts.push(`<span class="muted">${esc(event.message)}</span>`);
  }
  return parts.join('<br>');
}

/**
 * Removes the previous site. Refuses a directory holding anything else, such as the audit
 * data or a docs folder, rather than deleting it.
 */
async function clearSite(outDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const foreign = entries.filter((entry) => !SITE_ENTRIES.has(entry));
  if (foreign.length > 0) {
    const listed = foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? ', ...' : '');
    throw new Error(
      `The site directory ${outDir} contains files the status site did not write (${listed}). Use an empty or new directory for the site.`,
    );
  }
  for (const entry of entries) {
    await rm(join(outDir, entry), { recursive: true, force: true });
  }
}

function reviewCell(site: SiteModel, script: ScriptRecord): string {
  const review = site.currentReview(script);
  const perRequest = script.perRequest ? ` ${badge('muted', 'generated per request')}` : '';
  if (review) {
    return `${verdictBadge(review)}${perRequest} <span class="small">${esc(review.summary)}</span>`;
  }
  const failed = currentVersion(script)?.reviewFailed;
  if (failed) {
    return `${badge('warn', 'review failed')}${perRequest} <span class="small">${esc(failed.message)}</span>`;
  }
  if (site.isPending(script)) {
    return `${badge('muted', 'review queued')}${perRequest}`;
  }
  // Recorded by the baseline, while the LLM was off, or as a per-request variant
  return `${badge('muted', 'not reviewed')}${perRequest}`;
}

function currentVersion(script: ScriptRecord): ScriptVersion | undefined {
  return script.versions.findLast((candidate) => candidate.sha256 === script.sha256);
}

function scriptLink(script: ScriptRecord, root: string): string {
  const path = script.key.replace(/^https?:\/\/[^/]+/, '');
  return `<a class="break" href="${root}/scripts/${scriptId(script.key)}.html">${esc(script.host)}<span class="muted">${esc(path)}</span></a>`;
}

// ---------------------------------------------------------------------------------------
// Building blocks

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<footer class="muted small">Generated by script-auditor.</footer>
</body>
</html>
`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return '<p class="muted">Nothing yet.</p>';
  }
  return `<div class="table"><table>
<thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></div>`;
}

function card(label: string, value: string): string {
  return `<div class="card"><div class="value">${esc(value)}</div><div class="muted">${esc(label)}</div></div>`;
}

function badge(kind: 'ok' | 'warn' | 'alert' | 'info' | 'muted', text: string): string {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function verdictBadge(review: Pick<Review, 'verdict'>): string {
  const kind =
    review.verdict === 'benign' ? 'ok' : review.verdict === 'suspicious' ? 'warn' : 'alert';
  return badge(kind, review.verdict);
}

function time(iso: string | undefined): string {
  if (!iso) {
    return '–';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return esc(iso);
  }
  const text = `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `<time datetime="${esc(iso)}">${text}</time>`;
}

function size(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function exportData(site: SiteModel) {
  return {
    title: site.title,
    generatedAt: site.state.updatedAt,
    lastRun: site.state.lastRun ?? null,
    pages: site.pages.map((page) => ({ ...page, id: pageId(page.url) })),
    scripts: site.scripts.map((script) => ({
      id: scriptId(script.key),
      key: script.key,
      url: script.url,
      host: script.host,
      sha256: script.sha256,
      size: script.size,
      firstSeen: script.firstSeen,
      lastSeen: script.lastSeen,
      lastChanged: script.lastChanged,
      pages: script.pages,
      review: site.currentReview(script) ?? null,
    })),
    hosts: site.state.hosts,
  };
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1d2024; --muted: #5f6670; --line: #e3e6ea; --card: #f6f7f9;
  --ok: #1a7f37; --ok-bg: #dafbe1; --warn: #9a6700; --warn-bg: #fff8c5;
  --alert: #cf222e; --alert-bg: #ffebe9; --info: #0969da; --info-bg: #ddf4ff;
  --link: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e6e8eb; --muted: #9aa3ad; --line: #2a2f36; --card: #171a20;
    --ok: #4ac26b; --ok-bg: #12261a; --warn: #d4a72c; --warn-bg: #2b2411;
    --alert: #ff7b72; --alert-bg: #33161a; --info: #58a6ff; --info-bg: #11233a;
    --link: #58a6ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main, footer { max-width: 1100px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.6rem; margin: 0.5rem 0; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 0.85em ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--muted); }
.small { font-size: 0.85em; }
.break { overflow-wrap: anywhere; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 1rem 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.card .value { font-size: 1.6rem; font-weight: 600; }
.table { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--line); }
th { font-weight: 600; color: var(--muted); font-size: 0.85em; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.8em; font-weight: 600; white-space: nowrap; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.alert { color: var(--alert); background: var(--alert-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
.badge.muted { color: var(--muted); background: var(--card); }
.notice { padding: 10px 14px; border-radius: 8px; }
.notice.warn { color: var(--warn); background: var(--warn-bg); }
.version { border: 1px solid var(--line); border-radius: 8px; padding: 4px 16px; margin: 12px 0; }
footer { border-top: 1px solid var(--line); }
`;
