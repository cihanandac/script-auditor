#!/usr/bin/env node
/**
 * script-auditor run        audit the configured pages (the default command)
 * script-auditor inventory  crawl once and print the third-party scripts per page
 * script-auditor site       rebuild the status site from the stored state
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runUrlFromEnv, writeJobSummary } from './ci.js';
import type { Config } from './config.js';
import { ConfigError, loadConfig } from './config.js';
import type { CrawlResult } from './crawl.js';
import { crawl } from './crawl.js';
import { log } from './log.js';
import { createNotifiers } from './notify/index.js';
import { createReviewer } from './review/index.js';
import { runAudit } from './run.js';
import { buildSite } from './site.js';
import { DataStore } from './state.js';
import { formatSummary } from './summary.js';

const USAGE = `Usage: script-auditor [run|inventory|site] [options]

Commands:
  run         Audit the configured pages: crawl, compare with the last run, review
              changes with the LLM, update the data directory and the status site,
              send notifications. (default)
  inventory   Crawl once and print the third-party scripts of every page. Stores nothing.
  site        Rebuild the status site from the data directory.

Options:
  -c, --config <file>     Configuration file (default: script-auditor.yml)
  -d, --data-dir <dir>    Where state and script bodies are kept (default: .script-auditor-data)
  -s, --site-dir <dir>    Where the status site is written (default: site)
      --dry-run           Print notifications instead of sending them
      --fail-on-alert     Exit with code 3 when the run raised alerts
  -v, --verbose           More logging
  -h, --help              Show this help
      --version           Show the version

Exit codes: 0 done, 1 failed, 2 configuration problem, 3 alerts (with --fail-on-alert).`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c', default: 'script-auditor.yml' },
        'data-dir': { type: 'string', short: 'd', default: '.script-auditor-data' },
        'site-dir': { type: 'string', short: 's', default: 'site' },
        'dry-run': { type: 'boolean', default: false },
        'fail-on-alert': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    log.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }
  log.setVerbose(values.verbose);
  const command = positionals[0] ?? 'run';

  try {
    const config = await loadConfig(values.config);
    switch (command) {
      case 'run':
        return await run(config, {
          dataDir: values['data-dir'],
          siteDir: values['site-dir'],
          dryRun: values['dry-run'],
          failOnAlert: values['fail-on-alert'],
        });
      case 'inventory':
        printInventory(await crawl(config));
        return 0;
      case 'site': {
        const state = await new DataStore(values['data-dir']).load(new Date());
        await buildSite(state, config, values['site-dir']);
        log.info(`Status site written to ${values['site-dir']}`);
        return 0;
      }
      default:
        log.error(`Unknown command: ${command}`);
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      return 2;
    }
    log.error(`Run failed: ${(error as Error).stack ?? String(error)}`);
    return 1;
  }
}

interface RunFlags {
  dataDir: string;
  siteDir: string;
  dryRun: boolean;
  failOnAlert: boolean;
}

async function run(config: Config, flags: RunFlags): Promise<number> {
  // Fail on missing secrets before spending minutes on the crawl
  const reviewer = createReviewer(config);
  const notifiers = createNotifiers(config, process.env, { dryRun: flags.dryRun });
  const runUrl = runUrlFromEnv();
  try {
    const outcome = await runAudit({
      config,
      dataDir: flags.dataDir,
      siteDir: flags.siteDir,
      ...(reviewer ? { reviewer } : {}),
      notifiers,
      ...(runUrl ? { runUrl } : {}),
    });
    const summary = formatSummary(outcome.report);
    console.log(summary);
    await writeJobSummary(summary);
    if (outcome.notifyErrors.length > 0) {
      return 1;
    }
    return flags.failOnAlert && outcome.report.alerts.length > 0 ? 3 : 0;
  } catch (error) {
    // Tell the humans the audit itself is broken; silence must not mean "all good"
    const message = `Run failed: ${(error as Error).message}`;
    for (const notifier of notifiers) {
      await notifier
        .notify({
          title: config.site.title,
          ...(runUrl ? { runUrl } : {}),
          ...(config.site.url ? { siteUrl: config.site.url } : {}),
          startedAt: '',
          finishedAt: new Date().toISOString(),
          baseline: false,
          stats: {
            pages: config.pages.length,
            pagesFailed: 0,
            scripts: 0,
            hosts: 0,
            changes: 0,
            absorbed: 0,
            reviewed: 0,
            pendingReviews: 0,
          },
          alerts: [],
          changes: [],
          errors: [message],
        })
        .catch((notifyError: Error) => log.error(`${notifier.name}: ${notifyError.message}`));
    }
    throw error;
  }
}

function printInventory(result: CrawlResult): void {
  const hosts = new Set([...result.scripts.values()].map((script) => script.host));
  console.log(
    `${result.scripts.size} third-party scripts from ${hosts.size} hosts on ${result.pages.length} pages` +
      (result.consentConfigured ? ` (consent accepted: ${result.consentAccepted})` : ''),
  );
  for (const page of result.pages) {
    console.log(`\n${page.name}  ${page.url}`);
    if (page.error) {
      console.log(`  ERROR ${page.error}`);
      continue;
    }
    const byHost = new Map<string, string[]>();
    for (const url of page.scriptUrls) {
      const host = result.scripts.get(url)?.host ?? new URL(url).hostname;
      byHost.set(host, [...(byHost.get(host) ?? []), url]);
    }
    for (const [host, urls] of [...byHost.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${host} (${urls.length})`);
      for (const url of urls) {
        console.log(`    ${url}`);
      }
    }
  }
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** True when this file is the program, also when started through the npm bin symlink. */
function isEntryPoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
