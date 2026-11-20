/** Minimal logger. In GitHub Actions, warnings and errors become workflow annotations. */

const githubActions = process.env.GITHUB_ACTIONS === 'true';
let verbose = process.env.SCRIPT_AUDITOR_DEBUG === '1';

export const log = {
  setVerbose(value: boolean): void {
    verbose = value;
  },
  debug(message: string): void {
    if (verbose) {
      console.error(`[debug] ${message}`);
    }
  },
  info(message: string): void {
    console.error(message);
  },
  warn(message: string): void {
    console.error(githubActions ? `::warning::${escape(message)}` : `[warn] ${message}`);
  },
  error(message: string): void {
    console.error(githubActions ? `::error::${escape(message)}` : `[error] ${message}`);
  },
};

/** Workflow commands end at a newline, so newlines must be encoded. */
function escape(message: string): string {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
