/**
 * Merges a crawl into the state and works out what is new or changed.
 *
 * Not every different byte is a change worth reviewing. Some scripts are generated per
 * request; those differences are absorbed without an event:
 * - only numbers or id-like tokens differ (timestamps, request ids)
 * - the script switched back to a version seen before (load-balanced variants)
 * - the URL matches `hosts.ignoreContentChanges`
 */
import { isLiteralOnlyChange } from './analyze.js';
import type { Config } from './config.js';
import { matchesAny } from './config.js';
import type { CapturedScript, CrawlResult } from './crawl.js';
import type { DataStore, HistoryEvent, ScriptRecord, State } from './state.js';

export interface Change {
  kind: 'new' | 'changed';
  key: string;
  url: string;
  host: string;
  oldSha256?: string;
  newSha256: string;
  pages: string[];
  /** The host was never seen before this run. */
  newHost: boolean;
  /** The host matches `hosts.quiet`: no new-host alert. */
  quietHost: boolean;
}

export interface Detection {
  /** First run: everything is recorded as the starting point, nothing is a change. */
  baseline: boolean;
  changes: Change[];
  newHosts: string[];
  /** Keys of scripts forgotten after `retention.scriptDays` without being seen. */
  removed: string[];
  /** Differences that were absorbed as noise. */
  absorbed: number;
}

export async function applyCrawl(
  state: State,
  crawl: CrawlResult,
  config: Config,
  store: DataStore,
  now: Date,
): Promise<Detection> {
  const at = now.toISOString();
  const baseline = state.runs === 0 && Object.keys(state.scripts).length === 0;
  const detection: Detection = { baseline, changes: [], newHosts: [], removed: [], absorbed: 0 };
  const events: HistoryEvent[] = [];

  for (const [key, variants] of groupByKey(crawl.scripts)) {
    // Scripts generated per request can load several times with different query strings;
    // the first one loaded stands for all of them
    const script = variants[0]!;
    const pages = [...new Set(variants.flatMap((variant) => [...variant.pages]))].sort();
    await store.writeBlob(script.sha256, script.body);

    const knownHost = state.hosts[script.host];
    if (knownHost) {
      knownHost.lastSeen = at;
    } else {
      state.hosts[script.host] = { firstSeen: at, lastSeen: at };
      if (!baseline) {
        detection.newHosts.push(script.host);
        events.push({ at, type: 'new-host', host: script.host, url: script.url });
      }
    }
    const change = {
      key,
      url: script.url,
      host: script.host,
      newSha256: script.sha256,
      pages,
      newHost: !baseline && !knownHost,
      quietHost: matchesAny(script.host, config.hosts.quiet),
    };

    const existing = state.scripts[key];
    if (!existing) {
      state.scripts[key] = newRecord(script, pages, at);
      if (!baseline) {
        detection.changes.push({ ...change, kind: 'new' });
        events.push({ at, type: 'new-script', key, url: script.url, sha256: script.sha256 });
      }
      continue;
    }

    existing.lastSeen = at;
    existing.url = script.url;
    existing.pages = pages;
    const current = existing.versions.at(-1);
    if (existing.sha256 === script.sha256) {
      if (current) {
        current.lastSeen = at;
      }
      continue;
    }

    if (await isNoise(existing, script, state, config, store)) {
      detection.absorbed++;
      existing.sha256 = script.sha256;
      existing.size = script.body.length;
      const known = existing.versions.find((version) => version.sha256 === script.sha256);
      // Keep the version list to real versions: a per-request variant replaces the current
      // entry's content instead of adding a version
      const entry = known ?? current;
      if (entry) {
        entry.lastSeen = at;
        if (!known) {
          entry.sha256 = script.sha256;
          entry.size = script.body.length;
          entry.url = script.url;
        }
      }
      continue;
    }

    const oldSha256 = existing.sha256;
    existing.sha256 = script.sha256;
    existing.size = script.body.length;
    existing.lastChanged = at;
    existing.versions.push({
      sha256: script.sha256,
      size: script.body.length,
      url: script.url,
      firstSeen: at,
      lastSeen: at,
    });
    existing.versions = existing.versions.slice(-config.retention.versionsPerScript);
    detection.changes.push({ ...change, kind: 'changed', oldSha256 });
    events.push({ at, type: 'changed', key, url: script.url, sha256: script.sha256, oldSha256 });
  }

  const cutoff = now.getTime() - config.retention.scriptDays * 24 * 60 * 60 * 1000;
  for (const [key, script] of Object.entries(state.scripts)) {
    if (Date.parse(script.lastSeen) < cutoff) {
      delete state.scripts[key];
      detection.removed.push(key);
      events.push({ at, type: 'removed', key, url: script.url, host: script.host });
    }
  }

  const configured = new Set(config.pages.map((page) => page.url));
  for (const url of Object.keys(state.pages)) {
    if (!configured.has(url)) {
      delete state.pages[url];
    }
  }
  for (const scan of crawl.pages) {
    const keys = new Set<string>();
    for (const url of scan.scriptUrls) {
      const script = crawl.scripts.get(url);
      if (script) {
        keys.add(script.key);
      }
    }
    state.pages[scan.url] = {
      url: scan.url,
      name: scan.name,
      ...(scan.finalUrl && scan.finalUrl !== scan.url ? { finalUrl: scan.finalUrl } : {}),
      lastScanned: scan.scannedAt,
      scriptKeys: [...keys].sort(),
      ...(scan.error ? { error: scan.error } : {}),
    };
    if (scan.error) {
      events.push({ at, type: 'error', page: scan.url, message: scan.error });
    }
  }

  if (baseline) {
    const count = Object.keys(state.scripts).length;
    const hosts = Object.keys(state.hosts).length;
    events.unshift({
      at,
      type: 'baseline',
      message: `Recorded ${count} scripts from ${hosts} hosts as the starting point`,
    });
  }
  appendHistory(state, events, config.retention.historyEvents);
  return detection;
}

