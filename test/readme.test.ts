import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { README_END, README_START, renderReadmeSection, updateReadme } from '../src/readme.js';
import { scriptId } from '../src/site.js';
import { emptyState, type Review, type State } from '../src/state.js';

const HOME = 'https://www.example.com/';
const SHOP = 'https://www.example.com/shop';
const GOOD = 'https://cdn.good.example/lib.js';
const BAD = 'https://cdn.bad.example/widget.js';
const ODD = 'https://cdn.odd.example/tag.js';

const config = (site: Record<string, unknown> = {}) =>
  parseConfig({ pages: [{ url: HOME, name: 'Home' }], site });

function review(verdict: Review['verdict'], summary: string): Review {
  return {
    verdict,
    confidence: 0.9,
    summary,
    reasons: [],
    provider: 'openai',
    model: 'm',
    reviewedAt: '2026-11-19T00:00:00Z',
  };
}

function fixture(): State {
  const state = emptyState(new Date('2026-11-20T10:00:00Z'));
  state.runs = 3;
  state.lastRun = {
    startedAt: '2026-11-20T10:00:00Z',
    finishedAt: '2026-11-20T10:05:00Z',
    consentConfigured: false,
    consentAccepted: false,
  };
  state.pages[HOME] = { url: HOME, name: 'Home', lastScanned: '', scriptKeys: [GOOD, BAD] };
  state.pages[SHOP] = { url: SHOP, name: 'Shop', lastScanned: '', scriptKeys: [ODD] };
  const add = (key: string, pages: string[], reviewKey?: string) => {
    state.scripts[key] = {
      key,
      url: key,
      host: new URL(key).hostname,
      sha256: key,
      size: 1,
      firstSeen: '2026-11-01T00:00:00Z',
      lastSeen: '2026-11-20T10:00:00Z',
      lastChanged: '2026-11-19T00:00:00Z',
      pages,
      versions: [
        {
          sha256: key,
          size: 1,
          url: key,
          firstSeen: '2026-11-19T00:00:00Z',
          lastSeen: '2026-11-20T10:00:00Z',
          ...(reviewKey ? { reviewKey } : {}),
        },
      ],
    };
  };
  add(GOOD, [HOME], 'r:good');
  add(BAD, [HOME, SHOP], 'r:bad');
  add(ODD, [SHOP], 'r:odd');
  state.reviews['r:good'] = review('benign', 'A charting library.');
  state.reviews['r:bad'] = review('malicious', 'Sends card numbers to x.evil.example.');
  state.reviews['r:odd'] = review('suspicious', 'Loads code from a new host.');
  return state;
}

describe('renderReadmeSection', () => {
  it('lists flagged scripts, worst first, with their pages and a link to the details', () => {
    const section = renderReadmeSection(fixture(), config({ url: 'https://audit.example/' }));
    expect(section).toContain('🔴 **2 scripts need attention**');
    const items = section.split('\n\n').filter((block) => block.startsWith('- '));
    expect(items).toEqual([
      [
        `- 🔴 **malicious** \`${BAD}\` ([details](https://audit.example/scripts/${scriptId(BAD)}.html))\\`,
        '  Pages: Home, Shop\\',
        '  Sends card numbers to x&#46;evil&#46;example&#46;',
      ].join('\n'),
      [
        `- 🟠 **suspicious** \`${ODD}\` ([details](https://audit.example/scripts/${scriptId(ODD)}.html))\\`,
        '  Pages: Shop\\',
        '  Loads code from a new host&#46;',
      ].join('\n'),
    ]);
    expect(section).not.toContain(GOOD);
    expect(section).toContain('[Status site](https://audit.example)');
  });

  it('holds nothing that changes from run to run without a new finding', () => {
    const state = fixture();
    const before = renderReadmeSection(state, config());
    state.runs = 99;
    state.lastRun!.finishedAt = '2026-11-21T00:00:00Z';
    state.pending.push({ key: GOOD } as State['pending'][number]);
    expect(renderReadmeSection(state, config())).toBe(before);
  });

  it('says so when nothing is flagged, and when nothing was audited yet', () => {
    const state = fixture();
    state.reviews['r:bad'] = review('benign', 'fine');
    state.reviews['r:odd'] = review('benign', 'fine');
    expect(renderReadmeSection(state, config())).toBe(
      '🟢 **No findings**: no third-party script is flagged.',
    );
    expect(renderReadmeSection(emptyState(new Date()), config())).toBe('⚪ **Not audited yet**');
  });

  it('lists failed reviews, unscanned pages and a declined consent banner', () => {
    const state = fixture();
    state.scripts[GOOD]!.versions[0]!.reviewFailed = { at: '', message: 'quota' };
    delete state.scripts[GOOD]!.versions[0]!.reviewKey;
    state.pages[SHOP]!.error = 'timeout';
    state.lastRun!.consentConfigured = true;
    const section = renderReadmeSection(state, config());
    expect(section).toContain(`- Review failed for \`${GOOD}\``);
    expect(section).toContain('- Could not be scanned in the last run: Shop');
    expect(section).toContain('- The consent banner was not accepted');
  });

  it('keeps text from a compromised script from turning into markup', () => {
    const state = fixture();
    state.reviews['r:bad'] = review(
      'malicious',
      'See [here](https://evil.example) <img src=x> | @octocat #1 `x` https://evil.example',
    );
    state.scripts[BAD]!.key = 'https://cdn.bad.example/a`b.js';
    const lines = renderReadmeSection(state, config()).split('\n');
    const item = lines.findIndex((line) => line.startsWith('- 🔴'));
    expect(lines[item]).toContain("`https://cdn.bad.example/a'b.js`");
    const summary = lines[item + 2]!;
    for (const raw of ['[here]', '](', '<img', 'https://evil', '@octocat', ' #1 ', '`x`']) {
      expect(summary).not.toContain(raw);
    }
    expect(summary).toContain('@⁠octocat');
  });

  it('keeps a summary on its line, so it cannot start a heading or end the list', () => {
    const state = fixture();
    state.reviews['r:bad'] = review('malicious', 'one\n\n# Heading\nends with a backslash \\');
    const lines = renderReadmeSection(state, config()).split('\n');
    const item = lines.findIndex((line) => line.startsWith('- 🔴'));
    expect(lines[item + 2]).toBe('  one &#35; Heading ends with a backslash &#92;');
    expect(lines[item + 3]).toBe('');
  });
});

describe('updateReadme', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-readme-'));
    file = join(dir, 'README.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces only what is between the markers', async () => {
    await writeFile(file, `# Title\n\n${README_START}\nold\n${README_END}\n\nFooter\n`);
    expect(await updateReadme(file, 'new')).toBe('updated');
    expect(await readFile(file, 'utf8')).toBe(
      `# Title\n\n${README_START}\nnew\n${README_END}\n\nFooter\n`,
    );
    expect(await updateReadme(file, 'new')).toBe('unchanged');
  });

  it('fills an empty section', async () => {
    await writeFile(file, `${README_START}\n${README_END}\n`);
    expect(await updateReadme(file, 'new')).toBe('updated');
    expect(await readFile(file, 'utf8')).toBe(`${README_START}\nnew\n${README_END}\n`);
  });

  it('leaves a README without both markers alone', async () => {
    for (const content of ['# Title\n', `${README_END}\n${README_START}\n`, `${README_START}\n`]) {
      await writeFile(file, content);
      expect(await updateReadme(file, 'new')).toBe('no-markers');
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });
});
