/** One audit run: crawl, detect, review, save, build the site, notify. */
import type { Config } from './config.js';
import type { CrawlOptions, Crawler, CrawlResult } from './crawl.js';
import { crawl as defaultCrawler, shortError } from './crawl.js';
import type { Detection } from './detect.js';
import { applyCrawl } from './detect.js';
import { log } from './log.js';
import type { Notifier } from './notify/index.js';
import type { Alert, ChangeSummary, RunReport } from './report.js';
import type { QueueResult } from './review/queue.js';
import { enqueue, processQueue, pruneReviews } from './review/queue.js';
import type { Reviewer } from './review/types.js';
import { buildSite, scriptId } from './site.js';
import type { Review, State } from './state.js';
import { DataStore, reviewKeyFor, VERDICT_RANK } from './state.js';

export interface RunOptions {
  config: Config;
  dataDir: string;
  /** Where to write the status site; skipped if undefined or disabled in the config. */
  siteDir?: string;
  reviewer?: Reviewer;
  notifiers?: Notifier[];
  crawler?: Crawler;
  crawlOptions?: CrawlOptions;
  /** Link to the CI run, shown in notifications. */
  runUrl?: string;
  now?: () => Date;
}

export interface RunOutcome {
  report: RunReport;
  /** Names of the notifiers that sent something. */
  notified: string[];
  /** Notifiers that failed; the run itself still succeeded. */
  notifyErrors: string[];
}

export async function runAudit(options: RunOptions): Promise<RunOutcome> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const store = new DataStore(options.dataDir);
  const state = await store.load(now());

  const crawl = await (options.crawler ?? defaultCrawler)(config, options.crawlOptions);
  // A run that saw no page must not change the state: it would use up the baseline, or
  // forget scripts and report them all as new once the site is reachable again
  assertSomePageScanned(crawl);
  const detection = await applyCrawl(state, crawl, config, store, now());
  log.info(
    detection.baseline
      ? `Baseline: ${Object.keys(state.scripts).length} scripts from ${Object.keys(state.hosts).length} hosts`
      : `${detection.changes.length} changes, ${detection.newHosts.length} new hosts, ${detection.absorbed} variants absorbed`,
  );

  let queue: QueueResult = { reviewed: [], errors: [], remaining: state.pending.length };
  if (options.reviewer) {
    const at = now().toISOString();
    enqueue(state, detection.changes, at);
    if (config.llm.reviewBaseline) {
      enqueue(state, unreviewedScripts(state), at);
    }
    queue = await processQueue(state, store, options.reviewer, config, now());
  }

  const finishedAt = now().toISOString();
  state.runs++;
  state.updatedAt = finishedAt;
  state.lastRun = {
    startedAt: crawl.startedAt,
    finishedAt,
    consentConfigured: crawl.consentConfigured,
    consentAccepted: crawl.consentAccepted,
  };
  pruneReviews(state, now());
  await store.save(state);
  await store.pruneBlobs(state);

  const report = buildReport(state, crawl, detection, queue, config, options.runUrl, finishedAt);

  if (options.siteDir && config.site.enabled) {
    await buildSite(state, config, options.siteDir);
    log.info(`Status site written to ${options.siteDir}`);
  }

  const outcome: RunOutcome = { report, notified: [], notifyErrors: [] };
  for (const notifier of options.notifiers ?? []) {
    try {
      if (await notifier.notify(report)) {
        outcome.notified.push(notifier.name);
      }
    } catch (error) {
      const message = `${notifier.name}: ${shortError(error)}`;
      log.error(`Notification failed: ${message}`);
      outcome.notifyErrors.push(message);
    }
  }
  return outcome;
}

