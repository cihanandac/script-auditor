#!/usr/bin/env bash
# Keeps the auditor's data directory on a branch of the repository the workflow runs in.
#
#   data-branch.sh restore <branch> <dir>   copy the branch's files into <dir> (empty if none)
#   data-branch.sh save <branch> <dir>      replace the branch with one commit holding <dir>
#
# The branch never accumulates history: each save is a single commit without parent, pushed
# with --force, so script bodies of old versions do not pile up in the repository. The
# history the status site shows lives in state.json.
#
# Runs inside the checked-out repository and pushes with the credentials actions/checkout
# (or the CI) configured for the "origin" remote.
set -euo pipefail

command=${1:?usage: data-branch.sh restore|save <branch> <dir>}
branch=${2:?branch missing}
dir=${3:?directory missing}

case "$command" in
  restore)
    rm -rf "$dir"
    mkdir -p "$dir"
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      git fetch --quiet --no-tags --depth=1 origin "refs/heads/$branch"
      # git archive writes the files without touching the index or work tree of the checkout
      git archive FETCH_HEAD | tar -x -C "$dir"
      echo "Restored the audit data from the $branch branch"
    else
      echo "No $branch branch yet: this is the first run"
    fi
    ;;
  save)
    if [ ! -f "$dir/state.json" ]; then
      echo "No state.json in $dir, nothing to save" >&2
      exit 1
    fi
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
    git push --quiet --force origin "$commit:refs/heads/$branch"
    echo "Saved the audit data to the $branch branch ($commit)"
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