export function appendHistory(state: State, events: HistoryEvent[], limit: number): void {
  state.history.push(...events);
  if (state.history.length > limit) {
    state.history.splice(0, state.history.length - limit);
  }
}

function groupByKey(scripts: Map<string, CapturedScript>): Map<string, CapturedScript[]> {
  const groups = new Map<string, CapturedScript[]>();
  for (const script of scripts.values()) {
    const group = groups.get(script.key);
    if (group) {
      group.push(script);
    } else {
      groups.set(script.key, [script]);
    }
  }
  return groups;
}

function newRecord(script: CapturedScript, pages: string[], at: string): ScriptRecord {
  return {
    key: script.key,
    url: script.url,
    host: script.host,
    sha256: script.sha256,
    size: script.body.length,
    firstSeen: at,
    lastSeen: at,
    lastChanged: at,
    pages,
    versions: [
      {
        sha256: script.sha256,
        size: script.body.length,
        url: script.url,
        firstSeen: at,
        lastSeen: at,
      },
    ],
  };
}

async function isNoise(
  existing: ScriptRecord,
  script: CapturedScript,
  state: State,
  config: Config,
  store: DataStore,
): Promise<boolean> {
  const known = existing.versions.find((version) => version.sha256 === script.sha256);
  if (known) {
    // A flagged version that comes back is a change again, and alerts again
    const review = known.reviewKey ? state.reviews[known.reviewKey] : undefined;
    return !review || review.verdict === 'benign';
  }
  if (
    matchesAny(script.url, config.hosts.ignoreContentChanges) ||
    matchesAny(script.key, config.hosts.ignoreContentChanges)
  ) {
    return true;
  }
  const previous = await store.readBlob(existing.sha256);
  return (
    previous !== undefined &&
    isLiteralOnlyChange(previous.toString('utf8'), script.body.toString('utf8'))
  );
}
