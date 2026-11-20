import type { Config } from '../config.js';
import { ConfigError } from '../config.js';
import { OpenAIReviewer } from './openai.js';
import type { Reviewer } from './types.js';

export type { Reviewer, ReviewRequest, ReviewResult } from './types.js';

/** The configured reviewer, or undefined for `provider: none`. */
export function createReviewer(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Reviewer | undefined {
  const { llm } = config;
  switch (llm.provider) {
    case 'none':
      return undefined;
    case 'openai': {
      const apiKey = env[llm.apiKeyEnv];
      if (!apiKey) {
        throw new ConfigError(
          `llm.provider is openai, but the environment variable ${llm.apiKeyEnv} is not set`,
        );
      }
      return new OpenAIReviewer({
        apiKey,
        model: llm.model,
        ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
      });
    }
  }
}
