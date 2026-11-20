import type { RunReport } from '../report.js';
import type { Notifier } from './types.js';

/** Prints what a notifier would send instead of sending it. */
export class DryRunNotifier implements Notifier {
  constructor(
    readonly name: string,
    private readonly format: (report: RunReport) => unknown,
    private readonly print: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
  ) {}

  async notify(report: RunReport): Promise<boolean> {
    const message = this.format(report);
    if (message === undefined) {
      return false;
    }
    this.print(`--- ${this.name} (dry run, not sent) ---\n${JSON.stringify(message, null, 2)}`);
    return true;
  }
}
