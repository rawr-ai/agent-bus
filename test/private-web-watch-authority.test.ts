import { Database, Statement } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeWatchAuthority,
  MAX_WATCH_DB_BYTES,
  MAX_WATCH_ROW_BYTES,
  MAX_WATCH_ROWS,
  WATCH_EVENT,
  WatchAuthority,
  watchAuthorityPath,
} from "../src/private-web/watch-authority.ts";
import type { WakeBinding } from "../src/wake-observation.ts";
import { firstLine, identify, killOwned, ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

const resource = "https://bus.invalid/mcp";
const principal = "fixture-principal";
const binding: WakeBinding = {
  address: "chatgpt/fixture",
  session: "fixture-session",
  runtime: "other",
  installation: "installation",
  incarnation: "incarnation",
  run: "first-run",
};
const signal = () => new AbortController().signal;
const directories = new Set<string>();
const authorities = new Set<WatchAuthority>();

const fixture = () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "watch-authority-"));
  directories.add(directory);
  const eventsPath = join(directory, "events.sqlite");
  writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
  return { directory, eventsPath, resource, watchPath: watchAuthorityPath(eventsPath) };
};
const provision = (f: ReturnType<typeof fixture>) => initializeWatchAuthority(f);
const open = (f: { readonly eventsPath: string; readonly resource: string }) => {
  const authority = new WatchAuthority(f);
  authorities.add(authority);
  return authority;
};
const prepare = (authority: WatchAuthority, value: WakeBinding, account = principal) =>
  authority.prepare(
    { address: value.address, principal: account, session: value.session },
    async () => value,
    signal()
  );
const resolve = (authority: WatchAuthority, ticket: string, value = binding, account = principal) =>
  authority.resolve({ address: value.address, principal: account, ticket }, signal());
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release: () => release() };
};
const inspectRows = (path: string) => {
  const db = new Database(path, { readonly: true, strict: true });
  const statement = db.prepare("SELECT * FROM watch_rows ORDER BY address");
  try {
    return statement.all();
  } finally {
    statement.finalize();
    db.close(true);
  }
};

afterEach(async () => {
  for (const authority of authorities) await authority.close();
  authorities.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

test("overlapping preparations share a random canonical ticket and survive reopen", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const first = authority.prepare(
    { address: binding.address, principal, session: binding.session },
    async () => {
      calls++;
      started.release();
      await gate.promise;
      return binding;
    },
    signal()
  );
  try {
    await started.promise;
    const second = authority.prepare(
      { address: binding.address, principal, session: binding.session },
      async () => {
        calls++;
        return binding;
      },
      signal()
    );
    await Bun.sleep(10);
    expect(calls).toBe(1);
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(["ticket"]);
    expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const bytes = Buffer.from(a.ticket, "base64url");
    expect(bytes.length).toBe(16);
    expect(bytes.toString("base64url")).toBe(a.ticket);
    expect(await resolve(authority, a.ticket)).toEqual(binding);
    await authority.close();
    const rows = inspectRows(f.watchPath);
    expect(rows).toHaveLength(1);
    const reopened = open(f);
    expect(await prepare(reopened, binding)).toEqual(a);
    expect(await resolve(reopened, a.ticket)).toEqual(binding);

    const secondFile = fixture();
    provision(secondFile);
    const different = open(secondFile);
    expect((await prepare(different, binding)).ticket).not.toBe(a.ticket);
  } finally {
    gate.release();
    await first.catch(() => undefined);
  }
});

test("binding fields, principal and resource are exact; foreign tickets never select a holder", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  let current = binding;
  let ticket = (await prepare(authority, current)).ticket;
  const variants: WakeBinding[] = [
    { ...binding, session: "second-session" },
    { ...binding, installation: "second-installation" },
    { ...binding, incarnation: "second-incarnation" },
    { ...binding, run: "second-run" },
  ];
  for (const next of variants) {
    const old = ticket;
    ticket = (await prepare(authority, next)).ticket;
    expect(ticket).not.toBe(old);
    await expect(resolve(authority, old, current)).rejects.toThrow("Watch authority unavailable.");
    expect(await resolve(authority, ticket, next)).toEqual(next);
    current = next;
  }
  const changedPrincipal = (await prepare(authority, current, "another-principal")).ticket;
  expect(changedPrincipal).not.toBe(ticket);
  await expect(resolve(authority, changedPrincipal, current)).rejects.toThrow(
    "Watch authority unavailable."
  );
  await expect(
    resolve(authority, changedPrincipal.slice(0, -1), current, "another-principal")
  ).rejects.toThrow("Watch authority unavailable.");
  const altered = (changedPrincipal[0] === "A" ? "B" : "A") + changedPrincipal.slice(1);
  await expect(resolve(authority, altered, current, "another-principal")).rejects.toThrow(
    "Watch authority unavailable."
  );
  await expect(
    resolve(
      authority,
      changedPrincipal,
      { ...current, address: "chatgpt/foreign" },
      "another-principal"
    )
  ).rejects.toThrow("Watch authority unavailable.");
  await expect(
    prepare(authority, { ...current, runtime: "codex" }, "another-principal")
  ).rejects.toThrow("Watch authority unavailable.");

  await authority.close();
  const anotherResource = open({ ...f, resource: "https://other.invalid/mcp" });
  await expect(
    resolve(anotherResource, changedPrincipal, current, "another-principal")
  ).rejects.toThrow("Watch authority unavailable.");
  const newTicket = (await prepare(anotherResource, current, "another-principal")).ticket;
  expect(newTicket).not.toBe(changedPrincipal);
  expect(await resolve(anotherResource, newTicket, current, "another-principal")).toEqual(current);
  expect(WATCH_EVENT).toBe("mail.wake");
});

