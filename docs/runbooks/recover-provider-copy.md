# Recover provider copies

Use this runbook to capture the installed Bus provider's entire store and prove that a private working copy recovers the expected ledger. For the one-time [mailbox retirement](deploy.md#retire-paired-mailbox-evidence), use the **same pinned provider executable** for the live store and the working copy. This is not a provider upgrade, a mailbox import, or authority to replace a live store. The [original paired transition](https://github.com/rawr-ai/agent-bus/blob/a32ae0aecb3413e1e04363f464242ae1a9136418/docs/runbooks/recover-provider-copy.md) is historical.

## Before you start

- Release Operations needs the human's explicit authorization to stop the dedicated Bus provider. General release approval is not permission for database downtime. Without it, do not hold writers or stop the provider. A qualified storage-level snapshot could avoid a stop; a copy of a running directory or an RDF export cannot.
- Identify the exact native service on each machine and the existing private host. Before sampling the cut, hold every writer, prove its process exited and its listener closed, and settle outstanding operations. Leave the tunnels, other Fluree jobs and credentials alone. The helper checks the **local** writer only; it does not establish the remote or hosted holds.
- Keep separate evidence for **H/K** (original import), **R** (the committed history in the serving binding), and **S** (the current or last-known approved recovery point). Record S, its full native commit CID and ledger incarnation independently of the backup that will be tested. R and S may coincide at handoff. After later writes, R still establishes lineage but no longer establishes freshness. Retain independent receipts for a representative pending and acknowledged message.
- Verify the pinned executable, original provider plist, canonical store and loopback port. Use only the installed service-specific binary. Never run a general installer to repair it. Use a private local parent, with space for the capture and an independent working copy. Exclude it from sync and off-host backups. Preserve both machines' protected admission and identity records as directed in [deploy](deploy.md#retire-paired-mailbox-evidence); a database backup cannot replace those records.

### Load the steps

Run the following in zsh. Each command must succeed before the next. A `STOP:` is a failed check, not permission to continue.

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

