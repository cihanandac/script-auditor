/**
 * Everything the auditor remembers between runs lives in one data directory:
 *
 *   state.json          scripts, hosts, pages, reviews, review queue and history
 *   blobs/<sha256>.js   script bodies, needed to diff the next version against
 *
 * Only the bodies of the current and the previous version of each script and of queued
 * reviews are kept, so the directory does not grow with every vendor release.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_VERSION = 1;

export type Verdict = 'benign' | 'suspicious' | 'malicious';

export const VERDICT_RANK: Record<Verdict, number> = { benign: 0, suspicious: 1, malicious: 2 };

export interface Review {
  verdict: Verdict;
  /** 0 to 1 */
  confidence: number;
  summary: string;
  reasons: string[];
  /** LLM provider, or `heuristic` for changes judged without one. */
  provider: string;
  model: string;
  reviewedAt: string;
}

export interface ScriptVersion {
  sha256: string;
  size: number;
  url: string;
  firstSeen: string;
  lastSeen: string;
  /** Key into State.reviews once this version has been reviewed. */
  reviewKey?: string;
  /** Set when every attempt to review this version failed: when, and the last error. */
  reviewFailed?: { at: string; message: string };
}

export interface ScriptRecord {
  key: string;
  /** Last full URL the script was loaded from. */
  url: string;
  host: string;
  sha256: string;
  size: number;
  firstSeen: string;
  lastSeen: string;
  lastChanged: string;
  /** Pages that ran the script in the last run that saw it. */
  pages: string[];
  /** Newest last. */
  versions: ScriptVersion[];
  /** Generated per request: content changes are not reviewed. */
  perRequest?: boolean;
}

export interface HostRecord {
  firstSeen: string;
  lastSeen: string;
}

export interface PageRecord {
  url: string;
  name: string;
  finalUrl?: string;
  lastScanned: string;
  /** Keys of the scripts the page ran in the last run. */
  scriptKeys: string[];
  error?: string;
}

export interface PendingReview {
  reviewKey: string;
  kind: 'new' | 'changed';
  key: string;
  url: string;
  host: string;
  oldSha256?: string;
  newSha256: string;
  pages: string[];
  newHost: boolean;
  queuedAt: string;
  attempts: number;
}

export type HistoryEventType =
  | 'baseline'
  | 'new-script'
  | 'changed'
  | 'removed'
  | 'new-host'
  | 'reviewed'
  | 'review-skipped'
  | 'error';

export interface HistoryEvent {
  at: string;
  type: HistoryEventType;
  key?: string;
  url?: string;
  host?: string;
  page?: string;
  sha256?: string;
  oldSha256?: string;
  verdict?: Verdict;
  message?: string;
}

export interface RunInfo {
  startedAt: string;
  finishedAt: string;
  consentConfigured: boolean;
  consentAccepted: boolean;
}

export interface State {
  version: number;
  createdAt: string;
  updatedAt: string;
  runs: number;
  lastRun?: RunInfo;
  pages: Record<string, PageRecord>;
  scripts: Record<string, ScriptRecord>;
  hosts: Record<string, HostRecord>;
  reviews: Record<string, Review>;
  pending: PendingReview[];
  /** Newest last. */
  history: HistoryEvent[];
}

export function emptyState(now: Date): State {
  const at = now.toISOString();
  return {
    version: STATE_VERSION,
    createdAt: at,
    updatedAt: at,
    runs: 0,
    pages: {},
    scripts: {},
    hosts: {},
    reviews: {},
    pending: [],
    history: [],
  };
}

export function reviewKeyFor(newSha256: string, oldSha256?: string): string {
  return oldSha256 ? `changed:${oldSha256}..${newSha256}` : `new:${newSha256}`;
}

export class DataStore {
  constructor(readonly dir: string) {}

  private get statePath(): string {
    return join(this.dir, 'state.json');
  }

  private get blobDir(): string {
    return join(this.dir, 'blobs');
  }

  async load(now: Date): Promise<State> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState(now);
      }
      throw error;
    }
    const state = JSON.parse(text) as State;
    if (state.version !== STATE_VERSION) {
      throw new Error(
        `${this.statePath} has version ${state.version}, this release reads version ${STATE_VERSION}`,
      );
    }
    return state;
  }

  async save(state: State): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomically(this.statePath, `${JSON.stringify(state, null, 1)}\n`);
  }

  async writeBlob(sha256: string, body: Uint8Array): Promise<void> {
    await mkdir(this.blobDir, { recursive: true });
    const path = this.blobPath(sha256);
    try {
      await writeFile(path, body, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  async readBlob(sha256: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.blobPath(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /** Deletes the bodies that are neither a current or previous version nor queued. */
  async pruneBlobs(state: State): Promise<number> {
    const keep = new Set<string>();
    for (const script of Object.values(state.scripts)) {
      keep.add(script.sha256);
      // The previous version too, to look into what the last change changed
      for (const version of script.versions.slice(-2)) {
        keep.add(version.sha256);
      }
    }
    for (const item of state.pending) {
      keep.add(item.newSha256);
      if (item.oldSha256) {
        keep.add(item.oldSha256);
      }
    }
    let names: string[];
    try {
      names = await readdir(this.blobDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!keep.has(name.replace(/\.js$/, ''))) {
        await rm(join(this.blobDir, name));
        removed++;
      }
    }
    return removed;
  }

  private blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Not a sha256: ${sha256}`);
    }
    return join(this.blobDir, `${sha256}.js`);
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}