test("a delayed old observation cannot overwrite a later preparation", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const started = deferred();
  const gate = deferred();
  const newer = { ...binding, run: "newer-run" };
  let secondObserved = false;
  const older = authority.prepare(
    { address: binding.address, principal, session: binding.session },
    async () => {
      started.release();
      await gate.promise;
      return binding;
    },
    signal()
  );
  try {
    await started.promise;
    const later = authority.prepare(
      { address: newer.address, principal, session: newer.session },
      async () => {
        secondObserved = true;
        return newer;
      },
      signal()
    );
    await Bun.sleep(10);
    expect(secondObserved).toBe(false);
    gate.release();
    const first = await older;
    const second = await later;
    expect(second.ticket).not.toBe(first.ticket);
    expect(await resolve(authority, second.ticket, newer)).toEqual(newer);
    await expect(resolve(authority, first.ticket)).rejects.toThrow("Watch authority unavailable.");
  } finally {
    gate.release();
    await older.catch(() => undefined);
  }
});

test("shutdown waits for an abort-ignoring observation and excludes another process", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const old = (await prepare(authority, binding)).ticket;
  expect(() => open(f)).toThrow("Watch authority unavailable.");
  const gate = deferred();
  const started = deferred();
  let observedSignal: AbortSignal | undefined;
  let queuedObserved = false;
  const changed = { ...binding, run: "uncommitted-run" };
  const active = authority
    .prepare(
      { address: changed.address, principal, session: changed.session },
      async (observed) => {
        observedSignal = observed;
        started.release();
        await gate.promise;
        return changed;
      },
      signal()
    )
    .catch((error: unknown) => error);
  const processes = ownership();
  try {
    await started.promise;
    const queued = authority
      .prepare(
        { address: changed.address, principal, session: changed.session },
        async () => {
          queuedObserved = true;
          return changed;
        },
        signal()
      )
      .catch((error: unknown) => error);
    let closed = false;
    const close = authority.close().then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    expect(observedSignal?.aborted).toBe(true);
    expect(closed).toBe(false);
    const competitor = processes.supervisor(
      spawnSupervised([
        process.execPath,
        "--no-env-file",
        "test/fixtures/watch-authority-owner.ts",
        f.eventsPath,
        resource,
        "try",
      ])
    );
    expect(await firstLine(competitor.stdout)).toBe("refused");
    await competitor.exited;
    gate.release();
    expect(String(await active)).toBe("Error: Watch authority unavailable.");
    expect(String(await queued)).toBe("Error: Watch authority unavailable.");
    await close;
    expect(queuedObserved).toBe(false);
    const successor = processes.supervisor(
      spawnSupervised([
        process.execPath,
        "--no-env-file",
        "test/fixtures/watch-authority-owner.ts",
        f.eventsPath,
        resource,
        "try",
      ])
    );
    expect(await firstLine(successor.stdout)).toBe("acquired");
    await successor.exited;
    const reopened = open(f);
    expect(await resolve(reopened, old)).toEqual(binding);
    expect((await prepare(reopened, binding)).ticket).toBe(old);
  } finally {
    gate.release();
    await active;
    await processes.stop();
  }
});

