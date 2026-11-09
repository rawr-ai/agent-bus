#!/usr/bin/env sh
# Installs (or reinstalls) the agent-bus LaunchAgents.
#
# On the machine that hosts the bus:
#   ai.rawr.agent-bus.fluree  the bus's own Fluree transaction server (loopback only); its data
#                             and admin APIs require the token in fluree-token
#   ai.rawr.agent-bus         `agent-bus serve`: this machine's MCP endpoint and Codex delivery
# On first install it creates the signing key and token and points the bus at the Fluree ledger
# (config.json).
#
# On another machine, `--remote SSH_HOST` (an ssh host alias for the bus host):
#   ai.rawr.agent-bus.tunnel  an SSH tunnel to the bus host's server, on the same local port
#   ai.rawr.agent-bus         `agent-bus serve` for this machine's sessions
# and copies the token from the bus host.
#
# Rerunning is safe: existing config, credentials and messages are kept.
#
# --runtime-only --bun /absolute/path/to/bun updates just the managed command and serve
# LaunchAgent, without inspecting Fluree, SSH or credentials. It also supports rollback:
# run this retained installer with AGENT_BUS_REPO=/absolute/canonical/source and the old
# explicit Bun after restoring that source. The selected Bun must match its package pin.
# Full installs may omit --bun to select the Bun currently on PATH.
#
# --release /abs/releases/<id> --expect <manifest sha256> binds the managed command to a
# verified release instead of a source checkout (docs/frames/release-packaging.md). It needs
# no checkout: a release carries this installer as app/install-launch-agents.sh, its own Bun
# and its verifier. The release must sit directly in AGENT_BUS_RELEASES (default
# ~/.local/share/agent-bus/releases) and match the anchored manifest digest. Like
# --runtime-only it touches only the launcher and the serve LaunchAgent, and it records the
# previous launcher in the releases directory's sibling bindings/. Either mode adopts a
# launcher the other wrote, and keeps an existing owned serve LaunchAgent unchanged (its port
# and state directory included; a disagreeing AGENT_BUS_PORT or AGENT_BUS_DIR is refused).
# Before running anything a release holds, it checks the files it runs with system tools
# against the anchored manifest. Run this installer from known code: the reviewed checkout,
# or a release copy checked the same way first (docs/frames/release-packaging.md).
#
# AGENT_BUS_DIR, AGENT_BUS_FLUREE_PORT, AGENT_BUS_PORT, AGENT_BUS_LABEL (the label prefix) and
# AGENT_BUS_LAUNCHER (the managed `agent-bus` executable) override the defaults, so a
# disposable instance can run beside the real one. AGENT_BUS_REPO selects the source root.

set -eu

