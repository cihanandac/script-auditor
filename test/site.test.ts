import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildSite, pageId, scriptId } from '../src/site.js';
import { emptyState, type State } from '../src/state.js';

const HOME = 'https://www.example.com/';
const GOOD = 'https://cdn.good.example/lib.js';
const BAD = 'https://cdn.bad.example/widget.js';

function fixture(): State {
  const state = emptyState(new Date('2026-11-20T10:00:00Z'));
  state.runs = 5;
  state.lastRun = {
    startedAt: '2026-11-20T10:00:00Z',
    finishedAt: '2026-11-20T10:05:00Z',
    consentConfigured: true,
    consentAccepted: true,
  };
  state.pages[HOME] = {
    url: HOME,
    name: 'Home',
    lastScanned: '2026-11-20T10:01:00Z',
    scriptKeys: [BAD, GOOD],
  };
  const record = (key: string, sha: string, reviewKey?: string) => ({
    key,
    url: `${key}?v=1`,
    host: new URL(key).hostname,
    sha256: sha,
    size: 2048,
    firstSeen: '2026-11-01T00:00:00Z',
    lastSeen: '2026-11-20T10:01:00Z',
    lastChanged: '2026-11-19T00:00:00Z',
    pages: [HOME],
    versions: [
      {
        sha256: sha,
        size: 2048,
        url: `${key}?v=1`,
        firstSeen: '2026-11-19T00:00:00Z',
        lastSeen: '2026-11-20T10:01:00Z',
        ...(reviewKey ? { reviewKey } : {}),
      },
    ],
  });
  state.scripts[GOOD] = record(GOOD, 'a'.repeat(64));
  state.scripts[BAD] = record(BAD, 'b'.repeat(64), 'new:bbb');
  state.hosts['cdn.good.example'] = { firstSeen: '2026-11-01T00:00:00Z', lastSeen: '' };
  state.hosts['cdn.bad.example'] = { firstSeen: '2026-11-19T00:00:00Z', lastSeen: '' };
  state.reviews['new:bbb'] = {
    verdict: 'malicious',
    confidence: 0.95,
    summary: 'Injects <script>alert(1)</script> into checkout.',
    reasons: ['Posts form data to "x.evil.example"'],
    provider: 'openai',
    model: 'gpt-5-mini',
    reviewedAt: '2026-11-19T00:01:00Z',
  };
  state.history.push(
    { at: '2026-11-19T00:00:00Z', type: 'new-host', host: 'cdn.bad.example', url: BAD },
    {
      at: '2026-11-19T00:01:00Z',
      type: 'reviewed',
      key: BAD,
      url: BAD,
      verdict: 'malicious',
      message: 'Injects things',
    },
  );
  return state;
}

describe('buildSite', () => {
  let dir: string;
  const read = (path: string) => readFile(join(dir, path), 'utf8');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-site-'));
    const config = parseConfig({
      pages: [{ url: HOME, name: 'Home' }],
      site: { title: 'Example audit' },
    });
    await buildSite(fixture(), config, dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an overview, one file per page and per script, and data.json', async () => {
    expect((await readdir(dir)).sort()).toEqual([
      '.nojekyll',
      'data.json',
      'index.html',
      'pages',
      'scripts',
    ]);
    expect(await readdir(join(dir, 'pages'))).toEqual([`${pageId(HOME)}.html`]);
    expect((await readdir(join(dir, 'scripts'))).sort()).toEqual(
      [`${scriptId(BAD)}.html`, `${scriptId(GOOD)}.html`].sort(),
    );
  });

  it('puts flagged scripts first on the overview', async () => {
    const index = await read('index.html');
    expect(index).toContain('<title>Example audit</title>');
    expect(index).toContain('1 needs attention');
    expect(index).toMatch(
      /Needs attention[\s\S]*cdn\.bad\.example[\s\S]*malicious[\s\S]*<h2>Pages/,
    );
    expect(index).toContain(`href="pages/${pageId(HOME)}.html"`);
    expect(index).toContain('1 flagged');
  });

  it('lists the scripts of a page grouped by host', async () => {
    const page = await read(`pages/${pageId(HOME)}.html`);
    expect(page).toContain('2 third-party scripts from 2 hosts');
    expect(page).toMatch(/<h2>cdn\.bad\.example<\/h2>[\s\S]*<h2>cdn\.good\.example<\/h2>/);
    expect(page).toContain(`href="../scripts/${scriptId(GOOD)}.html"`);
  });

  it('shows versions and verdicts of a script, escaped', async () => {
    const script = await read(`scripts/${scriptId(BAD)}.html`);
    expect(script).toContain('Injects &lt;script&gt;alert(1)&lt;/script&gt; into checkout.');
    expect(script).not.toContain('<script>alert(1)</script>');
    expect(script).toContain('Posts form data to &quot;x.evil.example&quot;');
    expect(script).toContain('95% confidence');
    expect(await read(`scripts/${scriptId(GOOD)}.html`)).toContain('not reviewed');
  });

  it('exports the data as JSON', async () => {
    const data = JSON.parse(await read('data.json'));
    expect(data.scripts).toHaveLength(2);
    expect(data.scripts.find((script: { key: string }) => script.key === BAD).review.verdict).toBe(
      'malicious',
    );
    expect(data.pages[0].id).toBe(pageId(HOME));
  });
});

// Earlier tests had no failed review, so a script whose review failed for good looked like
// an untouched baseline script, and the overview said "no findings".
describe('buildSite with a failed review', () => {
  it('shows the failure on the script and on the overview', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'script-auditor-site-'));
    try {
      const state = fixture();
      delete state.scripts[BAD];
      state.pages[HOME]!.scriptKeys = [GOOD];
      state.scripts[GOOD]!.versions[0]!.reviewFailed = { at: '', message: 'HTTP 429 rate limited' };
      await buildSite(state, parseConfig({ pages: [HOME] }), dir);
      const index = await readFile(join(dir, 'index.html'), 'utf8');
      expect(index).toContain('1 review failed');
      expect(index).not.toContain('no findings');
      const script = await readFile(join(dir, 'scripts', `${scriptId(GOOD)}.html`), 'utf8');
      expect(script).toContain('review failed');
      expect(script).toContain('HTTP 429 rate limited');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
