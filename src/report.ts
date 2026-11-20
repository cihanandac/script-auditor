/** What a run found, in the shape notifiers and the CLI summary need. */
import type { Review } from './state.js';

export interface Alert {
  key: string;
  url: string;
  host: string;
  pages: string[];
  /** Id of the script's page on the status site. */
  scriptId: string;
  /** The script comes from a host never seen before. */
  newHost: boolean;
  /** Set when the script was reviewed in this run (an alert has a verdict at or above alerts.minVerdict, or a new host). */
  review?: Review;
}

export interface ChangeSummary {
  kind: 'new' | 'changed';
  url: string;
  host: string;
  scriptId: string;
  review?: Review;
}

export interface RunReport {
  title: string;
  /** Status site, if configured. */
  siteUrl?: string;
  /** CI run that produced the report, if known. */
  runUrl?: string;
  startedAt: string;
  finishedAt: string;
  baseline: boolean;
  stats: {
    pages: number;
    pagesFailed: number;
    scripts: number;
    hosts: number;
    changes: number;
    absorbed: number;
    reviewed: number;
    pendingReviews: number;
  };
  alerts: Alert[];
  changes: ChangeSummary[];
  errors: string[];
}

/** Link to a script's page on the status site. */
export function scriptLink(report: RunReport, scriptId: string): string | undefined {
  return report.siteUrl
    ? `${report.siteUrl.replace(/\/$/, '')}/scripts/${scriptId}.html`
    : undefined;
}