remote=""
release=""
expect=""
runtime_only=false
show_help=false
bun_bin=""
usage() {
  echo "usage: $0 [--remote SSH_HOST] [--bun /absolute/path/to/bun]"
  echo "       $0 --runtime-only --bun /absolute/path/to/bun"
  echo "       $0 --release /absolute/releases/<id> --expect <manifest sha256>"
  echo "AGENT_BUS_REPO may select an absolute source root, including for explicit rollback."
}
fail() { echo "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote|--bun)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$2" in --*) fail "$1 requires a value" ;; esac
      if [ "$1" = --remote ]; then
        [ -z "$remote" ] || fail "--remote was supplied more than once"
        remote=$2
      else
        [ -z "$bun_bin" ] || fail "--bun was supplied more than once"
        case "$2" in /*) bun_bin=$2 ;; *) fail "--bun must name an absolute executable path" ;; esac
      fi
      shift 2
      ;;
    --release|--expect)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$2" in --*) fail "$1 requires a value" ;; esac
      if [ "$1" = --release ]; then
        [ -z "$release" ] || fail "--release was supplied more than once"
        case "$2" in /*[!/]*) release=$2 ;; *) fail "--release must name an absolute directory" ;; esac
      else
        [ -z "$expect" ] || fail "--expect was supplied more than once"
        expect=$2
      fi
      shift 2
      ;;
    --runtime-only)
      [ "$runtime_only" = false ] || fail "--runtime-only was supplied more than once"
      runtime_only=true
      shift
      ;;
    --help|-h) show_help=true; shift ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
[ "$show_help" = false ] || { usage; exit 0; }
if [ "$runtime_only" = true ]; then
  [ -z "$remote" ] || fail "--runtime-only cannot be combined with --remote"
  [ -n "$bun_bin" ] || fail "--runtime-only requires an explicit --bun path"
fi
[ -n "$expect" ] && [ -z "$release" ] && fail "--expect requires --release"
# One spelling of the release for every check and the binding: no trailing separator, which
# would make a test of the path follow a link standing in its place.
while :; do case "$release" in */) release=${release%/} ;; *) break ;; esac; done
case "/$release/" in
  //) ;;
  */./*|*/../*) fail "--release must name a release directory, not . or .." ;;
esac
if [ -n "$release" ]; then
  [ "$runtime_only" = false ] || fail "--release cannot be combined with --runtime-only"
  [ -z "$remote" ] || fail "--release cannot be combined with --remote"
  [ -z "$bun_bin" ] || fail "--release runs the release's own Bun; omit --bun"
  [ -n "$expect" ] || fail "--release requires --expect with the recorded manifest digest"
fi

# A release names everything it runs, so release mode reads no source checkout.
repo_dir=""
if [ -z "$release" ]; then
  source_root="${AGENT_BUS_REPO:-$(cd "$(dirname "$0")/.." && pwd -P)}"
  case "$source_root" in /*) ;; *) fail "AGENT_BUS_REPO must name an absolute source root" ;; esac
  repo_dir=$(cd "$source_root" && pwd -P) || fail "source root does not exist: $source_root"
  [ -f "$repo_dir/src/bin.ts" ] || fail "source entry does not exist: $repo_dir/src/bin.ts"
  if [ -z "$bun_bin" ]; then
    bun_bin=$(command -v bun) || fail "bun is not on PATH; supply --bun /absolute/path/to/bun"
    bun_bin="$(cd "$(dirname "$bun_bin")" && pwd -P)/$(basename "$bun_bin")"
  fi
  [ -f "$bun_bin" ] && [ -x "$bun_bin" ] || fail "Bun is not an executable file: $bun_bin"
fi
bus_dir="${AGENT_BUS_DIR:-$HOME/.agent-bus}"
fluree_dir="$bus_dir/fluree"
port="${AGENT_BUS_FLUREE_PORT:-8095}"
url="http://127.0.0.1:$port"
bus_port="${AGENT_BUS_PORT:-8096}"
token_file="$bus_dir/fluree-token"
ledger="agent-bus:main"
agents="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
prefix="${AGENT_BUS_LABEL:-ai.rawr.agent-bus}"
launcher="${AGENT_BUS_LAUNCHER:-$HOME/.local/bin/agent-bus}"
releases="${AGENT_BUS_RELEASES:-$HOME/.local/share/agent-bus/releases}"
case "$releases" in /*) ;; *) fail "AGENT_BUS_RELEASES must be an absolute path" ;; esac
# Compare real paths: a release is recognised only directly inside this directory.
if [ -d "$releases" ]; then releases=$(cd "$releases" && pwd -P); fi
case "$launcher" in /*) ;; *) fail "AGENT_BUS_LAUNCHER must be an absolute path" ;; esac
case "$prefix" in ""|*/*) fail "AGENT_BUS_LABEL must be a nonempty label without slashes" ;; esac