test("a killed acknowledged owner releases SQLite ownership without losing its ticket", async () => {
  const f = fixture();
  provision(f);
  const processes = ownership();
  try {
    const child = processes.supervisor(
      spawnSupervised([
        process.execPath,
        "--no-env-file",
        "test/fixtures/watch-authority-owner.ts",
        f.eventsPath,
        resource,
        "hold",
      ])
    );
    const line = await firstLine(child.stdout);
    const report: unknown = JSON.parse(line);
    if (
      typeof report !== "object" ||
      report === null ||
      !("pid" in report) ||
      !("ticket" in report) ||
      typeof report.ticket !== "string"
    )
      throw new Error("Invalid fixture report.");
    const identity = identify(report.pid);
    if (identity === undefined) throw new Error("Fixture ended before registration.");
    processes.process(identity);
    expect(() => open(f)).toThrow("Watch authority unavailable.");
    killOwned(identity);
    await child.exited;
    const authority = open(f);
    const ownerBinding: WakeBinding = {
      address: "chatgpt/owner",
      session: "owner-session",
      runtime: "other",
      installation: "installation",
      incarnation: "incarnation",
      run: "owner-run",
    };
    expect(await resolve(authority, report.ticket, ownerBinding, "owner-principal")).toEqual(
      ownerBinding
    );
    expect((await prepare(authority, ownerBinding, "owner-principal")).ticket).toBe(report.ticket);
  } finally {
    await processes.stop();
  }
});

test("bounds refuse new rows without evicting existing rows, and allow replacement at row capacity", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const tickets: string[] = [];
  for (let index = 0; index < MAX_WATCH_ROWS; index++) {
    const value = { ...binding, address: "chatgpt/" + String(index) };
    tickets.push((await prepare(authority, value)).ticket);
  }
  const original = { ...binding, address: "chatgpt/0" };
  const first = tickets[0];
  if (first === undefined) throw new Error("Missing first ticket.");
  await expect(prepare(authority, { ...binding, address: "chatgpt/overflow" })).rejects.toThrow(
    "Watch authority unavailable."
  );
  expect((await prepare(authority, original)).ticket).toBe(first);
  const replacement = { ...original, run: "replacement" };
  const next = (await prepare(authority, replacement)).ticket;
  expect(next).not.toBe(first);
  await expect(
    prepare(authority, { ...replacement, run: "x".repeat(MAX_WATCH_ROW_BYTES) })
  ).rejects.toThrow("Watch authority unavailable.");
  expect(await resolve(authority, next, replacement)).toEqual(replacement);
  await authority.close();
  const rows = inspectRows(f.watchPath);
  expect(rows).toHaveLength(MAX_WATCH_ROWS);
});

test("SQLite byte exhaustion preserves acknowledged rows and allows an unchanged preparation", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const first = { ...binding, installation: "x".repeat(12_000), address: "chatgpt/large-0" };
  const original = (await prepare(authority, first)).ticket;
  let exhausted = false;
  for (let index = 1; index < MAX_WATCH_ROWS; index++) {
    try {
      await prepare(authority, { ...first, address: "chatgpt/large-" + String(index) });
    } catch {
      exhausted = true;
      break;
    }
  }
  expect(exhausted).toBe(true);
  expect((await prepare(authority, first)).ticket).toBe(original);
  expect(await resolve(authority, original, first)).toEqual(first);
});

