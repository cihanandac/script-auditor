import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { formatSummary } from '../src/summary.js';

describe('cli', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('prints help and version', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main(['--version'])).toBe(0);
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect(console.log).toHaveBeenCalledWith(version);
  });

  it('exits with 2 on usage and configuration problems', async () => {
    expect(await main(['--nope'])).toBe(2);
    expect(await main(['--config', join(dir, 'missing.yml')])).toBe(2);
    const config = join(dir, 'script-auditor.yml');
    await writeFile(config, 'pages: [https://www.example.com/]\n');
    // OPENAI_API_KEY is not set: fails before crawling
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(await main(['run', '--config', config])).toBe(2);
    if (saved !== undefined) {
      process.env.OPENAI_API_KEY = saved;
    }
    expect(await main(['frobnicate', '--config', config])).toBe(2);
  });
});

describe('formatSummary', () => {
  it('keeps model and URL text out of markdown rendering', () => {
    const summary = formatSummary({
      title: 'Audit',
      startedAt: '',
      finishedAt: '',
      baseline: false,
      stats: {
        pages: 1,
        pagesFailed: 0,
        scripts: 1,
        hosts: 1,
        changes: 1,
        absorbed: 0,
        reviewed: 1,
        pendingReviews: 0,
      },
      alerts: [
        {
          key: 'k',
          url: 'https://x.example/a.js',
          host: 'x.example',
          pages: [],
          scriptId: 'id',
          newHost: true,
          review: {
            verdict: 'malicious',
            confidence: 1,
            summary: 'Has `<img onerror>`',
            reasons: [],
            provider: 'p',
            model: 'm',
            reviewedAt: '',
          },
        },
      ],
      changes: [],
      errors: [],
    });
    expect(summary).toContain(
      "- **malicious** `https://x.example/a.js` (new host `x.example`): `Has '<img onerror>'`",
    );
  });
});
