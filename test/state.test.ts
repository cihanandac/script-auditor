import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/script-key.js';
import { DataStore, emptyState, reviewKeyFor } from '../src/state.js';

const now = new Date('2026-11-20T12:00:00Z');

describe('DataStore', () => {
  let dir: string;
  let store: DataStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-'));
    store = new DataStore(join(dir, 'data'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with an empty state when nothing was saved yet', async () => {
    expect(await store.load(now)).toEqual(emptyState(now));
  });

  it('saves and loads the state', async () => {
    const state = emptyState(now);
    state.runs = 3;
    state.hosts['cdn.example.net'] = { firstSeen: 'a', lastSeen: 'b' };
    await store.save(state);
    expect(await store.load(now)).toEqual(state);
    expect(await readdir(join(dir, 'data'))).toEqual(['state.json']);
  });

  it('refuses a state written by an incompatible release', async () => {
    await store.save({ ...emptyState(now), version: 99 });
    await expect(store.load(now)).rejects.toThrow(/version 99/);
  });

  it('stores bodies by hash and prunes the ones no longer referenced', async () => {
    const bodies = ['current', 'old', 'queued-old', 'queued-new'].map((text) => ({
      text,
      sha: sha256(text),
    }));
    for (const { text, sha } of bodies) {
      await store.writeBlob(sha, Buffer.from(text));
      await store.writeBlob(sha, Buffer.from(text)); // idempotent
    }
    const [current, old, queuedOld, queuedNew] = bodies.map((body) => body.sha) as [
      string,
      string,
      string,
      string,
    ];
    const state = emptyState(now);
    state.scripts['https://cdn.example.net/a.js'] = {
      key: 'https://cdn.example.net/a.js',
      url: 'https://cdn.example.net/a.js',
      host: 'cdn.example.net',
      sha256: current,
      size: 7,
      firstSeen: '',
      lastSeen: '',
      lastChanged: '',
      pages: [],
      versions: [],
    };
    state.pending.push({
      reviewKey: reviewKeyFor(queuedNew, queuedOld),
      kind: 'changed',
      key: 'k',
      url: 'u',
      host: 'h',
      oldSha256: queuedOld,
      newSha256: queuedNew,
      pages: [],
      newHost: false,
      queuedAt: '',
      attempts: 0,
    });

    expect(await store.pruneBlobs(state)).toBe(1);
    expect(await store.readBlob(old)).toBeUndefined();
    expect((await store.readBlob(current))?.toString()).toBe('current');
    expect((await store.readBlob(queuedOld))?.toString()).toBe('queued-old');
  });

  it('rejects blob names that are not hashes', async () => {
    await writeFile(join(dir, 'x'), '');
    await expect(store.readBlob('../x')).rejects.toThrow(/Not a sha256/);
  });
});

describe('reviewKeyFor', () => {
  it('distinguishes new scripts from changes', () => {
    expect(reviewKeyFor('b')).toBe('new:b');
    expect(reviewKeyFor('b', 'a')).toBe('changed:a..b');
  });
});
