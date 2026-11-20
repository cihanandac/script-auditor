import type { Config } from '../config.js';
import { ConfigError } from '../config.js';
import { DryRunNotifier } from './dry-run.js';
import { SlackNotifier, buildSlackMessage } from './slack.js';
import type { Notifier } from './types.js';

export type { Notifier, NotifyEvent } from './types.js';

export interface NotifierOptions {
  /** Print the messages instead of sending them; no secrets needed. */
  dryRun?: boolean;
}

export function createNotifiers(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  options: NotifierOptions = {},
): Notifier[] {
  return config.notify.map((entry) => {
    switch (entry.type) {
      case 'slack': {
        if (options.dryRun) {
          return new DryRunNotifier('slack', (report) => buildSlackMessage(report, entry.on));
        }
        const webhookUrl = env[entry.webhookUrlEnv];
        if (!webhookUrl) {
          throw new ConfigError(
            `notify: slack needs the environment variable ${entry.webhookUrlEnv} (incoming webhook URL)`,
          );
        }
        return new SlackNotifier(webhookUrl, entry.on);
      }
    }
  });
}
