import type { Config } from '../config.js';
import { ConfigError } from '../config.js';
import { SlackNotifier } from './slack.js';
import type { Notifier } from './types.js';

export type { Notifier, NotifyEvent } from './types.js';

export function createNotifiers(config: Config, env: NodeJS.ProcessEnv = process.env): Notifier[] {
  return config.notify.map((entry) => {
    switch (entry.type) {
      case 'slack': {
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