if [ -n "$release" ]; then
  # The release must sit directly in the releases directory, by its real path.
  release_parent=$(cd "$release/.." 2>/dev/null && pwd -P) || fail "release directory does not exist: $release"
  [ "$release_parent" = "$releases" ] || fail "release is not directly inside $releases: $release"
  case "$(basename "$release")" in .*) fail "release name must not start with a dot" ;; esac
  [ -d "$release" ] && [ ! -L "$release" ] || fail "release is not a real directory: $release"
  release="$release_parent/$(basename "$release")"
  # Anchor with system tools before running anything the release holds: its manifest must
  # be the recorded one, and every file run here (its Bun, verifier and Bun config) a
  # regular file, not a link, with the bytes that manifest lists.
  for part in manifest.json app runtime; do
    [ -e "$release/$part" ] && [ ! -L "$release/$part" ] || fail "Release did not verify: $part is missing or a link: $release"
  done
  [ -f "$release/manifest.json" ] && [ -d "$release/app" ] && [ -d "$release/runtime" ] \
    || fail "Release did not verify: its manifest, app or runtime has the wrong type: $release"
  digest=$(/usr/bin/shasum -a 256 "$release/manifest.json" 2>/dev/null) || digest=""
  [ "${digest%% *}" = "$expect" ] || fail "Release did not verify against the expected manifest digest: $release"
  want=$(/usr/bin/plutil -extract bun.sha256 raw -o - "$release/manifest.json" 2>/dev/null) || want=""
  have=$(/usr/bin/shasum -a 256 "$release/runtime/bun" 2>/dev/null) || have=""
  [ -n "$want" ] && [ "${have%% *}" = "$want" ] || fail "Release did not verify: its Bun differs from its manifest: $release"
  checked=""
  i=0
  while listed=$(/usr/bin/plutil -extract "files.$i.path" raw -o - "$release/manifest.json" 2>/dev/null); do
    case "$listed" in
      runtime/bun|app/release.js|app/bunfig.toml)
        file="$release/$listed"
        [ -f "$file" ] && [ ! -L "$file" ] || fail "Release did not verify: $listed is not a regular file: $release"
        want=$(/usr/bin/plutil -extract "files.$i.sha256" raw -o - "$release/manifest.json" 2>/dev/null) || want=""
        have=$(/usr/bin/shasum -a 256 "$file" 2>/dev/null) || have=""
        [ -n "$want" ] && [ "${have%% *}" = "$want" ] || fail "Release did not verify: $listed differs from its manifest: $release"
        checked="$checked $listed"
        ;;
    esac
    i=$((i + 1))
  done
  for listed in runtime/bun app/release.js app/bunfig.toml; do
    case "$checked " in *" $listed "*) ;; *) fail "Release did not verify: its manifest does not list $listed: $release" ;; esac
  done
  bun_bin="$release/runtime/bun"
  # The release's own verifier checks every file; it writes nothing, not even Bun's cache.
  (cd / && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    "$bun_bin" --no-env-file --config="$release/app/bunfig.toml" "$release/app/release.js" verify "$release" --expect "$expect" >/dev/null) \
    || fail "Release did not verify against the expected manifest digest: $release"
fi