new_work() {  # parent installed-binary
  [[ -n "${AGENT_BUS_DIR:-}" && -d "$1" && -O "$1" && "$1" == "$(cd "$1" && pwd -P)" && -x "$2" ]] || { stop "need AGENT_BUS_DIR, a canonical parent you own and the pinned provider executable"; return 1; }
  local w="$1/provider-copy-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 700 "$w" || { stop "cannot create a fresh $w"; return 1; }
  work=$w store="$AGENT_BUS_DIR/fluree/storage" label="${AGENT_BUS_LABEL:-ai.rawr.agent-bus}.fluree"
  serve_label="${AGENT_BUS_LABEL:-ai.rawr.agent-bus}" serve_port="${AGENT_BUS_PORT:-8096}"
  plist="$HOME/Library/LaunchAgents/$label.plist" domain="gui/$(id -u)" old_fluree=$2
  ledger=$(cfg ledger) && live_port=$(cfg port) && [[ -n "$ledger" ]] && [[ "$live_port" == <1-65535> ]] || { stop "config.json does not name a ledger and port"; return 1; }
  old_sha=$(sha "$old_fluree") || { stop "cannot hash the binaries"; return 1; }
  python3 -I -c 'import json,os,sys; keys="AGENT_BUS_DIR work store label serve_label serve_port plist domain old_fluree ledger live_port old_sha".split(); assert len(sys.argv)==len(keys)+2; fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); f=os.fdopen(fd,"w"); json.dump(dict(zip(keys,sys.argv[2:])),f); f.close()' \
    "$work/env" "$AGENT_BUS_DIR" "$work" "$store" "$label" "$serve_label" "$serve_port" "$plist" "$domain" "$old_fluree" "$ledger" "$live_port" "$old_sha" || { stop "cannot record the work inputs"; return 1; }
  print "work=$work"; print "installed $old_sha"
}
resume_work() {  # existing work directory
  [[ -d "$1" && ! -L "$1" && -O "$1" && "$(stat -f %Lp "$1")" == 700 && -f "$1/env" && ! -L "$1/env" && -O "$1/env" && "$(stat -f %Lp "$1/env")" == 600 ]] || { stop "$1 is not a private work directory from new_work"; return 1; }
  local assignments
  assignments=$(python3 -I -c 'import json,re,shlex,sys; keys="AGENT_BUS_DIR work store label serve_label serve_port plist domain old_fluree ledger live_port old_sha".split(); pairs=json.load(open(sys.argv[1]),object_pairs_hook=lambda p:p); assert isinstance(pairs,list) and len(pairs)==len(keys); data=dict(pairs); assert len(data)==len(keys) and set(data)==set(keys) and all(isinstance(v,str) and v for v in data.values()) and data["work"]==sys.argv[2] and re.fullmatch("[0-9a-f]{64}",data["old_sha"]); print("\n".join(k+"="+shlex.quote(data[k]) for k in keys))' "$1/env" "$1") || { stop "$1/env is not a valid record for this path"; return 1; }
  eval "$assignments" || { stop "cannot restore recorded inputs"; return 1; }
  print "resumed $work"
}
preflight() {
  [[ -f "$work/env" ]] || { stop "run new_work or resume_work first"; return 1; }
  [[ -d "$store" && "$store" == "$(cd "$store" && pwd -P)" ]] || { stop "the store path is not canonical"; return 1; }
  [[ "$work" != "$store" && "$work" != "$store/"* && "$store" != "$work/"* ]] || { stop "capture and store paths overlap"; return 1; }
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
  [[ ! -e "$work/capture" ]] || { stop "a capture exists: preserve it and use a new private work directory"; return 1; }
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
make_copy() {  # unused loopback port
  setopt localoptions pipefail
  local c="$work/reopened" copy_port="$1" iss live_issuer actual_sha recorded_sha capture_sha
  [[ "$copy_port" == <1-65535> && "$copy_port" != "$live_port" ]] || { stop "invalid or live port"; return 1; }
  [[ "$old_sha" =~ '^[0-9a-f]{64}$' ]] && actual_sha=$(sha "$old_fluree") && [[ "$actual_sha" == "$old_sha" ]] || { stop "provider binary changed or cannot be hashed"; return 1; }
  live_issuer=$(did "$AGENT_BUS_DIR/fluree-key.json") && [[ "$live_issuer" == did:key:* ]] || { stop "cannot establish the live issuer"; return 1; }
  [[ -s "$work/capture.sha256" && ! -e "$c" ]] && closed "$copy_port" || { stop "copy: no verified capture, the copy exists, or copy port is taken"; return 1; }
  recorded_sha=$(<"$work/capture.sha256")
  [[ "$recorded_sha" =~ '^[0-9a-f]{64}$' ]] && capture_sha=$(sha "$work/capture.manifest") && [[ "$capture_sha" == "$recorded_sha" ]] && plain_tree "$work/capture/storage" && manifest "$work/capture/storage" | cmp -s - "$work/capture.manifest" || { stop "copy: the capture or its manifest changed"; return 1; }
  mkdir -m 700 "$c" "$c/project" && /usr/bin/ditto --noclone "$work/capture/storage" "$c/storage" || { stop "copy: copy failed"; return 1; }
  [[ "$c/storage" == "$(cd "$c/storage" && pwd -P)" ]] || { stop "copy: the copy path is not canonical"; return 1; }
  manifest "$c/storage" | cmp -s - "$work/capture.manifest" || { stop "copy differs from the capture"; return 1; }
  (cd "$c/project" && "$old_fluree" init >/dev/null) && "$old_fluree" token keygen --format json > "$c/key.json" || { stop "copy: init or keygen failed"; return 1; }
  python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["privateKey"]["hex"])' "$c/key.json" |
    "$old_fluree" token create --private-key @- --expires-in 7d --all --read-all --write-all > "$c/token" 2>/dev/null && [[ -s "$c/token" ]] || { stop "copy: token failed"; return 1; }
  iss=$(did "$c/key.json") && [[ "$iss" == did:key:* && "$iss" != "$live_issuer" ]] || { stop "copy: issuer missing or shared with the live key"; return 1; }
  printf '{ "fluree": { "url": "http://127.0.0.1:%s", "ledger": "%s" } }\n' "$copy_port" "$ledger" > "$c/config.json"
  "$old_fluree" server run --config "$c/project/.fluree/config.toml" --storage-path "$c/storage" \
    --listen-addr "127.0.0.1:$copy_port" --log-level warn -- --cors-enabled=false \
    --data-auth-mode required --data-auth-trusted-issuer "$iss" \
    --admin-auth-mode required --admin-auth-trusted-issuer "$iss" > "$c/fluree.log" 2>&1 &
  print $! > "$c/pid"; print "$copy_port" > "$c/port"; ps -o lstart= -p "$(<"$c/pid")" > "$c/started"
  waits 60 owns_copy "$c" || { stop "copy did not start: read $c/fluree.log"; return 1; }
  local names; names=$(lsof -nP -a -p "$(<"$c/pid")" -Fn 2>/dev/null) && \
    print -r -- "$names" | COPY_STORAGE="$c/storage" LIVE_STORAGE="$store" awk 'BEGIN {copy="n" ENVIRON["COPY_STORAGE"] "/"; live="n" ENVIRON["LIVE_STORAGE"]} index($0,copy)==1 {found=1} $0==live || index($0,live "/")==1 {unsafe=1} END {exit !(found && !unsafe)}' || { stop "copy opened the live store, or its copy files cannot be proved open"; return 1; }
  print "working copy serving on $copy_port"
}
cut_of() {  # token-file port
  setopt localoptions pipefail extendedglob
  local base="http://127.0.0.1:$2/v1/fluree" h t i
  h=$(printf 'Authorization: Bearer %s\n' "$(<"$1")")
  t=$(curl -fsS --max-time 10 -H @<(print -r -- "$h") "$base/log/$ledger?limit=1" | python3 -I -c 'import json,sys; c=json.load(sys.stdin)["commits"][0]; t=c["t"]; cid=c["commit_id"]; assert type(t) is int and t>=1 and isinstance(cid,str) and cid.isalnum(); print(t,cid)') || return 1
  i=$(curl -fsS --max-time 10 -H @<(print -r -- "$h") "$base/show/$ledger?commit=t:1" | python3 -I -c 'import json,sys; i=json.load(sys.stdin)["id"]; assert isinstance(i,str) and i and not any(c.isspace() for c in i); print(i)') || return 1
  [[ "${t% *}" == <1-> && "${t#* }" != "$t" && "${t#* }" == [[:alnum:]]## && -n "$i" && "$i" != *[[:space:]]* ]] || return 1
  printf 'source_head %s\nhead_cid %s\nincarnation %s\n' "${t% *}" "${t#* }" "$i"
}
verify_reopened() {
  local c="$work/reopened"
  owns_copy "$c" || { stop "working copy listener not attributed"; return 1; }
  cut_of "$c/token" "$(<"$c/port")" > "$c/cut" && cmp -s "$work/expected.cut" "$c/cut" || { stop "working copy does not match the independent cut"; return 1; }
  print "working copy recovered the exact cut"
}
restart_provider() {
  preflight || return 1
  unloaded "$label" && closed "$live_port" || { stop "the provider is already loaded or its port answers"; return 1; }
  launchctl enable "$domain/$label" && launchctl bootstrap "$domain" "$plist" || { stop "launchctl failed"; return 1; }
  waits 60 serves || { stop "the listener is not the job's process: do not send it the live token"; return 1; }
  cut_of "$AGENT_BUS_DIR/fluree-token" "$live_port" > "$work/live.cut" || { stop "the live provider did not answer"; return 1; }
  cmp -s "$work/live.cut" "$work/expected.cut" || { stop "the live provider is at another cut: keep writers held"; return 1; }
  print "live provider at the recorded cut"
}
stop_copy() {
  local c="$work/reopened" p
  owns_copy "$c" || { stop "working copy listener not attributed"; return 1; }
  p=$(<"$c/pid"); kill -TERM "$p" && waits 30 gone "$p" && closed "$(<"$c/port")" || { stop "copy did not exit cleanly"; return 1; }
  print "working copy stopped; private files retained"
}
```

## Stop the provider and capture its store

1. **Record the independent cut before the stop.** Release Operations supplies `AGENT_BUS_DIR`, the approved provider path and a private record from the held live ledger, retained outside the new copy. The cut file is three newline-terminated lines: `source_head <S>`, `head_cid <full native CID at S>`, and `incarnation <ID of commit 1>`. The value from the captured store cannot be its own expected result.

   ```sh
   new_work "$protected_parent" "$approved_provider"
   preflight
   cp "$independent_cut" "$work/expected.cut"
   serves && cut_of "$AGENT_BUS_DIR/fluree-token" "$live_port" > "$work/before.cut" &&
     cmp -s "$work/before.cut" "$work/expected.cut"
   ```

   Check both provider identity and exact cut before continuing. If the approved cut is no longer current, reconcile the difference; do not silently replace it with the observed cut. Keep the work path and executable digest in the independent record. *Rehearsed 2026-11-26* on a disposable ledger; the job manager was stubbed.

2. **Stop just the dedicated provider and capture it cold.**

   ```sh
   stop_provider
   capture_store
   ```

   Expect `provider stopped`, then a manifest digest. The helper checks PID ownership, listener closure and absence of open store files. It compares the capture file by file with the stopped original, including the WAL and nameservice. A successful copy command alone is not enough. Keep the independent digest and never open the master capture with a provider. *Rehearsed 2026-11-26* with the real provider and synthetic data; the job manager was stubbed.

## Verify recovery

3. **Restore the original provider promptly, then open only a private descendant of the capture.** Run in the same shell while all writers remain held. Opening the copy under its own key must not read or modify the live store.

   ```sh
   restart_provider
   make_copy 18195
   verify_reopened
   ```

   Expect `live provider at the recorded cut` and `working copy recovered the exact cut`. The two listeners have separate state paths, ports, issuers and tokens. Only the original listener receives the live token. When resuming after a shell interruption, use `resume_work "$recorded_work_path"` and compare its inputs and cut with the separately retained record before acting. *Rehearsed 2026-11-26* on a disposable store: both recovered at the independent cut, and the check refused a different expected CID at the same height.

4. **Preserve the recovery evidence and release only the intended holds.**

   ```sh
   stop_copy
   ```

   Expect the isolated PID to exit and its own port to close. Keep the master capture, manifest, independent cut, identity evidence, and protected receipts. The working files contain private mail and credentials; do not attach them to a PR or transfer them through the Bus. If this is a retirement handoff, return to [deploy](deploy.md#retire-paired-mailbox-evidence) with application writers still held. Verify representative delivery there using the actual owners, not by reading their live inboxes as the operator. *Rehearsed 2026-11-26* for PID-owned cleanup; actual retirement and owner delivery are separate deployment checks.

## If it fails

- **A local or remote writer is unaccounted for, or authorization is missing:** do not stop the provider. If a hold was already taken, Release Operations restores only the original jobs it held after checking that their bindings are unchanged. Do not infer authority from an unavailable service.
- **A listener or path does not match, or an open-file check is inconclusive:** do not send a token, signal a guessed PID or copy the store. If a disposable process may already have started, check its saved PID, start time and owned listener before stopping it.
- **A capture or reopen fails:** preserve the original and the partial capture. A still-healthy original can restart under its unchanged pinned binary with the writers held; independently verify it against the accepted cut before resuming normal service or retrying. A mismatched original is a recovery incident, not a reason to promote the copy.
- **Considering a later restore:** verify the ledger incarnation and the exact commit at an independently accepted **S**, on the candidate's own history. Its numeric head must reach S and that ancestor's full native CID must match; matching R, or having a higher head on a fork, is not enough. Do not release writers until the recovery procedure also accounts for known subsequent work and representative pending/ACK receipts. An old copy, missing expected CID or uncertain newer work cannot be approved as lossless. Keep the stores, report the uncertainty, and obtain a separate informed decision before any lossy recovery. See [serving-binding recovery](recover.md#the-serving-binding-is-refused).
