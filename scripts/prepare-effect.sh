#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"
# Keep in step with the effect version in package.json.
repo_ref="effect@4.0.6"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone --depth 1 --branch "$repo_ref" "$repo_url" "$repo_dir"