export function assertSomePageScanned(crawl: CrawlResult): void {
  if (crawl.pages.length === 0 || crawl.pages.some((page) => !page.error)) {
    return;
  }
  const errors = crawl.pages.slice(0, 3).map((page) => `${page.url}: ${page.error}`);
  const more = crawl.pages.length > 3 ? ` (and ${crawl.pages.length - 3} more)` : '';
  throw new Error(
    `None of the ${crawl.pages.length} pages could be scanned, the audit data is left unchanged. ${errors.join('; ')}${more}`,
  );
}

/**
 * Scripts none of whose versions was ever reviewed, as new ones, for `llm.reviewBaseline`.
 * Covers the baseline of the first run and scripts recorded before the option was turned
 * on. Per-request scripts are left out: their body differs on every run. So are scripts
 * whose review failed for good: retrying them on every run would only repeat the error.
 */
export function unreviewedScripts(state: State): Detection['changes'] {
  const unreviewed = Object.values(state.scripts).filter(
    (script) =>
      !script.perRequest &&
      !script.versions.some((version) => version.reviewKey || version.reviewFailed),
  );
  return unreviewed.map((script) => ({
    kind: 'new' as const,
    key: script.key,
    url: script.url,
    host: script.host,
    newSha256: script.sha256,
    pages: script.pages,
    newHost: false,
    quietHost: false,
  }));
}

export function buildReport(
  state: State,
  crawl: CrawlResult,
  detection: Detection,
  queue: QueueResult,
  config: Config,
  runUrl: string | undefined,
  finishedAt: string,
): RunReport {
  const minRank = VERDICT_RANK[config.alerts.minVerdict];
  const reviewsByKey = new Map<string, Review>();
  for (const { item, review } of queue.reviewed) {
    reviewsByKey.set(item.reviewKey, review);
  }

  const alerts = new Map<string, Alert>();
  for (const { item, review } of queue.reviewed) {
    if (VERDICT_RANK[review.verdict] >= minRank) {
      alerts.set(item.key, {
        key: item.key,
        url: item.url,
        host: item.host,
        pages: item.pages,
        scriptId: scriptId(item.key),
        newHost: item.newHost,
        review,
      });
    }
  }
  if (config.alerts.newHosts) {
    for (const change of detection.changes) {
      if (!change.newHost || change.quietHost || alerts.has(change.key)) {
        continue;
      }
      const review = reviewsByKey.get(reviewKeyFor(change.newSha256, change.oldSha256));
      alerts.set(change.key, {
        key: change.key,
        url: change.url,
        host: change.host,
        pages: change.pages,
        scriptId: scriptId(change.key),
        newHost: true,
        ...(review ? { review } : {}),
      });
    }
  }

  const changes: ChangeSummary[] = detection.changes.map((change) => {
    const review = reviewsByKey.get(reviewKeyFor(change.newSha256, change.oldSha256));
    return {
      kind: change.kind,
      url: change.url,
      host: change.host,
      scriptId: scriptId(change.key),
      ...(review ? { review } : {}),
    };
  });

  const errors: string[] = [];
  for (const page of crawl.pages) {
    if (page.error) {
      errors.push(`Could not scan ${page.url}: ${page.error}`);
    }
  }
  if (crawl.consentConfigured && !crawl.consentAccepted) {
    errors.push(
      `The consent button (${config.consent.selector}) was not found, so scripts that only load after consent were not audited.`,
    );
  }
  errors.push(...queue.errors);

  return {
    title: config.site.title,
    ...(config.site.url ? { siteUrl: config.site.url } : {}),
    ...(runUrl ? { runUrl } : {}),
    startedAt: crawl.startedAt,
    finishedAt,
    baseline: detection.baseline,
    stats: {
      pages: crawl.pages.length,
      pagesFailed: crawl.pages.filter((page) => page.error).length,
      scripts: Object.keys(state.scripts).length,
      hosts: new Set(Object.values(state.scripts).map((script) => script.host)).size,
      changes: detection.changes.length,
      absorbed: detection.absorbed,
      reviewed: queue.reviewed.length,
      pendingReviews: queue.remaining,
    },
    alerts: [...alerts.values()],
    changes,
    errors,
  };
}