# Validate source, runtime and ownership before creating any directories or temporary files.
# Recognition is the exact generated shape, not merely the marker or an executable bit.
# An explicit empty config: Bun would otherwise apply a bunfig.toml (and its preload) from here.
if [ -n "$release" ]; then mode=release pins="$release/manifest.json" entry=""
else mode=source pins="$repo_dir/package.json" entry="$repo_dir/src/bin.ts"; fi
# The script is given with -e, never as stdin after "-": Bun reads the next argument as a
# possible subcommand, so an argument such as "a" would run `bun add`.
validation_js=$(cat <<'JS'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
const [mode, manifestPath, launcher, entry, runtimePath, releases] = process.argv.slice(1);
const fail = (message) => { console.error(message); process.exit(1); };
const accept = () => { process.stdout.write(`agent-bus-runtime-binding-v1:${realpathSync(runtimePath)}`); process.exit(0); };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (mode === "release") {
  if (Bun.version !== manifest.bun?.version)
    fail(`Release Bun ${Bun.version} differs from the manifest Bun ${manifest.bun?.version}`);
} else {
  const pin = manifest.engines?.bun;
  if (!/^\d+\.\d+\.\d+$/.test(pin ?? "") || manifest.packageManager !== `bun@${pin}`)
    fail(`Source must pin the same exact Bun in engines.bun and packageManager: ${manifestPath}`);
  if (Bun.version !== pin) fail(`Selected Bun ${Bun.version} does not match source pin ${pin}`);
}
// A source binding is owned for this checkout entry, or in release mode for any source
// entry, since activating a release replaces whichever checkout was bound.
const ownsEntry = (path) =>
  mode === "release" ? isAbsolute(path) && normalize(path) === path && path.endsWith("/src/bin.ts") : path === entry;
let info;
try { info = lstatSync(launcher); }
catch (error) { if (error.code === "ENOENT") accept(); throw error; }
if (info.isSymbolicLink() && ownsEntry(resolve(dirname(launcher), readlinkSync(launcher))))
  accept();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
if (info.isFile()) {
  const content = readFileSync(launcher, "utf8");
  const header = "#!/bin/sh\n# agent-bus managed runtime launcher v1\nexec ";
  if (content.startsWith(header)) {
    const match = /^'((?:[^']|'\\'')*)' --no-env-file '((?:[^']|'\\'')*)' "\$@"\n$/.exec(
      content.slice(header.length)
    );
    const runtime = match?.[1]?.replaceAll("'\\''", "'");
    const source = match?.[2]?.replaceAll("'\\''", "'");
    if (
      runtime !== undefined && source !== undefined && runtime.startsWith("/") &&
      !runtime.includes("\n") && !source.includes("\n") && ownsEntry(source) &&
      `${header}${quote(runtime)} --no-env-file ${quote(source)} "$@"\n` === content
    )
      accept();
  }
  // A release launcher (v2) is owned only in its exact generated shape (the anchored
  // pattern fixes every byte), for a release directly inside the releases directory.
  const v2 = "#!/bin/sh\n# agent-bus managed release launcher v2\nexec ";
  if (content.startsWith(v2)) {
    const match = /^'((?:[^']|'\\'')*)\/runtime\/bun' --no-env-file --config='((?:[^']|'\\'')*)\/app\/bunfig\.toml' '((?:[^']|'\\'')*)\/app\/cli\.js' "\$@"\n$/.exec(
      content.slice(v2.length)
    );
    const release = match?.[1]?.replaceAll("'\\''", "'");
    if (
      match !== null && release !== undefined && match[1] === match[2] && match[1] === match[3] &&
      release.startsWith("/") && !release.includes("\n") && normalize(release) === release &&
      dirname(release) === releases && !release.split("/").at(-1).startsWith(".")
    )
      accept();
  }
}
fail(`Refusing foreign launcher at ${launcher}; move it aside explicitly before installing`);
JS
)
validation=$("$bun_bin" --no-env-file --config=/dev/null -e "$validation_js" \
  "$mode" "$pins" "$launcher" "$entry" "$bun_bin" "$releases") \
  || fail "Selected Bun could not validate the source and launcher"
