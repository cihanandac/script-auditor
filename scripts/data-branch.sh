#!/usr/bin/env bash
# Keeps the auditor's data directory on a branch of the repository the workflow runs in.
#
#   data-branch.sh restore <branch> <dir>   copy the branch's files into <dir> (empty if none)
#   data-branch.sh save <branch> <dir>      replace the branch with one commit holding <dir>
#
# The branch never accumulates history: each save is a single commit without parent that
# replaces the branch, so script bodies of old versions do not pile up in the repository.
# The history the status site shows lives in state.json. Save only replaces the commit
# restore started from, and restore fails rather than start over when the remote cannot
# be read.
#
# Runs inside the checked-out repository and pushes with the credentials actions/checkout
# (or the CI) configured for the "origin" remote.
set -euo pipefail

command=${1:?usage: data-branch.sh restore|save <branch> <dir>}
branch=${2:?branch missing}
dir=${3:?directory missing}
# The commit restore started from; save only replaces the branch if it still points there
base_file="$dir.base"

# Refuse the repository's default branch: saving replaces the whole branch
# (an unreachable remote is reported by restore below)
default_branch=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#\1#p' || true)
if [ "$branch" = "$default_branch" ]; then
  echo "The data branch must not be the default branch ($default_branch)" >&2
  exit 2
fi

case "$command" in
  restore)
    rm -rf "$dir" "$base_file"
    mkdir -p "$dir"
    # Exit code 2 means the remote answered and has no such branch. Anything else (no
    # network, no access) must fail the run: treating it as a first run would record a new
    # baseline and overwrite the real history on save.
    status=0
    heads=$(git ls-remote --exit-code --heads origin "refs/heads/$branch") || status=$?
    case "$status" in
      0)
        git fetch --quiet --no-tags --depth=1 origin "refs/heads/$branch"
        # git archive writes the files without touching the index or work tree of the checkout
        git archive FETCH_HEAD | tar -x -C "$dir"
        printf '%s\n' "${heads%%[[:space:]]*}" > "$base_file"
        echo "Restored the audit data from the $branch branch"
        ;;
      2)
        : > "$base_file"
        echo "No $branch branch yet: this is the first run"
        ;;
      *)
        echo "Could not read the $branch branch from origin (git exit code $status)" >&2
        exit 1
        ;;
    esac
    ;;
  save)
    if [ ! -f "$dir/state.json" ]; then
      echo "No state.json in $dir, nothing to save" >&2
      exit 1
    fi
    if [ ! -f "$base_file" ]; then
      echo "Restore did not run for $dir, refusing to overwrite the $branch branch" >&2
      exit 1
    fi
    base=$(cat "$base_file")
    index=$(mktemp -d)/index
    export GIT_INDEX_FILE=$index
    export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-script-auditor}
    export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-script-auditor@users.noreply.github.com}
    export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
    export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
    git --work-tree="$dir" add --all --force .
    tree=$(git write-tree)
    commit=$(git commit-tree "$tree" -m "Audit data $(date -u +%Y-%m-%dT%H:%M:%SZ)")
    rm -rf "$(dirname "$index")"
    # Replace the branch only if nobody changed it since restore (an empty base means it
    # must still not exist)
    git push --quiet --force-with-lease="refs/heads/$branch:$base" origin "$commit:refs/heads/$branch"
    echo "Saved the audit data to the $branch branch ($commit)"
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
