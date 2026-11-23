/**
 * Runs scripts/data-branch.sh against a local bare repository. CI used to check only its
 * syntax, which is how a failed restore that overwrote the history went unnoticed.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = resolve('scripts/data-branch.sh');

describe('data-branch.sh', () => {
  let dir: string;
  let remote: string;
  let checkout: string;
  let data: string;

  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });
  const script = (...args: string[]) => run('bash', [SCRIPT, ...args], { cwd: checkout });
  const remoteFile = async (path: string) =>
    (await git(remote, 'show', `script-auditor-data:${path}`)).stdout;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-branch-'));
    remote = join(dir, 'remote.git');
    checkout = join(dir, 'checkout');
    data = join(dir, 'data');
    await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await run('git', ['clone', '--quiet', remote, checkout]);
    await git(
      checkout,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'init',
    );
    await git(checkout, 'push', '--quiet', 'origin', 'main');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty, saves and restores the data', async () => {
    expect((await script('restore', 'script-auditor-data', data)).stdout).toMatch(/first run/);
    await writeFile(join(data, 'state.json'), '{"runs":1}');
    await script('save', 'script-auditor-data', data);
    expect(await remoteFile('state.json')).toBe('{"runs":1}');

    await script('restore', 'script-auditor-data', data);
    expect(await readFile(join(data, 'state.json'), 'utf8')).toBe('{"runs":1}');
    await writeFile(join(data, 'state.json'), '{"runs":2}');
    await script('save', 'script-auditor-data', data);
    expect(await remoteFile('state.json')).toBe('{"runs":2}');
    // Still a single commit
    expect((await git(remote, 'rev-list', '--count', 'script-auditor-data')).stdout.trim()).toBe(
      '1',
    );
  });

  it('fails instead of starting over when the remote cannot be read', async () => {
    await script('restore', 'script-auditor-data', data);
    await writeFile(join(data, 'state.json'), '{"runs":1}');
    await script('save', 'script-auditor-data', data);

    await git(checkout, 'remote', 'set-url', 'origin', join(dir, 'unreachable.git'));
    await expect(script('restore', 'script-auditor-data', data)).rejects.toThrow(/Could not read/);
    await expect(script('save', 'script-auditor-data', data)).rejects.toThrow();
    await git(checkout, 'remote', 'set-url', 'origin', remote);
    expect(await remoteFile('state.json')).toBe('{"runs":1}');
  });

  it('does not overwrite data another run saved in between', async () => {
    await script('restore', 'script-auditor-data', data);
    await writeFile(join(data, 'state.json'), '{"runs":1}');
    await script('save', 'script-auditor-data', data);

    await script('restore', 'script-auditor-data', data);
    const other = join(dir, 'other');
    await script('restore', 'script-auditor-data', other);
    await writeFile(join(other, 'state.json'), '{"runs":2}');
    await script('save', 'script-auditor-data', other);

    await writeFile(join(data, 'state.json'), '{"runs":"stale"}');
    await expect(script('save', 'script-auditor-data', data)).rejects.toThrow();
    expect(await remoteFile('state.json')).toBe('{"runs":2}');
  });

  it('refuses the default branch', async () => {
    await expect(script('restore', 'main', data)).rejects.toThrow(/default branch/);
  });
});