test("a thrown COMMIT returns no ticket and makes the owner fatal before and after execution", async () => {
  for (const timing of ["before", "after"]) {
    const f = fixture();
    provision(f);
    const authority = open(f);
    const oldTicket = (await prepare(authority, binding)).ticket;
    const changed = { ...binding, run: "commit-candidate" };
    const descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
    if (descriptor === undefined || typeof descriptor.value !== "function")
      throw new Error("SQLite prepare is not interceptable.");
    const originalPrepare = descriptor.value;
    let attempted = 0;
    Object.defineProperty(Database.prototype, "prepare", {
      ...descriptor,
      value: function (this: Database, sql: string, ...parameters: unknown[]) {
        const result: unknown = Reflect.apply(originalPrepare, this, [sql, ...parameters]);
        if (!(result instanceof Statement)) throw new Error("Expected a SQLite statement.");
        if (sql === "COMMIT" && attempted === 0) {
          const runDescriptor = Object.getOwnPropertyDescriptor(result, "run");
          if (runDescriptor === undefined || typeof runDescriptor.value !== "function")
            throw new Error("SQLite run is not interceptable.");
          const originalRun = runDescriptor.value;
          Object.defineProperty(result, "run", {
            ...runDescriptor,
            value: (...values: unknown[]) => {
              attempted++;
              if (timing === "after") Reflect.apply(originalRun, result, values);
              throw new Error("COMMIT_FAILURE_CANARY");
            },
          });
        }
        return result;
      },
    });
    try {
      await expect(prepare(authority, changed)).rejects.toThrow("Watch authority unavailable.");
      expect(attempted).toBe(1);
      await expect(resolve(authority, oldTicket)).rejects.toThrow("Watch authority unavailable.");
      let observed = false;
      await expect(
        authority.prepare(
          { address: changed.address, principal, session: changed.session },
          async () => {
            observed = true;
            return changed;
          },
          signal()
        )
      ).rejects.toThrow("Watch authority unavailable.");
      expect(observed).toBe(false);
      expect(attempted).toBe(1);
    } finally {
      Object.defineProperty(Database.prototype, "prepare", descriptor);
    }

    await authority.close();
    const rows = inspectRows(f.watchPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (
      typeof row !== "object" ||
      row === null ||
      !("ticket" in row) ||
      typeof row.ticket !== "string" ||
      !("binding" in row) ||
      !("revision" in row)
    )
      throw new Error("Invalid fixture row.");
    const persisted = timing === "before" ? binding : changed;
    expect(row.binding).toBe(JSON.stringify(persisted));
    expect(row.revision).toBe(timing === "before" ? 1 : 2);
    if (timing === "before") expect(row.ticket).toBe(oldTicket);
    else expect(row.ticket).not.toBe(oldTicket);
    const reopened = open(f);
    expect(await resolve(reopened, row.ticket, persisted)).toEqual(persisted);
    expect((await prepare(reopened, persisted)).ticket).toBe(row.ticket);
  }
});

test("a valid SQLite file with a damaged row refuses startup without modification", async () => {
  for (const damage of ["invalid-json", "mismatched-address"]) {
    const f = fixture();
    provision(f);
    const authority = open(f);
    await prepare(authority, binding);
    await authority.close();
    const database = new Database(f.watchPath, { create: false, strict: true });
    try {
      if (damage === "invalid-json")
        database.run("UPDATE watch_rows SET binding = ? WHERE address = ?", ["{", binding.address]);
      else
        database.run("UPDATE watch_rows SET address = ? WHERE address = ?", [
          "chatgpt/mismatched",
          binding.address,
        ]);
    } finally {
      database.close(true);
    }
    const before = readFileSync(f.watchPath);
    expect(() => open(f)).toThrow("Watch authority unavailable.");
    expect(readFileSync(f.watchPath)).toEqual(before);
  }
});

test("missing, empty, oversized, corrupt, altered schema and WAL state never reset", () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    () => {},
    (f) => writeFileSync(f.watchPath, "", { mode: 0o600, flag: "wx" }),
    (f) => {
      writeFileSync(f.watchPath, Buffer.alloc(MAX_WATCH_DB_BYTES + 1), { mode: 0o600, flag: "wx" });
    },
    (f) => writeFileSync(f.watchPath, "corrupt", { mode: 0o600, flag: "wx" }),
    (f) => {
      provision(f);
      const db = new Database(f.watchPath, { create: false });
      db.run("CREATE TABLE unwanted (value TEXT) STRICT");
      db.close(true);
    },
    (f) => {
      provision(f);
      writeFileSync(f.watchPath + "-wal", "", { mode: 0o600, flag: "wx" });
    },
  ];
  for (const [index, setup] of cases.entries()) {
    const f = fixture();
    setup(f);
    const before = index === 0 ? undefined : hash(f.watchPath);
    expect(() => open(f)).toThrow("Watch authority unavailable.");
    if (before !== undefined) {
      expect(() => provision(f)).toThrow("Watch authority unavailable.");
      expect(hash(f.watchPath)).toBe(before);
    }
  }
});

