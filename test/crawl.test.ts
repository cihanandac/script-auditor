import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { crawl, type CrawlResult } from '../src/crawl.js';
import { startTestSite, type TestSite } from './helpers/site-server.js';

describe('crawl', () => {
  let site: TestSite;
  let result: CrawlResult;

  beforeAll(async () => {
    site = await startTestSite();
    const config = parseConfig({
      pages: [`${site.firstParty}/`, `${site.firstParty}/page2`, `${site.firstParty}/missing`],
      firstPartyDomains: ['localhost'],
      consent: { selector: '.accept', timeoutSeconds: 5 },
      crawl: { settleSeconds: 0.5, scrollStepPixels: 1500, pageTimeoutSeconds: 10 },
    });
    result = await crawl(config);
  });

  afterAll(async () => {
    await site?.close();
  });

  it('captures third-party scripts of the main frame only', () => {
    const urls = [...result.scripts.keys()].sort();
    expect(urls).toEqual([
      `${site.thirdParty}/after-consent.js`,
      `${site.thirdParty}/lazy.js`,
      `${site.thirdParty}/page2-only.js`,
      `${site.thirdParty}/vendor.js?v=1`,
    ]);
    const vendor = result.scripts.get(`${site.thirdParty}/vendor.js?v=1`)!;
    expect(vendor.key).toBe(`${site.thirdParty}/vendor.js`);
    expect(vendor.host).toBe('127.0.0.1');
    expect(vendor.body.toString()).toContain('window.vendor');
    expect(vendor.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the consent banner inside a shadow root', () => {
    expect(result.consentConfigured).toBe(true);
    expect(result.consentAccepted).toBe(true);
  });

  it('attributes scripts to every page that ran them, cached ones included', () => {
    const [home, page2] = result.pages;
    expect(home!.scriptUrls).toEqual([
      `${site.thirdParty}/after-consent.js`,
      `${site.thirdParty}/lazy.js`,
      `${site.thirdParty}/vendor.js?v=1`,
    ]);
    expect(page2!.scriptUrls).toEqual([
      `${site.thirdParty}/page2-only.js`,
      `${site.thirdParty}/vendor.js?v=1`,
    ]);
    expect([...result.scripts.get(`${site.thirdParty}/vendor.js?v=1`)!.pages].sort()).toEqual([
      `${site.firstParty}/`,
      `${site.firstParty}/page2`,
    ]);
  });

  it('records pages that fail without stopping the run', () => {
    const missing = result.pages[2]!;
    expect(missing.error).toMatch(/HTTP 404/);
    expect(missing.scriptUrls).toEqual([]);
  });
});
