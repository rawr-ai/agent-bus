#!/usr/bin/env sh

set -eu

cd "$(dirname "$0")/.."
repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"
effect_version=$(bun --no-env-file -e '
  const declared = (await Bun.file("package.json").json()).dependencies.effect;
  const installed = (await Bun.file("node_modules/effect/package.json").json()).version;
  if (!/^\d+\.\d+\.\d+$/.test(declared) || declared !== installed) {
    throw new Error("Effect source requires the exact declared and installed package version to agree");
  }
  process.stdout.write(installed);
')
repo_ref="effect@$effect_version"

if [ -d "$repo_dir/.git" ]; then
  if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
    echo "Effect reference source is dirty; preserve it and resolve before preparing $repo_ref" >&2
    exit 1
  fi
  if [ "$(git -C "$repo_dir" remote get-url origin)" != "$repo_url" ]; then
    echo "Effect reference source has an unexpected origin; refusing to replace it" >&2
    exit 1
  fi
  current=$(git -C "$repo_dir" rev-parse HEAD)
  target=$(git -C "$repo_dir" rev-parse --verify "refs/tags/$repo_ref^{commit}" 2>/dev/null || true)
  if [ "$current" != "$target" ]; then
    git -C "$repo_dir" fetch --depth 1 origin tag "$repo_ref"
    git -C "$repo_dir" checkout --detach "refs/tags/$repo_ref"
  fi
else
  mkdir -p ".repos"
  git clone --depth 1 --branch "$repo_ref" "$repo_url" "$repo_dir"
fi
[ "$(git -C "$repo_dir" rev-parse HEAD)" = "$(git -C "$repo_dir" rev-parse "refs/tags/$repo_ref^{commit}")" ]
echo "Effect reference source: $repo_ref"
