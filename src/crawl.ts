/**
 * Visits the configured pages in one browser session and captures the third-party scripts
 * each page runs.
 *
 * Only scripts of the page itself (the main frame) count. Scripts inside cross-origin
 * iframes, such as ad creatives, run isolated from the page and cannot read or change it.
 */
import type { Browser, BrowserContext, Page as PlaywrightPage, Response } from 'playwright';
import { chromium } from 'playwright';
import type { Config, Page } from './config.js';
import { isFirstParty } from './config.js';
import { log } from './log.js';
import { scriptKey, sha256 } from './script-key.js';

export interface CapturedScript {
  url: string;
  key: string;
  host: string;
  body: Buffer;
  sha256: string;
  /** URLs of the configured pages that ran this script. */
  pages: Set<string>;
}

/**
 * Key of a captured body in CrawlResult.scripts: the URL for the first body seen, the URL
 * plus hash for a different body the same URL returned on another page.
 */
export function variantKey(url: string, sha: string): string {
  return `${url}\n${sha}`;
}

export interface PageScan {
  url: string;
  name: string;
  /** Where the page ended up after redirects. */
  finalUrl?: string;
  scannedAt: string;
  /** URLs of the third-party scripts the page ran. */
  scriptUrls: string[];
  error?: string;
}

export interface CrawlResult {
  startedAt: string;
  finishedAt: string;
  /** Third-party scripts by URL. */
  scripts: Map<string, CapturedScript>;
  pages: PageScan[];
  /** Whether a consent selector is configured. */
  consentConfigured: boolean;
  consentAccepted: boolean;
}

export interface CrawlOptions {
  /** Called with the browser context before the first page opens, e.g. to add routes. */
  contextHook?: (context: BrowserContext) => Promise<void> | void;
}

export type Crawler = (config: Config, options?: CrawlOptions) => Promise<CrawlResult>;

export const crawl: Crawler = async (config, options = {}) => {
  const result: CrawlResult = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    scripts: new Map(),
    pages: [],
    consentConfigured: config.consent.selector !== '',
    consentAccepted: false,
  };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      locale: config.crawl.locale,
      timezoneId: config.crawl.timezone,
      viewport: config.crawl.viewport,
      userAgent: await userAgent(browser, config.crawl.userAgentSuffix),
      // Service workers could serve scripts without the page seeing a network response
      serviceWorkers: 'block',
    });
    // The default buffer of 250 entries overflows on pages with ad auctions
    await context.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
    await options.contextHook?.(context);
    const openPage = async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(config.crawl.pageTimeoutSeconds * 1000);
      return page;
    };

    // The first page alone, to accept the consent; the rest in parallel tabs of the same
    // session, which share the consent cookie
    const scans: PageScan[] = [];
    const firstPage = await openPage();
    scans[0] = await scanPage(firstPage, config.pages[0]!, true, config, result);
    // If the first page failed, the banner could not be accepted there: keep waiting for it
    const waitForBanner = !result.consentAccepted && scans[0].error !== undefined;
    let next = 1;
    const work = async (page: PlaywrightPage) => {
      while (next < config.pages.length) {
        const index = next++;
        scans[index] = await scanPage(page, config.pages[index]!, waitForBanner, config, result);
      }
    };
    const tabs = Math.min(config.crawl.concurrency, config.pages.length - 1);
    const workers = [work(firstPage)];
    for (let tab = 1; tab < tabs; tab++) {
      workers.push(work(await openPage()));
    }
    await Promise.all(workers);
    result.pages = scans;
  } finally {
    await browser.close();
  }
  result.finishedAt = new Date().toISOString();
  return result;
};

async function userAgent(browser: Browser, suffix: string): Promise<string> {
  const page = await browser.newPage();
  try {
    const agent = await page.evaluate(() => navigator.userAgent);
    return `${agent.replace('HeadlessChrome', 'Chrome')} ${suffix}`.trim();
  } finally {
    await page.close();
  }
}

