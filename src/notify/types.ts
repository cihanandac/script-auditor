import type { RunReport } from '../report.js';

export type NotifyEvent = 'alert' | 'error' | 'change';

export interface Notifier {
  readonly name: string;
  /** Sends the report if it contains something this notifier is subscribed to. */
  notify(report: RunReport): Promise<boolean>;
}

/** Whether the report has anything for a notifier subscribed to these events. */
export function hasNews(report: RunReport, on: NotifyEvent[]): boolean {
  return (
    (on.includes('alert') && report.alerts.length > 0) ||
    (on.includes('error') && report.errors.length > 0) ||
    (on.includes('change') && report.changes.length > 0)
  );
}