test("first provisioning refuses orphan sidecars without creating or changing state", () => {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    for (const bytes of [Buffer.alloc(0), Buffer.from("orphan-journal-canary")]) {
      const f = fixture();
      const sidecar = f.watchPath + suffix;
      writeFileSync(sidecar, bytes, { mode: 0o600, flag: "wx" });
      expect(() => provision(f)).toThrow("Watch authority unavailable.");
      expect(existsSync(f.watchPath)).toBe(false);
      expect(readFileSync(sidecar)).toEqual(bytes);
    }
  }
});

test("private real paths reject aliases to files, extra links and public permissions", () => {
  const f = fixture();
  provision(f);
  const canonical = realpathSync(f.eventsPath);
  const alias = join(f.directory, "alias");
  symlinkSync(f.directory, alias);
  expect(watchAuthorityPath(join(alias, "events.sqlite"))).toBe(canonical + ".watch.sqlite");
  symlinkSync(f.eventsPath, join(f.directory, "events-link"));
  expect(() => watchAuthorityPath(join(f.directory, "events-link"))).toThrow(
    "Watch authority unavailable."
  );

  const originalHash = hash(f.watchPath);
  chmodSync(f.watchPath, 0o644);
  expect(() => open(f)).toThrow("Watch authority unavailable.");
  chmodSync(f.watchPath, 0o600);
  expect(hash(f.watchPath)).toBe(originalHash);
  chmodSync(f.directory, 0o755);
  expect(() => open(f)).toThrow("Watch authority unavailable.");
  chmodSync(f.directory, 0o700);
  expect(hash(f.watchPath)).toBe(originalHash);
  const linked = join(f.directory, "hard-link");
  linkSync(f.watchPath, linked);
  expect(() => open(f)).toThrow("Watch authority unavailable.");
  unlinkSync(linked);
  const saved = join(f.directory, "saved");
  renameSync(f.watchPath, saved);
  symlinkSync(saved, f.watchPath);
  expect(() => open(f)).toThrow("Watch authority unavailable.");
  expect(hash(saved)).toBe(originalHash);

  const publicDir = join(f.directory, "public");
  mkdirSync(publicDir, { mode: 0o755 });
  chmodSync(publicDir, 0o755);
  const publicEvents = join(publicDir, "events.sqlite");
  writeFileSync(publicEvents, "", { mode: 0o600 });
  expect(() => watchAuthorityPath(publicEvents)).toThrow("Watch authority unavailable.");
});

test("all store and observer failures are generic and contain no supplied secrets", async () => {
  const f = fixture();
  provision(f);
  const authority = open(f);
  const secret = "SESSION_SECRET_CANARY";
  const failure = await authority
    .prepare(
      { address: binding.address, principal: "PRINCIPAL_SECRET_CANARY", session: secret },
      async () => {
        throw new Error("OBSERVER_SECRET_CANARY " + secret);
      },
      signal()
    )
    .catch((error: unknown) => error);
  expect(String(failure)).toBe("Error: Watch authority unavailable.");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    authority.resolve(
      { address: binding.address, principal: "PRINCIPAL_SECRET_CANARY", ticket: secret },
      aborted.signal
    )
  ).rejects.toThrow("Watch authority unavailable.");
});
