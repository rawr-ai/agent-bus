# Recover provider copies

Use this during the paired mailbox transition. It covers the authorized cold stop of the bus host's Fluree provider, the capture of its store, two isolated working copies, and how to read the source cut from those copies for the `check-source` step. The transition itself is in [deploy](deploy.md#import-file-positions-into-the-ledger). Routine stops and starts are in [operate](operate.md#stop-and-start-serve-fluree-or-the-tunnel), and failures in [recover](recover.md#mailbox-import-cannot-be-established).

## Before you start

- **Authorization comes first.** The provider stop needs its own authorization: the human's word, carried by Release Operations. A transition or release commission does not include it. Without it, go to [Without authorization](#without-authorization).
- **Every native writer is held.** Both `serve` jobs are disabled, unloaded and off their ports, as in [deploy](deploy.md#import-file-positions-into-the-ledger). The hosted peer reaches the ledger only through `serve`. No sentinel exists yet.
- **Stop only this provider.** It is the job `${AGENT_BUS_LABEL:-ai.rawr.agent-bus}.fluree`, on the port in `config.json`. Other Fluree servers on the host belong to other projects: never stop, copy or query them.
- **Two binaries.**
  - The *installed* binary is the path the live plist runs, exactly as the plist writes it.
  - The *proposed* binary is unpacked from the release archive whose SHA-256 is on the [Fluree platform page](../platforms/fluree.md). Check the archive's hash before you unpack it.
  - The live provider restarts only under the installed binary. Moving it to the proposed one is a separately reviewed change.
- **Space and placement.** You need three times the store's size, on the bus host's local disk, in a private directory that nothing syncs or backs up off the host. Everything here runs on the bus host.
- **zsh, one step at a time.** Run everything in zsh, the macOS default shell. Each step is one function call.
  - A failed check prints `STOP:`. Don't run the next step after a `STOP`: a failed step may leave a private partial copy or a held provider for recovery.
  - Every probe must prove its result: an empty PID, an unreadable listing or an unanswered probe counts as a failure, never as a match.

### Load the steps

Paste this block into the shell once. It defines functions only and changes nothing.

```sh
umask 077
stop() { print -u2 "STOP: $*"; return 1; }
is_pid() { [[ "$1" == <1-> ]]; }
waits() { local n=$(( $1 * 5 )); shift; until "$@"; do (( n-- > 0 )) || return 1; /bin/sleep 0.2; done; }
gone() { is_pid "$1" && ! ps -p "$1" >/dev/null 2>&1; }
unloaded() { launchctl print "$domain/$1" >/dev/null 2>&1; [[ $? -eq 113 ]]; }
disabled() {
  local entries
  entries=$(LC_ALL=C launchctl print-disabled "$domain" 2>&1) || return 1
  [[ "$(print -r -- "$entries" | awk -v want="\"$1\" => disabled" '{gsub(/^[ \t]+|[ \t]+$/, "", $0); if ($0 == want) n++} END {print n+0}')" == 1 ]]
}
closed() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/"; [[ $? -eq 7 ]]; }
listener() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null; }
job_pid() { launchctl print "$domain/$1" 2>/dev/null | awk '$1 == "pid" {print $3}'; }
serves() { local p; p=$(job_pid "$label"); is_pid "$p" && [[ "$(listener "$live_port")" == "$p" ]]; }
sha() { setopt localoptions pipefail; shasum -a 256 "$1" | cut -d' ' -f1; }
manifest() { setopt localoptions pipefail; (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256); }
plain_tree() { local extra; extra=$(find "$1" ! -type d ! -type f -print -quit 2>&1) && [[ -z "$extra" ]]; }
did() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["did"])' "$1"; }
cfg() { python3 -I -c 'import json,sys,urllib.parse as u; f=json.load(open(sys.argv[1]))["fluree"]; print(f["ledger"] if sys.argv[2]=="ledger" else u.urlsplit(f["url"]).port)' "$AGENT_BUS_DIR/config.json" "$1"; }
plist_ok() {
  setopt localoptions pipefail
  /usr/bin/plutil -extract ProgramArguments json -o - "$plist" | python3 -I -c 'import json,sys; a=json.load(sys.stdin); s="--storage-path"; l="--listen-addr"; sys.exit(0 if a and a[0]==sys.argv[1] and a.count(s)==1 and a.index(s)+1<len(a) and a[a.index(s)+1]==sys.argv[2] and a.count(l)==1 and a.index(l)+1<len(a) and a[a.index(l)+1]=="127.0.0.1:"+sys.argv[3] else 1)' "$old_fluree" "$store" "$live_port"
}
writers_held() { disabled "$serve_label" && unloaded "$serve_label" && closed "$serve_port"; }

new_work() {  # parent installed-binary proposed-binary
  [[ -n "${AGENT_BUS_DIR:-}" && -d "$1" && -O "$1" && "$1" == "$(cd "$1" && pwd -P)" && -x "$2" && -x "$3" ]] || { stop "need AGENT_BUS_DIR, a canonical parent you own and two executables"; return 1; }
  local w="$1/provider-copy-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 700 "$w" || { stop "cannot create a fresh $w"; return 1; }
  work=$w store="$AGENT_BUS_DIR/fluree/storage" label="${AGENT_BUS_LABEL:-ai.rawr.agent-bus}.fluree"
  serve_label="${AGENT_BUS_LABEL:-ai.rawr.agent-bus}" serve_port="${AGENT_BUS_PORT:-8096}"
  plist="$HOME/Library/LaunchAgents/$label.plist" domain="gui/$(id -u)" old_fluree=$2 new_fluree=$3
  ledger=$(cfg ledger) && live_port=$(cfg port) && [[ -n "$ledger" ]] && is_pid "$live_port" || { stop "config.json does not name a ledger and port"; return 1; }
  old_sha=$(sha "$old_fluree") && new_sha=$(sha "$new_fluree") || { stop "cannot hash the binaries"; return 1; }
  python3 -I -c 'import json,os,sys; keys="AGENT_BUS_DIR work store label serve_label serve_port plist domain old_fluree new_fluree ledger live_port old_sha new_sha".split(); assert len(sys.argv)==len(keys)+2; fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); f=os.fdopen(fd,"w"); json.dump(dict(zip(keys,sys.argv[2:])),f); f.close()' \
    "$work/env" "$AGENT_BUS_DIR" "$work" "$store" "$label" "$serve_label" "$serve_port" "$plist" "$domain" "$old_fluree" "$new_fluree" "$ledger" "$live_port" "$old_sha" "$new_sha" || { stop "cannot record the work inputs"; return 1; }
  print "work=$work"; print "installed $old_sha"; print "proposed $new_sha"
}
resume_work() {  # existing work directory
  [[ -d "$1" && ! -L "$1" && -O "$1" && "$(stat -f %Lp "$1")" == 700 && -f "$1/env" && ! -L "$1/env" && -O "$1/env" && "$(stat -f %Lp "$1/env")" == 600 ]] || { stop "$1 is not a private work directory from new_work"; return 1; }
  local assignments
  assignments=$(python3 -I -c 'import json,re,shlex,sys; keys="AGENT_BUS_DIR work store label serve_label serve_port plist domain old_fluree new_fluree ledger live_port old_sha new_sha".split(); pairs=json.load(open(sys.argv[1]),object_pairs_hook=lambda p:p); assert isinstance(pairs,list) and len(pairs)==len(keys); data=dict(pairs); assert len(data)==len(keys) and set(data)==set(keys) and all(isinstance(v,str) and v for v in data.values()) and data["work"]==sys.argv[2] and all(re.fullmatch("[0-9a-f]{64}",data[k]) for k in ("old_sha","new_sha")); print("\n".join(k+"="+shlex.quote(data[k]) for k in keys))' "$1/env" "$1") || { stop "$1/env is not a valid record for this path"; return 1; }
  eval "$assignments" || { stop "cannot restore recorded inputs"; return 1; }
  print "resumed $work"
}
preflight() {
  [[ -f "$work/env" ]] || { stop "run new_work or resume_work first"; return 1; }
  [[ -d "$store" && "$store" == "$(cd "$store" && pwd -P)" ]] || { stop "the store path is not canonical"; return 1; }
  plist_ok || { stop "the plist does not run the installed binary on this store and port"; return 1; }
  local actual_sha
  [[ "$old_sha" =~ '^[0-9a-f]{64}$' ]] && actual_sha=$(sha "$old_fluree") && [[ "$actual_sha" == "$old_sha" ]] || { stop "the installed binary changed or cannot be hashed"; return 1; }
  writers_held || { stop "serve is loaded or its port answers"; return 1; }
  print "preflight passed"
}
stop_provider() {
  preflight || return 1
  local p; p=$(job_pid "$label")
  is_pid "$p" && [[ "$(listener "$live_port")" == "$p" ]] || { stop "the listener is not the job's own process"; return 1; }
  launchctl disable "$domain/$label" && launchctl bootout "$domain/$label" || { stop "launchctl failed: run restart_provider"; return 1; }
  waits 30 unloaded "$label" && waits 30 gone "$p" && closed "$live_port" || { stop "the provider did not stop"; return 1; }
  local open lsof_status
  if open=$(lsof +D "$store" 2>&1); then
    stop "something still has the store open"; return 1
  else
    lsof_status=$?
    [[ "$lsof_status" -eq 1 && -z "$open" ]] || { stop "the open-file check failed"; return 1; }
  fi
  print "$p" > "$work/stopped"; print "provider stopped"
}
capture_store() {
  setopt localoptions pipefail
  [[ -f "$work/stopped" ]] && unloaded "$label" && closed "$live_port" || { stop "the provider is not proved stopped"; return 1; }
  [[ -d "$store" ]] && plain_tree "$store" || { stop "the store is missing or contains links or special files"; return 1; }
  [[ ! -e "$work/capture" ]] || { stop "a capture exists: move it to the Trash first to retake it"; return 1; }
  mkdir -m 700 "$work/capture" && /usr/bin/ditto --noclone "$store" "$work/capture/storage" || { stop "the capture failed"; return 1; }
  manifest "$work/capture/storage" > "$work/capture.manifest" || { stop "cannot list the capture"; return 1; }
  manifest "$store" | cmp -s - "$work/capture.manifest" || { stop "the capture differs from the store"; return 1; }
  sha "$work/capture.manifest" > "$work/capture.sha256" || return 1
  [[ -d "$work/capture/storage/.fluree-wal" && -d "$work/capture/storage/ns@v2" ]] || { stop "the capture lacks the log or nameservice"; return 1; }
  print "capture manifest $(<"$work/capture.sha256")"
}
owns_copy() {  # copy directory
  local p port started current
  [[ -f "$1/pid" && -f "$1/port" && -f "$1/started" ]] || return 1
  p=$(<"$1/pid") port=$(<"$1/port") started=$(<"$1/started")
  is_pid "$p" && is_pid "$port" && [[ -n "$started" && "$(listener "$port")" == "$p" ]] || return 1
  current=$(ps -o lstart= -p "$p") && [[ -n "$current" && "$current" == "$started" ]]
}
make_copy() {  # name port binary
  setopt localoptions pipefail
  local c="$work/$1" iss live_issuer other_issuer other expected_sha actual_sha recorded_sha capture_sha
  case "$1" in
    copy-old) [[ "$3" == "$old_fluree" ]] || { stop "copy-old binary differs from preflight"; return 1; }; expected_sha=$old_sha; other=copy-new ;;
    copy-new) [[ "$3" == "$new_fluree" ]] || { stop "copy-new binary differs from preflight"; return 1; }; expected_sha=$new_sha; other=copy-old ;;
    *) stop "unknown copy name"; return 1 ;;
  esac
  [[ "$expected_sha" =~ '^[0-9a-f]{64}$' ]] && actual_sha=$(sha "$3") && [[ "$actual_sha" == "$expected_sha" ]] || { stop "$1 binary changed or cannot be hashed"; return 1; }
  live_issuer=$(did "$AGENT_BUS_DIR/fluree-key.json") && [[ "$live_issuer" == did:key:* ]] || { stop "cannot establish the live issuer"; return 1; }
  [[ -s "$work/capture.sha256" && ! -e "$c" ]] && closed "$2" || { stop "$1: no verified capture, the copy exists, or port $2 is taken"; return 1; }
  recorded_sha=$(<"$work/capture.sha256")
  [[ "$recorded_sha" =~ '^[0-9a-f]{64}$' ]] && capture_sha=$(sha "$work/capture.manifest") && [[ "$capture_sha" == "$recorded_sha" ]] && plain_tree "$work/capture/storage" && manifest "$work/capture/storage" | cmp -s - "$work/capture.manifest" || { stop "$1: the capture or its manifest changed"; return 1; }
  mkdir -m 700 "$c" "$c/project" && /usr/bin/ditto --noclone "$work/capture/storage" "$c/storage" || { stop "$1: copy failed"; return 1; }
  [[ "$c/storage" == "$(cd "$c/storage" && pwd -P)" ]] || { stop "$1: the copy path is not canonical"; return 1; }
  manifest "$c/storage" | cmp -s - "$work/capture.manifest" || { stop "$1 differs from the capture"; return 1; }
  (cd "$c/project" && "$3" init >/dev/null) && "$3" token keygen --format json > "$c/key.json" || { stop "$1: init or keygen failed"; return 1; }
  python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["privateKey"]["hex"])' "$c/key.json" |
    "$3" token create --private-key @- --expires-in 7d --all --read-all --write-all > "$c/token" 2>/dev/null && [[ -s "$c/token" ]] || { stop "$1: token failed"; return 1; }
  iss=$(did "$c/key.json") && [[ "$iss" == did:key:* && "$iss" != "$live_issuer" ]] || { stop "$1: issuer missing or shared with the live key"; return 1; }
  if [[ -e "$work/$other" ]]; then
    other_issuer=$(did "$work/$other/key.json") && [[ "$other_issuer" == did:key:* && "$iss" != "$other_issuer" ]] || { stop "$1: issuer missing or shared with $other"; return 1; }
  fi
  printf '{ "fluree": { "url": "http://127.0.0.1:%s", "ledger": "%s" } }\n' "$2" "$ledger" > "$c/config.json"
  "$3" server run --config "$c/project/.fluree/config.toml" --storage-path "$c/storage" \
    --listen-addr "127.0.0.1:$2" --log-level warn -- --cors-enabled=false \
    --data-auth-mode required --data-auth-trusted-issuer "$iss" \
    --admin-auth-mode required --admin-auth-trusted-issuer "$iss" > "$c/fluree.log" 2>&1 &
  print $! > "$c/pid"; print "$2" > "$c/port"; ps -o lstart= -p "$(<"$c/pid")" > "$c/started"
  waits 60 owns_copy "$c" || { stop "$1 did not start: read $c/fluree.log"; return 1; }
  local names; names=$(lsof -nP -a -p "$(<"$c/pid")" -Fn 2>/dev/null) && \
    print -r -- "$names" | COPY_STORAGE="$c/storage" LIVE_STORAGE="$store" awk 'BEGIN {copy="n" ENVIRON["COPY_STORAGE"] "/"; live="n" ENVIRON["LIVE_STORAGE"]} index($0,copy)==1 {found=1} $0==live || index($0,live "/")==1 {unsafe=1} END {exit !(found && !unsafe)}' || { stop "$1 opened the live store, or its copy files cannot be proved open"; return 1; }
  print "$1 serving on $2"
}
cut_of() {  # token-file port
  setopt localoptions pipefail
  local base="http://127.0.0.1:$2/v1/fluree" h t c i
  h=$(printf 'Authorization: Bearer %s\n' "$(<"$1")")
  t=$(curl -fsS -H @<(print -r -- "$h") "$base/log/$ledger?limit=1" | python3 -I -c 'import json,sys; c=json.load(sys.stdin)["commits"][0]; print(c["t"], c["commit_id"])') || return 1
  i=$(curl -fsS -H @<(print -r -- "$h") "$base/show/$ledger?commit=t:1" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["id"])') || return 1
  [[ -n "$t" && -n "$i" ]] && print "source_head ${t% *}\nhead_cid ${t#* }\nincarnation $i"
}
read_cuts() {
  local c
  for c in copy-old copy-new; do
    owns_copy "$work/$c" || { stop "$c is not the process this step started"; return 1; }
    cut_of "$work/$c/token" "$(<"$work/$c/port")" > "$work/$c/cut" && [[ -s "$work/$c/cut" ]] || { stop "$c did not answer"; return 1; }
  done
  cmp -s "$work/copy-old/cut" "$work/copy-new/cut" || { stop "the copies disagree: run restart_provider and report"; return 1; }
  cp "$work/copy-old/cut" "$work/cut" && cat "$work/cut"
}
restart_provider() {
  preflight || return 1
  unloaded "$label" && closed "$live_port" || { stop "the provider is already loaded or its port answers"; return 1; }
  launchctl enable "$domain/$label" && launchctl bootstrap "$domain" "$plist" || { stop "launchctl failed"; return 1; }
  waits 60 serves || { stop "the listener is not the job's process: do not send it the live token"; return 1; }
  [[ -f "$work/cut" ]] || { print "provider restarted; no cut was recorded"; return 0; }
  cut_of "$AGENT_BUS_DIR/fluree-token" "$live_port" > "$work/live.cut" || { stop "the live provider did not answer"; return 1; }
  cmp -s "$work/live.cut" "$work/cut" || { stop "the live provider is at another cut: do not fence"; return 1; }
  print "live provider at the recorded cut"
}
stop_copies() {
  local c p
  for c in copy-old copy-new; do
    [[ -e "$work/$c" ]] || continue
    owns_copy "$work/$c" || { stop "$c's saved pid is not the copy any more: check it by hand"; return 1; }
    p=$(<"$work/$c/pid"); kill -TERM "$p" && waits 30 gone "$p" || { stop "$c did not exit"; return 1; }
    /usr/bin/trash "$work/$c" || return 1
  done
  print "copies stopped and in the Trash"
}
```

Then start a fresh, private work directory:

```sh
mkdir -p -m 700 "$HOME/.local/state/agent-bus"
new_work "$HOME/.local/state/agent-bus" "<installed fluree executable>" "<unpacked proposed executable>"
preflight
```

Expect `work=…`, both hashes and `preflight passed`. Record the hashes and the `work` path in the independent preflight record.
- Check that the parent directory is excluded from any backup that leaves the host.
- If the shell is lost, open a new zsh, paste the function block again, and run `resume_work "<independently recorded work path>"`. It checks the directory and data file's owner, modes, shape and recorded path; those checks do not prove provenance. Match its recorded paths and hashes to the independently retained record before proceeding. The file is parsed as data, not sourced as shell code.

*Rehearsed 2026-11-23* on a disposable installation, with `plutil` reading a test plist. The subsequently tightened checks in the current block are *Unverified as a complete sequence*.

## Stop the provider and capture its store

Both steps were *Rehearsed 2026-11-23* on a disposable server after an unclean kill, with `launchctl` stubbed to start and kill by pid.

1. **Stop the provider, and show that it stopped.**

   ```sh
   stop_provider
   ```

   Expect `provider stopped`.
   - The step checks that the listener is the job's own process before it disables anything.
   - It then checks that the job is unloaded, its process has exited, the port refuses connections and no process has the store open.
   - A stopped provider can't commit a request that is still in flight. Its write-ahead log decides, on recovery, which of those requests committed.
   - From here on, any abort brings the provider back with step 5 (see [If it fails](#if-it-fails)).

   A negative rehearsal showed that a mismatched pid stops before `launchctl disable`.

2. **Capture the whole store, write-ahead log and nameservice included.**

   ```sh
   capture_store
   ls -A "$work/capture/storage"
   ```

   Expect the manifest's hash, then `.fluree-wal`, `ns@v2` and the ledger's directory. Record the hash in the independent preflight record.
   - The capture is compared file by file with the stopped store. The manifest lists file names and hashes only.
   - This procedure refuses symbolic links and special files rather than risk a working copy following a path outside the capture. Investigate such a store separately.
   - `--noclone` makes independent files, not APFS clones that share blocks with the live store.
   - `.fluree/config.toml`, the key and the token are not copied.
   - The capture is the evidence: working copies are made from it, never from the live store.

## Read the source cut from two working copies

Both steps were *Rehearsed 2026-11-23* with both binaries.

3. **Make one working copy for each binary,** each with its own port, project, key and token.

   ```sh
   make_copy copy-old 18195 "$old_fluree" && make_copy copy-new 18196 "$new_fluree"
   ```

   Expect two `serving` lines.
   - Each copy is checked against the capture, trusts only its own new key, listens on loopback only, and is checked not to open the live store.
   - Each runs in normal file mode, so it replays the write-ahead log on start. Don't use a read-only or peer mode: the proposed binary's read-only mode does not replay the physical log.
   - Never give a copy the live token.
   - A copy holds the whole store, message content included: handle it like the capture.

4. **Read the head, its commit ID and the incarnation from each copy,** without printing commit data.

   ```sh
   read_cuts
   ```

   Expect `source_head`, `head_cid` and `incarnation`, the same from both copies. Record them in the independent preflight record.
   - `head_cid` is the commit's full CID, the spelling `--source-commit` takes. The 12-character hex that `fluree log` prints is a different spelling.
   - `/show` returns the commit's data, so the filter keeps only its `id`. The raw response is never saved or printed.

## Restart the live provider

5. **Restart the live provider under the installed binary, with both writers still held, and check it is at the same cut.**

   ```sh
   restart_provider
   ```

   Expect `live provider at the recorded cut`. Both `serve` jobs stay disabled and unloaded.
   - The step re-checks the plist, the binary's hash and the held writers before `launchctl enable`.
   - It sends the live token only once the listener is proved to be the job's own process.
   - The transition continues at `mailbox-source` in [deploy](deploy.md#import-file-positions-into-the-ledger). Run its `check-source` commands on this host, because the copies listen only on this host's loopback. Pass `$work/copy-old/config.json` with `$work/copy-old/token`, then `$work/copy-new/config.json` with `$work/copy-new/token`. Each must report `status: verified` at `source_head`.

   *Rehearsed 2026-11-23* on disposable state:
   - the original restarted at the copies' cut;
   - `check-source` verified both copies;
   - it refused a wrong `--expected-head`, and a copy at the live origin;
   - a changed binary hash stopped before `launchctl enable`.

   The `launchctl` commands were stubbed.

## Clean up

6. **Stop the working copies once both `check-source` runs have verified.**

   ```sh
   stop_copies
   ```

   Expect `copies stopped and in the Trash`.
   - The step signals a copy only while that copy still owns its port, with the start time recorded when it started.
   - The copies go to the Trash with their message content, keys and tokens. Their keys are trusted by nothing else.
   - Keep `$work`, with the capture, the manifest, `env` and the cut files, until both hosts are permitted and the transition is reconciled. A separately reviewed retirement then decides their disposal.
   - The capture holds the whole store, message content included. Never move it to the other host, attach it to a PR or message, or let a backup carry it off the host.
   - Emptying the Trash is the human's decision.

   *Rehearsed 2026-11-23.*

## Without authorization

- **If the provider stop isn't authorized, don't begin.** Without a cold capture, `check-source` can't run, so the transition can't proceed past it.
- **An online copy is no substitute.** A copy of a running store, or a read of the live provider alone, doesn't establish the cut.
- **The old jobs may return before any sentinel exists.** If both `serve` jobs were already held, nothing has crossed the fix-forward boundary. Load and start each one with `launchctl enable "gui/$(id -u)/<serve label>"` and then `launchctl bootstrap` as in [operate](operate.md#stop-and-start-serve-fluree-or-the-tunnel). Ask Release Operations to obtain the authorization.
- **After a sentinel, the old jobs stay held** ([deploy](deploy.md#import-file-positions-into-the-ledger)).

*Unverified as an installed procedure.*

## If it fails

- **Keep the capture intact and both `serve` jobs held** in every case below.
- **Bring the provider back after any abort past step 1.** Unless the live store itself is suspect, run `restart_provider`, with `resume_work` in a new shell if needed. A disabled job stays disabled across reboots. It refuses on its own failed checks.
- **Account for a copy after any `make_copy` failure.** It may already have started a process. Use the saved pid, listener and start time to prove ownership before stopping it; if ownership cannot be established, do not signal that pid and escalate for inspection.

| `STOP:` message | What it means | What to do |
| --- | --- | --- |
| `the plist does not run the installed binary…`, `the listener is not the job's own process` | The provider isn't the one you identified | Change nothing. Report to Release Operations. |
| `serve is loaded or its port answers` | A writer isn't held | Hold it as in [deploy](deploy.md#import-file-positions-into-the-ledger), then rerun the step. |
| `the provider did not stop`, `something still has the store open` | A process still serves or holds the store | Copy nothing. Stop only a process that belongs to this bus, by its pid. Anything else goes to Release Operations. |
| `the capture failed`, `differs from the store` | The capture is incomplete | Move `$work/capture` to the Trash, then rerun `capture_store` while the provider is still stopped. |
| `… differs from the capture`, `… did not start` | A copy is incomplete or failed to start | Read its log. Stop it by hand only after checking its pid, move it to the Trash and rerun `make_copy` for that copy. |
| `the copies disagree` | The binaries recover the store differently | Choose neither. Run `restart_provider`: this is an incident for Release Operations, and no sentinel is installed. |
| `the installed binary changed` | The live provider would start under an unreviewed binary | Don't start it. Release Operations restores the recorded binary first. |
| `… do not send it the live token`, `the live provider did not answer` | The restarted listener is unproved | Don't send the token or fence. Use [recover](recover.md#fluree-wont-start-or-the-token-isnt-enforced). |
| `the live provider is at another cut` | The live store differs from the capture, or something wrote | Don't fence. Restoring the live store from the capture is a separately reviewed recovery, not part of this page. |
| `check-source` refuses (deploy) | See [deploy](deploy.md#import-file-positions-into-the-ledger) | Don't fence, and don't commit anything to move `H`. An expired copy token is re-minted with that copy's own key. |

Further recovery is in [recover](recover.md#mailbox-import-cannot-be-established).
