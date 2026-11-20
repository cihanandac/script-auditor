import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const pageSchema = z.union([
  z.url(),
  z.object({
    url: z.url(),
    name: z.string().min(1).optional(),
  }),
]);

const llmSchema = z
  .object({
    /** LLM provider that reviews changed scripts. `none` only records changes. */
    provider: z.enum(['openai', 'none']).default('openai'),
    model: z.string().min(1).default('gpt-5-mini'),
    /** Name of the environment variable that holds the API key. */
    apiKeyEnv: z.string().min(1).default('OPENAI_API_KEY'),
    /** For OpenAI-compatible endpoints (Azure OpenAI, OpenRouter, Ollama, ...). */
    baseUrl: z.url().optional(),
    /** Reviews beyond this number wait for the next run. */
    maxReviewsPerRun: z.number().int().positive().default(40),
    /** Upper bound for the code sent to the model per review, in characters. */
    maxInputChars: z.number().int().min(10_000).default(120_000),
    /** Also review every script found on the very first run. */
    reviewBaseline: z.boolean().default(false),
  })
  .prefault({});

const slackSchema = z.object({
  type: z.literal('slack'),
  /** Name of the environment variable that holds the incoming webhook URL. */
  webhookUrlEnv: z.string().min(1).default('SLACK_WEBHOOK_URL'),
  /** What to send: alerts (suspicious scripts, new hosts), errors, every change. */
  on: z
    .array(z.enum(['alert', 'error', 'change']))
    .min(1)
    .default(['alert', 'error']),
});

const notifierSchema = z.discriminatedUnion('type', [slackSchema]);

export const configSchema = z.object({
  /** Pages to visit, in this order, all in one browser session. */
  pages: z.array(pageSchema).min(1),
  /**
   * Your own domains, subdomains included. Their scripts are not audited. Defaults to the
   * registrable-looking domain of every page.
   */
  firstPartyDomains: z.array(z.string().min(1)).optional(),
  consent: z
    .object({
      /** CSS selector of the "accept all" button. Shadow DOM is pierced. Empty: no banner. */
      selector: z.string().default(''),
      /** How long to wait for the banner on the first page. */
      timeoutSeconds: z.number().positive().default(15),
    })
    .prefault({}),
  crawl: z
    .object({
      pageTimeoutSeconds: z.number().positive().default(45),
      scrollStepPixels: z.number().int().positive().default(800),
      maxScrollSteps: z.number().int().nonnegative().default(30),
      /** Wait after scrolling, for scripts that load late. */
      settleSeconds: z.number().nonnegative().default(5),
      /** Appended to the browser user agent so the visits can be filtered in analytics. */
      userAgentSuffix: z.string().default('ScriptAuditor/0.1'),
      locale: z.string().default('en-US'),
      timezone: z.string().default('UTC'),
      viewport: z
        .object({ width: z.number().int().positive(), height: z.number().int().positive() })
        .default({ width: 1366, height: 900 }),
    })
    .prefault({}),
  hosts: z
    .object({
      /**
       * Hosts (glob patterns) whose first appearance does not raise an alert, e.g. ad
       * auction bidders that come and go. Their scripts are still reviewed.
       */
      quiet: z.array(z.string()).default([]),
      /**
       * Script URLs (glob patterns) that are generated per request. Their content changes
       * are recorded but not reviewed.
       */
      ignoreContentChanges: z.array(z.string()).default([]),
    })
    .prefault({}),
  llm: llmSchema,
  alerts: z
    .object({
      /** Lowest verdict that is alerted. */
      minVerdict: z.enum(['suspicious', 'malicious']).default('suspicious'),
      /** Alert when a script comes from a host never seen before. */
      newHosts: z.boolean().default(true),
    })
    .prefault({}),
  notify: z.array(notifierSchema).default([]),
  site: z
    .object({
      enabled: z.boolean().default(true),
      title: z.string().default('Script Auditor'),
      /** Public URL of the status site, used for links in notifications. */
      url: z.url().optional(),
    })
    .prefault({}),
  retention: z
    .object({
      /** Forget scripts that have not been seen for this many days. */
      scriptDays: z.number().int().positive().default(14),
      /** Number of history events kept. */
      historyEvents: z.number().int().positive().default(2000),
      /** Number of versions kept per script. */
      versionsPerScript: z.number().int().positive().default(20),
    })
    .prefault({}),
});

export type RawConfig = z.input<typeof configSchema>;
type ParsedConfig = z.output<typeof configSchema>;

export interface Page {
  url: string;
  name: string;
}

export type Config = Omit<ParsedConfig, 'pages' | 'firstPartyDomains'> & {
  pages: Page[];
  firstPartyDomains: string[];
};

export type NotifierConfig = Config['notify'][number];

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(z.prettifyError(result.error));
  }
  const parsed = result.data;
  const pages = parsed.pages.map((page) => {
    const entry = typeof page === 'string' ? { url: page } : page;
    return { url: entry.url, name: entry.name ?? defaultPageName(entry.url) };
  });
  const firstPartyDomains =
    parsed.firstPartyDomains ?? unique(pages.map((page) => baseDomain(new URL(page.url).hostname)));
  return { ...parsed, pages, firstPartyDomains };
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return parseConfig(parseYaml(text));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${path}:\n${error.message}`);
    }
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** True if the host is one of the domains or a subdomain of one. */
export function isFirstParty(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Glob match for host names and URLs: `*` matches anything, everything else literally. */
export function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globMatch(value, pattern));
}

function defaultPageName(url: string): string {
  const { hostname, pathname, search } = new URL(url);
  return `${hostname}${pathname === '/' ? '' : pathname}${search}`;
}

/**
 * Last two labels of a host name (www.example.com -> example.com). Good enough as a
 * default; sites on multi-label public suffixes (example.co.uk) set firstPartyDomains.
 */
function baseDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
