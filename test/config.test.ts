import { describe, expect, it } from 'vitest';
import { ConfigError, globMatch, isFirstParty, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('fills in defaults for a minimal config', () => {
    const config = parseConfig({ pages: ['https://www.example.com/'] });
    expect(config.pages).toEqual([{ url: 'https://www.example.com/', name: 'www.example.com' }]);
    expect(config.firstPartyDomains).toEqual(['example.com']);
    expect(config.llm).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
    expect(config.llm.apiKeyEnv).toBe('OPENAI_API_KEY');
    expect(config.alerts).toEqual({ minVerdict: 'suspicious', newHosts: true });
    expect(config.crawl.viewport).toEqual({ width: 1366, height: 900 });
    expect(config.notify).toEqual([]);
  });

  it('accepts named pages and explicit first-party domains', () => {
    const config = parseConfig({
      pages: [{ url: 'https://shop.example.co.uk/cart', name: 'Cart' }, 'https://example.co.uk/'],
      firstPartyDomains: ['example.co.uk'],
      notify: [{ type: 'slack' }],
    });
    expect(config.pages.map((page) => page.name)).toEqual(['Cart', 'example.co.uk']);
    expect(config.firstPartyDomains).toEqual(['example.co.uk']);
    expect(config.notify).toEqual([
      { type: 'slack', webhookUrlEnv: 'SLACK_WEBHOOK_URL', on: ['alert', 'error'] },
    ]);
  });

  it('reports every problem in one error', () => {
    expect(() => parseConfig({ pages: ['not a url'], notify: [{ type: 'pigeon' }] })).toThrow(
      ConfigError,
    );
    try {
      parseConfig({ pages: [], llm: { maxReviewsPerRun: 0 } });
    } catch (error) {
      expect((error as Error).message).toMatch(/pages/);
      expect((error as Error).message).toMatch(/maxReviewsPerRun/);
    }
  });
});

describe('isFirstParty', () => {
  it('matches the domain and its subdomains only', () => {
    expect(isFirstParty('example.com', ['example.com'])).toBe(true);
    expect(isFirstParty('cdn.example.com', ['example.com'])).toBe(true);
    expect(isFirstParty('badexample.com', ['example.com'])).toBe(false);
    expect(isFirstParty('example.com.evil.net', ['example.com'])).toBe(false);
  });
});

describe('globMatch', () => {
  it('treats * as wildcard and everything else literally', () => {
    expect(globMatch('securepubads.g.doubleclick.net', '*.doubleclick.net')).toBe(true);
    expect(globMatch('doubleclick.net', '*.doubleclick.net')).toBe(false);
    expect(globMatch('ads.example.com', 'ads.example.com')).toBe(true);
    expect(globMatch('adsXexample.com', 'ads.example.com')).toBe(false);
    expect(globMatch('https://a.com/x?y=1', 'https://a.com/x*')).toBe(true);
  });
});
