#!/usr/bin/env bash
# Updates a README on a branch and pushes it, if its content changed.
#
#   readme-commit.sh <branch> <readme> <command...>
#
# Works on the newest commit of <branch>, in a separate worktree, so the checkout of the
# workflow is left alone. <command> is called with the README's path appended and rewrites
# it in place. If someone pushed in between, it starts over from their commit.
#
# Never fails: the audit data is saved by then, and a README that could not be updated
# (branch protection, no markers, a race lost three times) is only worth a warning.
set -uo pipefail

branch=${1:?usage: readme-commit.sh <branch> <readme> <command...>}
readme=${2:?readme missing}
shift 2
[ $# -gt 0 ] || { echo "command missing" >&2; exit 2; }

warn() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::warning::README not updated: $1"
  else
    echo "README not updated: $1" >&2
  fi
  exit 0
}

work=$(mktemp -d)
trap 'git worktree remove --force "$work" >/dev/null 2>&1; rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-github-actions[bot]}
export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

for attempt in 1 2 3; do
  git fetch --quiet --no-tags --depth=1 origin "refs/heads/$branch" ||
    warn "could not fetch $branch"
  tip=$(git rev-parse FETCH_HEAD)
  if [ "$attempt" = 1 ]; then
    git worktree add --quiet --detach "$work" "$tip" || warn "could not check out $branch"
  else
    git -C "$work" checkout --quiet --force --detach "$tip" || warn "could not check out $branch"
  fi
  [ -f "$work/$readme" ] || warn "$branch has no $readme"

  "$@" "$work/$readme" || warn "the update command failed"
  if git -C "$work" diff --quiet -- "$readme"; then
    echo "$readme is up to date"
    exit 0
  fi
  git -C "$work" commit --quiet -m "docs: update the script audit status [skip ci]" -- "$readme" ||
    warn "could not commit"
  if git -C "$work" push --quiet origin "HEAD:refs/heads/$branch"; then
    echo "Updated $readme on $branch"
    exit 0
  fi
  echo "Push of $readme rejected (attempt $attempt), retrying from the newest commit" >&2
done
warn "pushing to $branch was rejected; is the branch protected?"
