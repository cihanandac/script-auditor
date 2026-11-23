/**
 * Merges a crawl into the state and works out what is new or changed.
 *
 * Not every different byte is a change worth reviewing. Some scripts are generated per
 * request; those differences are absorbed without an event:
 * - only numbers or id-like tokens differ (timestamps, request ids)
 * - the script switched back to a version seen before (load-balanced variants)
 * - the URL matches `hosts.ignoreContentChanges`
 * - the script is generated per request (several different versions within one run)
 */
import { countIndicators, hostsInCode, isLiteralOnlyChange } from './analyze.js';
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

  for (const [key, captured] of groupByKey(crawl.scripts)) {
    // Every different body loaded from this script's URLs in this run (other query strings,
    // or another page served something else), first seen first
    const variants = distinctBodies(captured);
    const pages = [...new Set(captured.flatMap((variant) => [...variant.pages]))].sort();
    const perRequest = isPerRequest(variants);
    for (const variant of variants) {
      await store.writeBlob(variant.sha256, variant.body);
    }
    const existing = state.scripts[key];
    const first = variants.find((variant) => variant.sha256 === existing?.sha256) ?? variants[0]!;

    const knownHost = state.hosts[first.host];
    if (knownHost) {
      knownHost.lastSeen = at;
    } else {
      state.hosts[first.host] = { firstSeen: at, lastSeen: at };
      if (!baseline) {
        detection.newHosts.push(first.host);
        events.push({ at, type: 'new-host', host: first.host, url: first.url });
      }
    }
    const changeOf = (script: CapturedScript) => ({
      key,
      url: script.url,
      host: script.host,
      newSha256: script.sha256,
      pages,
      newHost: !baseline && !knownHost,
      quietHost: matchesAny(script.host, config.hosts.quiet),
    });

    if (!existing) {
      state.scripts[key] = {
        ...newRecord(first, pages, at),
        ...(perRequest ? { perRequest: true } : {}),
      };
      if (!baseline) {
        detection.changes.push({ ...changeOf(first), kind: 'new' });
        events.push({ at, type: 'new-script', key, url: first.url, sha256: first.sha256 });
      }
      continue;
    }

    existing.lastSeen = at;
    existing.url = first.url;
    existing.pages = pages;
    // Only a script known to vary is compared leniently: in the run that first shows
    // different bodies, one of them may be a compromise that targets some pages
    const knownToVary = existing.perRequest === true;
    if (perRequest && !existing.perRequest) {
      existing.perRequest = true;
      events.push({
        at,
        type: 'review-skipped',
        key,
        url: first.url,
        message: `Generated per request (${variants.length} different versions in one run): changes are only reviewed when they add hosts or risky calls`,
      });
    } else if (!perRequest && existing.perRequest && pages.length > 1) {
      // Several pages got the same body this time: the variation is gone, so every change
      // is reviewed again
      delete existing.perRequest;
      events.push({
        at,
        type: 'review-skipped',
        key,
        url: first.url,
        message: 'No longer generated per request: content changes are reviewed again',
      });
    }

    // Check every body that differs from the recorded one: a compromise may target one page
    let script: CapturedScript | undefined;
    let absorbed: CapturedScript | undefined;
    for (const variant of variants) {
      if (variant.sha256 === existing.sha256) {
        continue;
      }
      if (await isNoise(existing, variant, knownToVary, state, config, store)) {
        absorbed ??= variant;
      } else {
        script = variant;
        break;
      }
    }
    const current = existing.versions.at(-1);

    if (!script) {
      if (absorbed && first.sha256 !== existing.sha256) {
        detection.absorbed++;
        existing.sha256 = absorbed.sha256;
        existing.size = absorbed.body.length;
        const known = existing.versions.find((version) => version.sha256 === absorbed.sha256);
        // Keep the version list to real versions: a per-request variant replaces the current
        // entry's content instead of adding a version
        const entry = known ?? current;
        if (entry) {
          entry.lastSeen = at;
          if (!known) {
            entry.sha256 = absorbed.sha256;
            entry.size = absorbed.body.length;
            entry.url = absorbed.url;
          }
        }
      } else {
        if (absorbed) {
          detection.absorbed++;
        }
        if (current) {
          current.lastSeen = at;
        }
      }
      continue;
    }

    const oldSha256 = existing.sha256;
    existing.sha256 = script.sha256;
    existing.size = script.body.length;
    existing.url = script.url;
    existing.lastChanged = at;
    existing.versions.push({
      sha256: script.sha256,
      size: script.body.length,
      url: script.url,
      firstSeen: at,
      lastSeen: at,
    });
    existing.versions = existing.versions.slice(-config.retention.versionsPerScript);
    detection.changes.push({ ...changeOf(script), kind: 'changed', oldSha256 });
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

/** One entry per different body, in the order they were captured. */
/** No new host and no more of any risky call than before. */
function addsNoRisk(oldCode: string, newCode: string): boolean {
  const oldHosts = hostsInCode(oldCode);
  if (![...hostsInCode(newCode)].every((host) => oldHosts.has(host))) {
    return false;
  }
  const before = countIndicators(oldCode);
  const after = countIndicators(newCode);
  return Object.entries(after).every(([name, count]) => count <= (before[name] ?? 0));
}

function distinctBodies(captured: CapturedScript[]): CapturedScript[] {
  const bySha = new Map<string, CapturedScript>();
  for (const script of captured) {
    if (!bySha.has(script.sha256)) {
      bySha.set(script.sha256, script);
    }
  }
  return [...bySha.values()];
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

/**
 * Several loads of the same script in one run with contents that differ by more than
 * numbers and ids: the script is generated per request (e.g. it embeds the page title), so
 * comparing it between runs only produces noise.
 */
function isPerRequest(variants: CapturedScript[]): boolean {
  const [first, ...others] = variants;
  if (!first) {
    return false;
  }
  const firstCode = first.body.toString('utf8');
  return others.some(
    (other) =>
      other.sha256 !== first.sha256 && !isLiteralOnlyChange(firstCode, other.body.toString('utf8')),
  );
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
  knownToVary: boolean,
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
  const previous = await store.readBlob(existing.sha256);
  if (knownToVary) {
    // Its content differs on every load, so only what a compromise needs is compared: hosts
    // to talk to and risky calls
    return (
      previous !== undefined && addsNoRisk(previous.toString('utf8'), script.body.toString('utf8'))
    );
  }
  if (
    matchesAny(script.url, config.hosts.ignoreContentChanges) ||
    matchesAny(script.key, config.hosts.ignoreContentChanges)
  ) {
    return true;
  }
  return (
    previous !== undefined &&
    isLiteralOnlyChange(previous.toString('utf8'), script.body.toString('utf8'))
  );
}