async function scanPage(
  page: PlaywrightPage,
  target: Page,
  waitForBanner: boolean,
  config: Config,
  result: CrawlResult,
): Promise<PageScan> {
  const scan: PageScan = {
    url: target.url,
    name: target.name,
    scannedAt: new Date().toISOString(),
    scriptUrls: [],
  };
  const pending: Promise<void>[] = [];
  const seenOnPage = new Set<string>();
  /** Key in result.scripts of the body this page received, per URL. */
  const capturedHere = new Map<string, string>();

  const onResponse = (response: Response) => {
    const request = response.request();
    if (request.resourceType() !== 'script' || !isMainFrame(page, response)) {
      return;
    }
    seenOnPage.add(response.url());
    pending.push(capture(response, config, result, capturedHere));
  };

  page.on('response', onResponse);
  try {
    log.info(`Scanning ${target.url}`);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()}`);
    }
    await acceptConsent(page, waitForBanner, config, result);
    await waitForLoad(page, config);
    await scrollToBottom(page, config);
    await page.waitForTimeout(config.crawl.settleSeconds * 1000);
    // Scripts served from the browser cache, e.g. already loaded by an earlier page
    for (const url of await scriptUrlsInPage(page)) {
      seenOnPage.add(url);
    }
    scan.finalUrl = page.url();
  } catch (error) {
    scan.error = shortError(error);
    log.warn(`Could not scan ${target.url}: ${scan.error}`);
  } finally {
    page.off('response', onResponse);
    // Bodies have to be read before the next navigation discards them
    await Promise.all(pending);
  }

  for (const url of seenOnPage) {
    // A URL served from the cache has no body of its own here: the first body stands for it
    const script = result.scripts.get(capturedHere.get(url) ?? url);
    if (script) {
      script.pages.add(target.url);
      scan.scriptUrls.push(url);
    }
  }
  scan.scriptUrls.sort();
  return scan;
}

function isMainFrame(page: PlaywrightPage, response: Response): boolean {
  try {
    return response.frame() === page.mainFrame();
  } catch {
    // Service worker responses have no frame
    return false;
  }
}

async function capture(
  response: Response,
  config: Config,
  result: CrawlResult,
  capturedHere: Map<string, string>,
): Promise<void> {
  const url = response.url();
  const host = hostOf(url);
  if (!host || isFirstParty(host, config.firstPartyDomains)) {
    return;
  }
  if (response.status() < 200 || response.status() >= 300) {
    return;
  }
  let body: Buffer;
  try {
    body = await response.body();
  } catch (error) {
    log.debug(`No body for ${url}: ${shortError(error)}`);
    return;
  }
  // Every different body is kept: a vendor may serve one page a different script than
  // another from the same URL, and each page must be attributed to what it ran
  const hash = sha256(body);
  const first = result.scripts.get(url);
  const key = !first || first.sha256 === hash ? url : variantKey(url, hash);
  capturedHere.set(url, key);
  if (!result.scripts.has(key)) {
    result.scripts.set(key, {
      url,
      key: scriptKey(url),
      host,
      body,
      sha256: hash,
      pages: new Set(),
    });
  }
}

async function scriptUrlsInPage(page: PlaywrightPage): Promise<string[]> {
  return page.evaluate(() => {
    const urls = new Set<string>();
    for (const entry of performance.getEntriesByType('resource')) {
      if ((entry as PerformanceResourceTiming).initiatorType === 'script') {
        urls.add(entry.name);
      }
    }
    for (const script of Array.from(document.scripts)) {
      if (script.src) {
        urls.add(script.src);
      }
    }
    return [...urls];
  });
}

async function acceptConsent(
  page: PlaywrightPage,
  waitForBanner: boolean,
  config: Config,
  result: CrawlResult,
): Promise<void> {
  if (!config.consent.selector) {
    return;
  }
  const button = page.locator(config.consent.selector).first();
  if (waitForBanner) {
    try {
      await button.click({ timeout: config.consent.timeoutSeconds * 1000 });
    } catch {
      log.warn(`Consent button "${config.consent.selector}" not found on ${page.url()}`);
      return;
    }
  } else {
    // The consent from the first page carries over; only click if the banner is back
    if (!(await button.isVisible())) {
      return;
    }
    await button.click();
  }
  result.consentAccepted = true;
  log.info(`Accepted the consent banner on ${page.url()}`);
}

async function waitForLoad(page: PlaywrightPage, config: Config): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout: config.crawl.pageTimeoutSeconds * 1000 });
  } catch {
    log.info(`No load event on ${page.url()}, scanning what is there`);
  }
}

async function scrollToBottom(page: PlaywrightPage, config: Config): Promise<void> {
  for (let step = 0; step < config.crawl.maxScrollSteps; step++) {
    await page.mouse.wheel(0, config.crawl.scrollStepPixels);
    await page.waitForTimeout(250);
    const atBottom = await page.evaluate(
      () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
    );
    if (atBottom) {
      break;
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.trim().split('\n')[0] ?? '';
  const name = error instanceof Error ? error.name : 'Error';
  return `${name}: ${firstLine}`.slice(0, 300);
}
