/** Runs scripts/readme-commit.sh against a local bare repository. */
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = resolve('scripts/readme-commit.sh');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

describe('readme-commit.sh', () => {
  let dir: string;
  let remote: string;
  let checkout: string;
  let other: string;

  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });
  const remoteReadme = async () => (await git(remote, 'show', 'main:README.md')).stdout;
  const commits = async () =>
    Number((await git(remote, 'rev-list', '--count', 'main')).stdout.trim());
  /** Runs the script with a command that writes `content` into the README. */
  const script = (content: string, extra = '') =>
    run(
      'bash',
      [SCRIPT, 'main', 'README.md', 'bash', '-c', `${extra}printf %s '${content}' > "$0"`],
      { cwd: checkout, env: { ...process.env, GITHUB_ACTIONS: '' } },
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-auditor-readme-commit-'));
    remote = join(dir, 'remote.git');
    checkout = join(dir, 'checkout');
    other = join(dir, 'other');
    await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await run('git', ['clone', '--quiet', remote, other]);
    await writeFile(join(other, 'README.md'), 'start');
    await writeFile(join(other, 'notes.txt'), 'one');
    await git(other, 'add', '.');
    await git(other, ...ID, 'commit', '--quiet', '-m', 'init');
    await git(other, 'push', '--quiet', 'origin', 'main');
    await run('git', ['clone', '--quiet', '--depth=1', `file://${remote}`, checkout]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('commits a changed README and leaves an unchanged one alone', async () => {
    await script('status 1');
    expect(await remoteReadme()).toBe('status 1');
    expect(await commits()).toBe(2);
    const { stdout } = await script('status 1');
    expect(stdout).toMatch(/up to date/);
    expect(await commits()).toBe(2);
    // The workflow's own checkout is untouched
    expect((await git(checkout, 'status', '--porcelain')).stdout).toBe('');
    expect((await git(checkout, 'worktree', 'list')).stdout.trim().split('\n')).toHaveLength(1);
  });

  it('starts over from the newest commit when someone pushed in between', async () => {
    await git(other, 'pull', '--quiet');
    // The command pushes a commit of its own the first time it runs, as a colleague would
    const flag = join(dir, 'raced');
    const race =
      `[ -e ${flag} ] || { touch ${flag}; cd ${other} && echo two > notes.txt && ` +
      `git -c user.name=t -c user.email=t@t commit -qam other && git push -q origin main; cd - >/dev/null; }; `;
    const { stderr } = await script('status 2', race);
    expect(stderr).toMatch(/rejected \(attempt 1\)/);
    expect(await remoteReadme()).toBe('status 2');
    expect((await git(remote, 'show', 'main:notes.txt')).stdout).toBe('two\n');
    expect(await commits()).toBe(3);
  });

  it('only warns when the push is refused', async () => {
    const hook = join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const { stderr } = await script('status 3');
    expect(stderr).toMatch(/README not updated: pushing to main was rejected/);
    expect(await remoteReadme()).toBe('start');
  });

  it('only warns when the update command fails', async () => {
    const { stderr } = await script('x', 'exit 1; ');
    expect(stderr).toMatch(/README not updated: the update command failed/);
    expect(await commits()).toBe(1);
  });
});