case "$validation" in
  # Resolve a selected symlink once, rather than borrowing a mutable global Bun shim.
  agent-bus-runtime-binding-v1:/*) bun_bin=${validation#agent-bus-runtime-binding-v1:} ;;
  *) fail "Selected executable did not validate as Bun: $bun_bin" ;;
esac
if [ -z "$release" ]; then
  (cd / && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "$bun_bin" --no-env-file "$repo_dir/src/bin.ts" --help >/dev/null) || fail "Selected runtime cannot run $repo_dir/src/bin.ts --help"
fi

# Activation changes only what the launcher runs, so an existing serve job is kept as it is:
# its own port and state directory are the ones waited on, and an override that disagrees is
# refused rather than applied. Only the owned job, running exactly the launcher's serve, is
# kept; anything else under the label is refused unchanged. A full install still writes it.
keep_plist=false
serve_plist="$agents/$prefix.plist"
if { [ "$runtime_only" = true ] || [ -n "$release" ]; } && { [ -e "$serve_plist" ] || [ -L "$serve_plist" ]; }; then
  refuse_plist() { fail "Refusing to change the serve LaunchAgent at $serve_plist: $1"; }
  [ -f "$serve_plist" ] && [ ! -L "$serve_plist" ] || refuse_plist "it is not a regular file"
  plist_json=$(/usr/bin/plutil -convert json -o - "$serve_plist" 2>/dev/null) || refuse_plist "it is not a readable plist"
  # The plist reaches the check on stdin, never in an argument a process listing shows.
  kept=$(printf '%s' "$plist_json" | (cd / && "$bun_bin" --no-env-file --config=/dev/null -e '
const [label, launcher, home] = process.argv.slice(1);
const job = JSON.parse(await Bun.stdin.text());
const env = job.EnvironmentVariables ?? {};
const port = env.AGENT_BUS_PORT ?? "8096";
const dir = env.AGENT_BUS_DIR ?? `${env.HOME ?? home}/.agent-bus`;
if (
  job.Label !== label || job.Program !== undefined || typeof env !== "object" ||
  JSON.stringify(job.ProgramArguments) !== JSON.stringify([launcher, "serve"]) ||
  !/^[0-9]+$/.test(port) || !dir.startsWith("/") || dir.includes("\n")
)
  process.exit(1);
process.stdout.write(`${port}\n${dir}`);
' "$prefix" "$launcher" "$HOME")) || refuse_plist "it is not the owned job running $launcher serve"
  kept_port=$(printf '%s\n' "$kept" | sed -n 1p)
  kept_dir=$(printf '%s\n' "$kept" | sed -n 2p)
  if [ -n "${AGENT_BUS_PORT:-}" ] && [ "$AGENT_BUS_PORT" != "$kept_port" ]; then
    refuse_plist "AGENT_BUS_PORT=$AGENT_BUS_PORT differs from its port $kept_port"
  fi
  if [ -n "${AGENT_BUS_DIR:-}" ] && [ "$AGENT_BUS_DIR" != "$kept_dir" ]; then
    refuse_plist "AGENT_BUS_DIR differs from its state directory $kept_dir"
  fi
  bus_port=$kept_port
  bus_dir=$kept_dir
  keep_plist=true
fi

launcher_tmp=""
agent_tmp=""
trap '[ -z "$launcher_tmp" ] || rm -f "$launcher_tmp"; [ -z "$agent_tmp" ] || rm -f "$agent_tmp"' EXIT
trap 'exit 1' HUP INT TERM

shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
xml_escape() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'; }

# render_agent LABEL LOG ARG... emits a KeepAlive LaunchAgent running ARGs.
render_agent() {
  label=$1 log=$2
  shift 2
  {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
PLIST
    for arg in "$@"; do printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done
    cat <<PLIST
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$bus_dir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>AGENT_BUS_DIR</key><string>$(xml_escape "$bus_dir")</string>
    <key>AGENT_BUS_PORT</key><string>$(xml_escape "$bus_port")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log")</string>
</dict>
</plist>
PLIST
  }
}

load_agent() {
  label=$1 log=$2
  # bootout returns before the old job is gone, and bootstrapping over it fails (error 5).
  launchctl bootout "$domain/$label" 2>/dev/null || true
  attempt=0
  while launchctl print "$domain/$label" >/dev/null 2>&1 && [ "$attempt" -lt 50 ]; do
    attempt=$((attempt + 1))
    sleep 0.2
  done
  launchctl bootstrap "$domain" "$agents/$label.plist"
  echo "loaded $label; log: $log"
}

write_agent() {
  agent_tmp=$(mktemp "$agents/$1.plist.tmp.XXXXXX")
  render_agent "$@" > "$agent_tmp"
  chmod 644 "$agent_tmp"
  mv -f "$agent_tmp" "$agents/$1.plist"
  agent_tmp=""
  load_agent "$1" "$2"
}

# Stage both files before replacing either; mv replaces an old symlink, never its target.
install_runtime() {
  mkdir -p "$bus_dir" "$agents" "$(dirname "$launcher")"
  launcher_tmp=$(mktemp "$launcher.tmp.XXXXXX")
  if [ -n "$release" ]; then
    {
      printf '#!/bin/sh\n# agent-bus managed release launcher v2\nexec '
      shell_quote "$release/runtime/bun"
      printf ' --no-env-file --config='
      shell_quote "$release/app/bunfig.toml"
      printf ' '
      shell_quote "$release/app/cli.js"
      printf ' "$@"\n'
    } > "$launcher_tmp"
  else
    {
      printf '#!/bin/sh\n# agent-bus managed runtime launcher v1\nexec '
      shell_quote "$bun_bin"
      printf ' --no-env-file '
      shell_quote "$repo_dir/src/bin.ts"
      printf ' "$@"\n'
    } > "$launcher_tmp"
  fi
  chmod 755 "$launcher_tmp"
  (cd / && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "$launcher_tmp" --help >/dev/null) || fail "The new launcher cannot run --help"
  if [ "$keep_plist" = false ]; then
    agent_tmp=$(mktemp "$agents/$prefix.plist.tmp.XXXXXX")
    render_agent "$prefix" "$bus_dir/agent-bus.log" "$launcher" serve > "$agent_tmp"
    chmod 644 "$agent_tmp"
  fi
  if [ -n "$release" ] && { [ -e "$launcher" ] || [ -L "$launcher" ]; }; then
    # Keep the binding this activation replaces, for rollback (a source one especially).
    bindings="$(dirname "$releases")/bindings"
    mkdir -p "$bindings"
    cp -P "$launcher" "$bindings/launcher.$(date -u +%Y%m%dT%H%M%SZ).$$.before-$(basename "$release")"
  fi
  mv -f "$launcher_tmp" "$launcher"
  launcher_tmp=""
  if [ "$keep_plist" = false ]; then
    mv -f "$agent_tmp" "$agents/$prefix.plist"
    agent_tmp=""
  fi
  load_agent "$prefix" "$bus_dir/agent-bus.log"
}

# valid_token FILE succeeds when FILE holds a JWS (three base64url parts).
valid_token() {
  [ -s "$1" ] && grep -Eq '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$1"
}

# require_auth checks that the Fluree server answering on $url enforces the token. A
# server being replaced can still answer briefly, so it is given half a minute; anything
# still open after that (another server holding the port) must not be used.
require_auth() {
  header=$(mktemp)
  (umask 077 && printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" > "$header")
  probe="$url/v1/fluree/exists/agent-bus%3Amain"
  attempt=0
  while :; do
    open=$(curl -s -o /dev/null -w '%{http_code}' "$probe")
    allowed=$(curl -s -o /dev/null -w '%{http_code}' -H "@$header" "$probe")
    [ "$open" = 401 ] && [ "$allowed" = 200 ] && break
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 75 ]; then
      rm -f "$header"
      echo "The Fluree server at $url does not enforce the bus token (without: $open, with: $allowed)." >&2
      echo "Stop whatever else holds port $port, then rerun." >&2
      exit 1
    fi
    sleep 0.4
  done
  rm -f "$header"
}

# wait_for URL LOG waits for a server's health endpoint.
wait_for() {
  attempt=0
  until curl -fsS "$1/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || { echo "Nothing answers at $1; see $2" >&2; exit 1; }
    sleep 0.2
  done
}

if [ "$runtime_only" = true ] || [ -n "$release" ]; then
  install_runtime
  wait_for "http://127.0.0.1:$bus_port" "$bus_dir/agent-bus.log"
  exit 0
fi

# Missing config is not a fresh install when this directory already held a cursor.
if [ ! -f "$bus_dir/config.json" ] && [ ! -e "$bus_dir/installation-id" ] &&
  [ -e "$bus_dir/fluree-cursors" ]; then
  fail "Retained cursors but no config.json or installation-id. Restore this installation's state before reinstalling."
fi

mkdir -p "$bus_dir" "$agents"

if [ -z "$remote" ]; then
  fluree_bin=$(command -v fluree) || {
    echo "fluree is not on PATH; install the Fluree CLI (docs/runbooks/install.md), then rerun" >&2
    exit 1
  }
  mkdir -p "$fluree_dir"
  # Durable mode needs a Fluree project for its configuration; storage lives beside it.
  [ -d "$fluree_dir/.fluree" ] || (cd "$fluree_dir" && "$fluree_bin" init >/dev/null)
  # The server trusts tokens signed by this key. The token has no subject: one naming an
  # identity would be held to identity policies, which deny writes. Each file is written
  # privately beside its final path and moved into place only once it is valid, so an
  # interrupted run is repaired by the next one, and an existing key is kept.
  key_file="$bus_dir/fluree-key.json"
  key_field() {
    "$bun_bin" -e 'const k = await Bun.file(process.argv[1]).json(); process.stdout.write(process.argv[2] === "did" ? k.did : k.privateKey.hex)' \
      "$1" "$2" 2>/dev/null
  }
  if ! key_field "$key_file" did | grep -q '^did:key:'; then
    (umask 077 && "$fluree_bin" token keygen --format json > "$key_file.tmp")
    key_field "$key_file.tmp" did | grep -q '^did:key:' || { echo "fluree token keygen failed" >&2; exit 1; }
    mv "$key_file.tmp" "$key_file"
    rm -f "$token_file"
    echo "created the Fluree signing key in $key_file"
  fi
  if ! valid_token "$token_file"; then
    key_field "$key_file" private | (umask 077 && "$fluree_bin" token create --private-key @- \
      --expires-in 520w --all --read-all --write-all > "$token_file.tmp" 2>/dev/null)
    valid_token "$token_file.tmp" || { echo "fluree token create failed" >&2; exit 1; }
    mv "$token_file.tmp" "$token_file"
    echo "created the Fluree token in $token_file"
  fi
  issuer=$(key_field "$key_file" did)
  write_agent "$prefix.fluree" "$bus_dir/fluree.log" \
    "$fluree_bin" server run \
    --config "$fluree_dir/.fluree/config.toml" \
    --storage-path "$fluree_dir/storage" \
    --listen-addr "127.0.0.1:$port" \
    --log-level warn \
    -- --cache-max-mb 512 --cors-enabled=false \
    --data-auth-mode required --data-auth-trusted-issuer "$issuer" \
    --admin-auth-mode required --admin-auth-trusted-issuer "$issuer"
  log="$bus_dir/fluree.log"
else
  (umask 077 && scp -q -o BatchMode=yes "$remote:.agent-bus/fluree-token" "$token_file.tmp")
  valid_token "$token_file.tmp" || { echo "could not copy the token from $remote" >&2; exit 1; }
  mv "$token_file.tmp" "$token_file"
  # The server listens on loopback only, so other machines reach it through SSH.
  write_agent "$prefix.tunnel" "$bus_dir/tunnel.log" \
    /usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L "127.0.0.1:$port:127.0.0.1:$port" "$remote"
  log="$bus_dir/tunnel.log"
fi

wait_for "$url" "$log"
require_auth

if [ ! -f "$bus_dir/config.json" ]; then
  AGENT_BUS_DIR="$bus_dir" "$bun_bin" --no-env-file "$repo_dir/src/bin.ts" initialize-installation
  printf '{ "fluree": { "url": "%s", "ledger": "%s" } }\n' "$url" "$ledger" > "$bus_dir/config.json"
  echo "bus store: $ledger at $url"
fi

install_runtime
wait_for "http://127.0.0.1:$bus_port" "$bus_dir/agent-bus.log"

echo "Register the bus with each agent runtime on this machine:"
echo "  claude mcp add --scope user --transport http agent-bus http://127.0.0.1:$bus_port/mcp"
echo "  claude plugin marketplace add '$repo_dir' && claude plugin install agent-bus@agent-bus"
echo "  (after a change to plugin/: claude plugin marketplace update agent-bus && claude plugin update agent-bus@agent-bus)"
echo "  codex mcp add agent-bus --url http://127.0.0.1:$bus_port/mcp"
echo "  Codex skill plugin (separate from MCP): follow docs/runbooks/install.md#install-the-codex-skill-plugin"
