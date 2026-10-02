#!/usr/bin/env bash
# Maintainer-only: generate the workshop checkpoint branches from main. Attendees never run this.
#
# usage: scripts/build-checkpoints.sh [--source <ref>] [--remote <name>] [--no-push] [--only <name>]
#   --source <ref>   commit to build from (default HEAD)
#   --remote <name>  remote to push to (default origin)
#   --no-push        build the local branches only and print their names; push nothing
#   --only <name>    build (and push) just one checkpoint, e.g. --only checkpoint-3
#
# Each checkpoint-N branch is the source commit plus ONE generated commit: the files in
# checkpoints/checkpoint-N/ copied over the tree, and checkpoints/ deleted. The work happens in a
# throwaway `git worktree`, so your current branch, HEAD and working tree are never touched; the
# local branch checkpoint-N is (re)set to the generated commit and pushed with --force-with-lease.
# Safe to rerun. Requires git >= 2.17 (`git worktree remove`). See docs/checkpoints.md.
set -euo pipefail

CHECKPOINTS=(checkpoint-0 checkpoint-1 checkpoint-2 checkpoint-2-cut checkpoint-3 checkpoint-4)

die() {
  echo "build-checkpoints: $*" >&2
  exit 1
}

usage() {
  echo "usage: scripts/build-checkpoints.sh [--source <ref>] [--remote <name>] [--no-push] [--only <name>]" >&2
  exit 2
}

source_ref=HEAD
remote=origin
push=1
only=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; source_ref=$2; shift 2 ;;
    --remote) [ "$#" -ge 2 ] || usage; remote=$2; shift 2 ;;
    --no-push) push=0; shift ;;
    --only) [ "$#" -ge 2 ] || usage; only=$2; shift 2 ;;
    -h | --help) usage ;;
    *) echo "build-checkpoints: unknown argument: $1" >&2; usage ;;
  esac
done

# git >= 2.17 for `git worktree remove`.
version=$(git --version | sed -E 's/^git version ([0-9]+)\.([0-9]+).*/\1 \2/')
read -r major minor <<< "$version"
if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 17 ]; }; then
  die "requires git >= 2.17 (found: $(git --version))"
fi

top=$(git rev-parse --show-toplevel) || die "not inside a git repository"
cd "$top"

source_sha=$(git rev-parse --verify "${source_ref}^{commit}") || die "unknown --source: $source_ref"
short_sha=$(git rev-parse --short "$source_sha")

names=("${CHECKPOINTS[@]}")
if [ -n "$only" ]; then
  case " ${CHECKPOINTS[*]} " in
    *" $only "*) names=("$only") ;;
    *) die "--only: unknown checkpoint '$only' (one of: ${CHECKPOINTS[*]})" ;;
  esac
fi

for name in "${names[@]}"; do
  git cat-file -e "${source_sha}:checkpoints/${name}/CHECKPOINT" 2> /dev/null ||
    die "$short_sha has no checkpoints/$name/ (commit the overlays first)"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/build-checkpoints.XXXXXX")
worktree="$work/tree"
cleanup() {
  git -C "$top" worktree remove --force "$worktree" > /dev/null 2>&1 || true
  rm -rf "$work"
  git -C "$top" worktree prune > /dev/null 2>&1 || true
}
trap cleanup EXIT

for name in "${names[@]}"; do
  git worktree add --quiet --detach "$worktree" "$source_sha"
  (
    cd "$worktree"
    cp -R "checkpoints/$name/." .
    rm -rf checkpoints
    git add -A
    git commit --quiet --no-verify -m "$name: generated from $short_sha" \
      -m "Overlay checkpoints/$name/ applied to $source_sha by scripts/build-checkpoints.sh."
  )
  git branch --force "$name" "$(git -C "$worktree" rev-parse HEAD)" > /dev/null
  git worktree remove --force "$worktree"
  echo "built $name ($(git rev-parse --short "$name"), from $short_sha)"
done

if [ "$push" -eq 1 ]; then
  for name in "${names[@]}"; do
    # Lease against what we last saw of <remote>/<name>; a branch the remote does not have yet
    # is created.
    git push --quiet --force-with-lease="$name" "$remote" "$name:$name"
    echo "pushed $name to $remote"
  done
else
  echo "--no-push: nothing pushed. Branches built: ${names[*]}"
fi
