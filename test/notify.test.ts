import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { createNotifiers } from '../src/notify/index.js';
import { buildSlackMessage, SlackNotifier } from '../src/notify/slack.js';
import type { RunReport } from '../src/report.js';

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    title: 'Script Auditor',
    siteUrl: 'https://audit.example.github.io/site/',
    runUrl: 'https://github.com/o/r/actions/runs/1',
    startedAt: '2026-11-20T10:00:00Z',
    finishedAt: '2026-11-20T10:05:00Z',
    baseline: false,
    stats: {
      pages: 4,
      pagesFailed: 0,
      scripts: 120,
      hosts: 30,
      changes: 0,
      absorbed: 0,
      reviewed: 0,
      pendingReviews: 0,
    },
    alerts: [],
    changes: [],
    errors: [],
    ...overrides,
  };
}

const maliciousAlert = {
  key: 'https://cdn.vendor.example/widget.js',
  url: 'https://cdn.vendor.example/widget.js?v=2',
  host: 'cdn.vendor.example',
  pages: [
    'https://www.example.com/',
    'https://www.example.com/a',
    'https://www.example.com/b',
    'https://www.example.com/c',
  ],
  scriptId: 'abc123',
  newHost: false,
  review: {
    verdict: 'malicious' as const,
    confidence: 0.92,
    summary: 'Sends <form> data to a new host & hides it.',
    reasons: ['Adds a submit listener', 'Posts to stats.evil.example'],
    provider: 'openai',
    model: 'gpt-5-mini',
    reviewedAt: '2026-11-20T10:04:00Z',
  },
};

describe('buildSlackMessage', () => {
  it('sends nothing when the report has nothing subscribed', () => {
    expect(buildSlackMessage(report(), ['alert', 'error'])).toBeUndefined();
    expect(
      buildSlackMessage(
        report({
          changes: [
            { kind: 'new', url: 'https://x.example/a.js', host: 'x.example', scriptId: 'x' },
          ],
        }),
        ['alert', 'error'],
      ),
    ).toBeUndefined();
  });

  it('describes alerts with verdict, reasons, pages and links', () => {
    const message = buildSlackMessage(report({ alerts: [maliciousAlert] }), ['alert', 'error'])!;
    expect(message.text).toBe('🚨 Script Auditor: 1 script needs attention');
    const text = JSON.stringify(message.blocks);
    expect(text).toContain('*🔴 MALICIOUS* (92%)');
    expect(text).toContain('Sends &lt;form&gt; data to a new host &amp; hides it.');
    expect(text).toContain('• Posts to stats.evil.example');
    expect(text).toContain('+1 more');
    expect(text).toContain(
      '<https://audit.example.github.io/site/scripts/abc123.html|Details and history>',
    );
    expect(text).toContain('<https://github.com/o/r/actions/runs/1|run log>');
  });

  it('announces new hosts that are not reviewed yet', () => {
    const message = buildSlackMessage(
      report({
        alerts: [
          {
            key: 'https://new.example/x.js',
            url: 'https://new.example/x.js',
            host: 'new.example',
            pages: [],
            scriptId: 'n1',
            newHost: true,
          },
        ],
      }),
      ['alert'],
    )!;
    expect(message.text).toBe('⚠️ Script Auditor: 1 script needs attention');
    expect(JSON.stringify(message.blocks)).toMatch(
      /NEW HOST.*First script ever loaded from `new.example`.*Not reviewed yet/,
    );
  });

  it('lists problems and, when subscribed, every change', () => {
    const message = buildSlackMessage(
      report({
        errors: ['Could not scan https://www.example.com/a: HTTP 404'],
        changes: [
          {
            kind: 'changed',
            url: 'https://cdn.vendor.example/a.js',
            host: 'cdn.vendor.example',
            scriptId: 's1',
            review: { ...maliciousAlert.review, verdict: 'benign' },
          },
        ],
      }),
      ['change', 'error'],
    )!;
    expect(message.text).toBe('📝 Script Auditor: 1 script changed');
    const text = JSON.stringify(message.blocks);
    expect(text).toContain('*Problems during the run*');
    expect(text).toContain(
      '• changed: <https://audit.example.github.io/site/scripts/s1.html|cdn.vendor.example/a.js> — benign',
    );
  });

  it('stays within Slack limits', () => {
    const alerts = Array.from({ length: 40 }, (_, i) => ({
      ...maliciousAlert,
      scriptId: `id${i}`,
      review: { ...maliciousAlert.review, reasons: ['x'.repeat(2000), 'y'.repeat(2000)] },
    }));
    const message = buildSlackMessage(report({ alerts, errors: ['e'.repeat(5000)] }), [
      'alert',
      'error',
    ])!;
    expect(message.blocks.length).toBeLessThanOrEqual(50);
    for (const block of message.blocks) {
      const text = (block as { text?: { text: string } }).text?.text ?? '';
      expect(text.length).toBeLessThanOrEqual(3000);
    }
    expect(JSON.stringify(message.blocks)).toContain('and 25 more alerts');
  });
});

describe('SlackNotifier', () => {
  it('posts the message as JSON', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const post = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(init.body as string) });
      return new Response('ok');
    }) as typeof fetch;
    const notifier = new SlackNotifier('https://hooks.slack.com/services/SECRET', ['alert'], post);
    expect(await notifier.notify(report())).toBe(false);
    expect(await notifier.notify(report({ alerts: [maliciousAlert] }))).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://hooks.slack.com/services/SECRET');
    expect(posted[0]!.body).toMatchObject({ text: expect.stringContaining('attention') });
  });

  it('reports failures without revealing the webhook URL', async () => {
    const post = (async () => new Response('invalid_payload', { status: 400 })) as typeof fetch;
    const notifier = new SlackNotifier('https://hooks.slack.com/services/SECRET', ['alert'], post);
    const error = await notifier
      .notify(report({ alerts: [maliciousAlert] }))
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Slack answered 400: invalid_payload');
    expect((error as Error).message).not.toContain('SECRET');
  });
});

describe('createNotifiers', () => {
  it('reads the webhook from the configured environment variable', () => {
    const config = parseConfig({
      pages: ['https://www.example.com/'],
      notify: [{ type: 'slack', webhookUrlEnv: 'MY_HOOK', on: ['alert'] }],
    });
    expect(() => createNotifiers(config, {})).toThrow(ConfigError);
    expect(
      createNotifiers(config, { MY_HOOK: 'https://hooks.slack.com/x' }).map((n) => n.name),
    ).toEqual(['slack']);
  });
});
