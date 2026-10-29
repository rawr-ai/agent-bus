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
# AGENT_BUS_DIR, AGENT_BUS_FLUREE_PORT, AGENT_BUS_PORT, AGENT_BUS_LABEL (the label prefix) and
# AGENT_BUS_LAUNCHER (the `agent-bus` link) override the defaults, so a disposable instance can
# run beside the real one.

set -eu

remote=""
if [ "${1:-}" = "--remote" ]; then
  remote=${2:?"usage: $0 [--remote SSH_HOST]"}
fi

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
bun_bin=$(command -v bun || echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun")
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

mkdir -p "$bus_dir" "$agents"

# The `agent-bus` command: a link to this checkout, which the Claude Code plugin's hook runs.
# Checked as the hook runs it: a launchd-style PATH after the user's bun directories, outside
# the checkout.
launcher="${AGENT_BUS_LAUNCHER:-$HOME/.local/bin/agent-bus}"
if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
  echo "$launcher exists and is not a link; move it aside and rerun" >&2
  exit 1
fi
mkdir -p "$(dirname "$launcher")"
ln -sfn "$repo_dir/src/bin.ts" "$launcher"
(cd / && env -i HOME="$HOME" PATH="$(dirname "$launcher"):$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$launcher" --help >/dev/null) || { echo "$launcher does not run" >&2; exit 1; }

# write_agent LABEL LOG ARG... writes a KeepAlive LaunchAgent running ARGs.
write_agent() {
  label=$1 log=$2
  shift 2
  {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
PLIST
    for arg in "$@"; do printf '    <string>%s</string>\n' "$arg"; done
    cat <<PLIST
  </array>
  <key>WorkingDirectory</key><string>$bus_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_BUS_DIR</key><string>$bus_dir</string>
    <key>AGENT_BUS_PORT</key><string>$bus_port</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
  } > "$agents/$label.plist"
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

if [ -z "$remote" ]; then
  fluree_bin=$(command -v fluree)
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
  printf '{ "fluree": { "url": "%s", "ledger": "%s" } }\n' "$url" "$ledger" > "$bus_dir/config.json"
  echo "bus store: $ledger at $url"
fi

write_agent "$prefix" "$bus_dir/agent-bus.log" \
  "$bun_bin" "$repo_dir/src/bin.ts" serve
wait_for "http://127.0.0.1:$bus_port" "$bus_dir/agent-bus.log"

echo "Register the bus with each agent runtime on this machine:"
echo "  claude mcp add --scope user --transport http agent-bus http://127.0.0.1:$bus_port/mcp"
echo "  claude plugin marketplace add '$repo_dir' && claude plugin install agent-bus@agent-bus"
echo "  (after a change to plugin/: claude plugin marketplace update agent-bus && claude plugin update agent-bus@agent-bus)"
echo "  codex mcp add agent-bus --url http://127.0.0.1:$bus_port/mcp"
