/**
 * Reviews wait in a queue that survives between runs. A run reviews at most
 * `llm.maxReviewsPerRun` scripts, so a vendor that ships a hundred new chunk files at once
 * costs a bounded amount per run instead of failing the run or the budget.
 */
import { analyze } from '../analyze.js';
import type { Config } from '../config.js';
import { shortError } from '../crawl.js';
import type { Change } from '../detect.js';
import { appendHistory } from '../detect.js';
import { log } from '../log.js';
import type { DataStore, PendingReview, Review, State } from '../state.js';
import { reviewKeyFor } from '../state.js';
import type { Reviewer } from './types.js';

const MAX_ATTEMPTS = 3;

export interface ReviewedItem {
  item: PendingReview;
  review: Review;
  /** The verdict came from an earlier review of the same content. */
  cached: boolean;
}

export interface QueueResult {
  reviewed: ReviewedItem[];
  errors: string[];
  /** Reviews still waiting for a later run. */
  remaining: number;
}

export function enqueue(state: State, changes: Change[], at: string): void {
  const queued = new Map(state.pending.map((item) => [item.reviewKey, item]));
  for (const change of changes) {
    const reviewKey = reviewKeyFor(change.newSha256, change.oldSha256);
    const newHost = change.newHost && !change.quietHost;
    const existing = queued.get(reviewKey);
    if (existing) {
      // Same content under another URL: one review, but every script gets the verdict
      const known = existing.key === change.key || existing.also?.some((s) => s.key === change.key);
      if (!known) {
        existing.also = [
          ...(existing.also ?? []),
          { key: change.key, url: change.url, host: change.host, pages: change.pages, newHost },
        ];
      }
      continue;
    }
    const item: PendingReview = {
      reviewKey,
      kind: change.kind,
      key: change.key,
      url: change.url,
      host: change.host,
      ...(change.oldSha256 ? { oldSha256: change.oldSha256 } : {}),
      newSha256: change.newSha256,
      pages: change.pages,
      newHost,
      queuedAt: at,
      attempts: 0,
    };
    queued.set(reviewKey, item);
    state.pending.push(item);
  }
}

/** The item itself and every script sharing its review, each as an item of its own. */
function scriptsOf(item: PendingReview): PendingReview[] {
  const { also, ...first } = item;
  return [first, ...(also ?? []).map((script) => ({ ...first, ...script }))];
}

export async function processQueue(
  state: State,
  store: DataStore,
  reviewer: Reviewer,
  config: Config,
  now: Date,
): Promise<QueueResult> {
  const at = now.toISOString();
  const result: QueueResult = { reviewed: [], errors: [], remaining: 0 };
  let calls = 0;
  const waiting: PendingReview[] = [];

  for (const item of prioritized(state.pending)) {
    const cached = state.reviews[item.reviewKey];
    if (cached) {
      finish(state, item, cached, true, result, at, config);
      continue;
    }
    if (calls >= config.llm.maxReviewsPerRun) {
      waiting.push(item);
      continue;
    }
    const newBody = await store.readBlob(item.newSha256);
    if (!newBody) {
      const message = `Review of ${item.url} dropped: its content is no longer stored`;
      result.errors.push(message);
      appendHistory(
        state,
        [{ at, type: 'error', url: item.url, message }],
        config.retention.historyEvents,
      );
      continue;
    }
    const oldBody = item.oldSha256 ? await store.readBlob(item.oldSha256) : undefined;
    try {
      const analysis = await analyze(newBody, oldBody, config.llm.maxInputChars);
      let review: Review;
      if (analysis.literalOnly) {
        review = {
          verdict: 'benign',
          confidence: 1,
          summary: 'Only numbers and id-like values changed.',
          reasons: [],
          provider: 'heuristic',
          model: 'literal-only',
          reviewedAt: at,
        };
      } else {
        calls++;
        log.info(`Reviewing ${item.url} with ${reviewer.provider}/${reviewer.model}`);
        const verdict = await reviewer.review({
          url: item.url,
          host: item.host,
          pages: item.pages,
          newHost: item.newHost,
          analysis,
        });
        review = { ...verdict, provider: reviewer.provider, model: reviewer.model, reviewedAt: at };
      }
      finish(state, item, review, false, result, at, config);
    } catch (error) {
      item.attempts++;
      const message = `Review of ${item.url} failed (attempt ${item.attempts} of ${MAX_ATTEMPTS}): ${shortError(error)}`;
      log.warn(message);
      result.errors.push(message);
      if (item.attempts < MAX_ATTEMPTS) {
        waiting.push(item);
      } else {
        // Remembered on the version, so the status site shows it as not reviewed and
        // reviewBaseline does not queue it again on every run
        for (const script of scriptsOf(item)) {
          const version = state.scripts[script.key]?.versions.findLast(
            (candidate) => candidate.sha256 === item.newSha256,
          );
          if (version) {
            version.reviewFailed = { at, message: shortError(error) };
          }
        }
        appendHistory(
          state,
          [{ at, type: 'error', url: item.url, message }],
          config.retention.historyEvents,
        );
      }
    }
  }

  state.pending = waiting;
  result.remaining = waiting.length;
  return result;
}

/** Alert-worthy first: scripts from new hosts, then changes of known scripts, then new ones. */
function prioritized(pending: PendingReview[]): PendingReview[] {
  const rank = (item: PendingReview) =>
    item.newHost || item.also?.some((script) => script.newHost)
      ? 0
      : item.kind === 'changed'
        ? 1
        : 2;
  return [...pending].sort((a, b) => rank(a) - rank(b) || a.queuedAt.localeCompare(b.queuedAt));
}

function finish(
  state: State,
  item: PendingReview,
  review: Review,
  cached: boolean,
  result: QueueResult,
  at: string,
  config: Config,
): void {
  state.reviews[item.reviewKey] = review;
  for (const script of scriptsOf(item)) {
    const versions = state.scripts[script.key]?.versions ?? [];
    const version = versions.findLast((candidate) => candidate.sha256 === script.newSha256);
    if (version) {
      version.reviewKey = script.reviewKey;
    }
    result.reviewed.push({ item: script, review, cached });
    appendHistory(
      state,
      [
        {
          at,
          type: 'reviewed',
          key: script.key,
          url: script.url,
          sha256: script.newSha256,
          verdict: review.verdict,
          message: review.summary,
        },
      ],
      config.retention.historyEvents,
    );
  }
}

/** Forgets reviews no stored version refers to once they are older than the cutoff. */
export function pruneReviews(state: State, now: Date, maxAgeDays = 30): void {
  const referenced = new Set<string>();
  for (const script of Object.values(state.scripts)) {
    for (const version of script.versions) {
      if (version.reviewKey) {
        referenced.add(version.reviewKey);
      }
    }
  }
  for (const item of state.pending) {
    referenced.add(item.reviewKey);
  }
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [key, review] of Object.entries(state.reviews)) {
    if (!referenced.has(key) && Date.parse(review.reviewedAt) < cutoff) {
      delete state.reviews[key];
    }
  }
}
