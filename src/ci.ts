/** What the auditor can learn from the CI system it runs in. */
import { appendFile } from 'node:fs/promises';

/** Link to the current CI run, if the environment tells. */
export function runUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return env.CI_JOB_URL || undefined;
}

/** Adds markdown to the GitHub Actions job summary, if running there. */
export async function writeJobSummary(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}
