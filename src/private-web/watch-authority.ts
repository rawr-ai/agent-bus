import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { sameWakeBinding, WakeBinding } from "../wake-observation.ts";

export const WATCH_EVENT = "mail.wake";
export const MAX_WATCH_ROWS = 256;
export const MAX_WATCH_ROW_BYTES = 16_384;
export const MAX_WATCH_DB_BYTES = 1_048_576;

const VERSION = 1;
const JOURNAL_LIMIT = MAX_WATCH_DB_BYTES * 2;
const schema = {
  watch_meta: `CREATE TABLE watch_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_nonce TEXT NOT NULL CHECK (length(owner_nonce) = 32)
  ) STRICT`,
  watch_rows: `CREATE TABLE watch_rows (
    address TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0 AND revision <= 9007199254740991),
    ticket TEXT NOT NULL CHECK (length(ticket) = 22),
    principal TEXT NOT NULL,
    resource TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event = 'mail.wake'),
    binding TEXT NOT NULL,
    CHECK (length(CAST(address AS BLOB)) + length(CAST(ticket AS BLOB)) +
      length(CAST(principal AS BLOB)) + length(CAST(resource AS BLOB)) +
      length(CAST(event AS BLOB)) + length(CAST(binding AS BLOB)) <= 16384)
  ) STRICT`,
};
const decodeBinding = Schema.decodeUnknownSync(WakeBinding, { onExcessProperty: "error" });
const StoredRow = Schema.Struct({
  address: Schema.String,
  revision: Schema.Number,
  ticket: Schema.String,
  principal: Schema.String,
  resource: Schema.String,
  event: Schema.String,
  binding: Schema.String,
});
const decodeRow = Schema.decodeUnknownSync(StoredRow, { onExcessProperty: "error" });
const unavailable = () => new Error("Watch authority unavailable.");
const owners = new Set<string>();
const ownerPaths = new Set<string>();

type Options = { readonly eventsPath: string; readonly resource: string };
type Prepare = { readonly address: string; readonly principal: string; readonly session: string };
type Resolve = { readonly address: string; readonly principal: string; readonly ticket: string };
type FileIdentity = { readonly dev: number; readonly ino: number };
type Row = Omit<typeof StoredRow.Type, "binding"> & { readonly binding: WakeBinding };

const validString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_WATCH_ROW_BYTES &&
  Buffer.from(value, "utf8").toString("utf8") === value;

const validTicket = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 16 && decoded.toString("base64url") === value;
};

const fileIdentity = (entry: FileIdentity) => ({ dev: entry.dev, ino: entry.ino });
const sameFile = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;
const ownerKey = (entry: FileIdentity) => String(entry.dev) + ":" + String(entry.ino);

const entryAt = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const privateEntry = (path: string, kind: "file" | "directory") => {
  const entry = entryAt(path);
  if (
    entry === undefined ||
    (kind === "file" ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) ||
    (entry.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && entry.uid !== process.getuid())
  )
    throw unavailable();
  return entry;
};

const candidatePath = (eventsPath: string) => {
  if (!isAbsolute(eventsPath) || resolve(eventsPath) !== eventsPath) throw unavailable();
  return join(realpathSync(dirname(eventsPath)), basename(eventsPath)) + ".watch.sqlite";
};
const paths = (eventsPath: string) => {
  const events = privateEntry(eventsPath, "file");
  const canonicalEvents = realpathSync(eventsPath);
  privateEntry(dirname(canonicalEvents), "directory");
  const canonicalEntry = privateEntry(canonicalEvents, "file");
  if (!sameFile(events, canonicalEntry)) throw unavailable();
  return {
    eventsPath: canonicalEvents,
    events: fileIdentity(canonicalEntry),
    watchPath: canonicalEvents + ".watch.sqlite",
  };
};

/** The sibling is keyed by the real Events file, not an alias of its directory. */
export const watchAuthorityPath = (eventsStoragePath: string): string => {
  try {
    const candidate = candidatePath(eventsStoragePath);
    if (ownerPaths.has(candidate)) return candidate;
    return paths(eventsStoragePath).watchPath;
  } catch {
    throw unavailable();
  }
};

const statements = (database: Database, sql: string, ...parameters: SQLQueryBindings[]) => {
  const statement = database.prepare<unknown, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...parameters);
  } finally {
    statement.finalize();
  }
};
const run = (database: Database, sql: string, ...parameters: SQLQueryBindings[]) => {
  const statement = database.prepare<unknown, SQLQueryBindings[]>(sql);
  try {
    return statement.run(...parameters).changes;
  } finally {
    statement.finalize();
  }
};
const first = (database: Database, sql: string, ...parameters: SQLQueryBindings[]) =>
  statements(database, sql, ...parameters)[0];
const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
const pragma = (database: Database, name: string) => {
  const value = field(first(database, "PRAGMA " + name), name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
};

const validateSidecars = (path: string) => {
  if (entryAt(path + "-wal") !== undefined || entryAt(path + "-shm") !== undefined)
    throw unavailable();
  const journal = entryAt(path + "-journal");
  if (journal !== undefined && privateEntry(path + "-journal", "file").size > JOURNAL_LIMIT)
    throw unavailable();
};

const configure = (database: Database) => {
  run(database, "PRAGMA busy_timeout = 250");
  const locking = field(first(database, "PRAGMA locking_mode = EXCLUSIVE"), "locking_mode");
  const journal = field(first(database, "PRAGMA journal_mode = DELETE"), "journal_mode");
  if (locking !== "exclusive" || journal !== "delete") throw unavailable();
  run(database, "PRAGMA synchronous = FULL");
  if (pragma(database, "synchronous") !== 2) throw unavailable();
  run(database, "PRAGMA journal_size_limit = " + String(JOURNAL_LIMIT));
  const pageSize = pragma(database, "page_size");
  if (pageSize === 0) throw unavailable();
  const limit = Math.floor(MAX_WATCH_DB_BYTES / pageSize);
  const configured = field(
    first(database, "PRAGMA max_page_count = " + String(limit)),
    "max_page_count"
  );
  if (limit < 1 || configured !== limit || pragma(database, "page_count") > limit)
    throw unavailable();
};

const checkSchema = (database: Database) => {
  if (pragma(database, "user_version") !== VERSION) throw unavailable();
  const actual = statements(
    database,
    "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const expected = Object.entries(schema).map(([name, sql]) => ({ name, sql }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw unavailable();
  const integrity = statements(database, "PRAGMA integrity_check(1)");
  if (integrity.length !== 1 || field(integrity[0], "integrity_check") !== "ok")
    throw unavailable();
  const meta = statements(database, "SELECT singleton, owner_nonce FROM watch_meta");
  if (
    meta.length !== 1 ||
    field(meta[0], "singleton") !== 1 ||
    typeof field(meta[0], "owner_nonce") !== "string" ||
    !/^[a-f0-9]{32}$/.test(String(field(meta[0], "owner_nonce")))
  )
    throw unavailable();
};

const materialize = (value: unknown): Row => {
  const row = decodeRow(value);
  const binding = decodeBinding(JSON.parse(row.binding));
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !validTicket(row.ticket) ||
    !validString(row.address) ||
    !validString(row.principal) ||
    !validString(row.resource) ||
    row.event !== WATCH_EVENT ||
    Object.values(binding).some((part) => !validString(part)) ||
    binding.runtime !== "other" ||
    row.address !== binding.address ||
    JSON.stringify(binding) !== row.binding ||
    Buffer.byteLength(JSON.stringify({ ...row, binding }), "utf8") > MAX_WATCH_ROW_BYTES
  )
    throw unavailable();
  return { ...row, binding };
};

const readRow = (database: Database, address: string): Row | undefined => {
  const values = statements(database, "SELECT * FROM watch_rows WHERE address = ?", address);
  if (values.length > 1) throw unavailable();
  return values[0] === undefined ? undefined : materialize(values[0]);
};

/** Offline first provisioning only; existing state, including an empty file, is never reset. */
export const initializeWatchAuthority = (options: Options): void => {
  let database: Database | undefined;
  try {
    if (!validString(options.resource)) throw unavailable();
    if (ownerPaths.has(candidatePath(options.eventsPath))) throw unavailable();
    const location = paths(options.eventsPath);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      if (entryAt(location.watchPath + suffix) !== undefined) throw unavailable();
    }
    const fd = openSync(
      location.watchPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    closeSync(fd);
    const file = privateEntry(location.watchPath, "file");
    if (sameFile(file, location.events)) throw unavailable();
    database = new Database(location.watchPath, { create: false, strict: true });
    configure(database);
    run(database, "BEGIN IMMEDIATE");
    try {
      for (const sql of Object.values(schema)) run(database, sql);
      run(
        database,
        "INSERT INTO watch_meta (singleton, owner_nonce) VALUES (1, ?)",
        randomBytes(16).toString("hex")
      );
      run(database, "PRAGMA user_version = " + String(VERSION));
      run(database, "COMMIT");
    } catch {
      try {
        run(database, "ROLLBACK");
      } catch {}
      throw unavailable();
    }
    checkSchema(database);
    database.close(true);
    database = undefined;
  } catch {
    try {
      database?.close(true);
    } catch {}
    throw unavailable();
  }
};

/** Owns a separate SQLite connection until every submitted preparation has actually settled. */
export class WatchAuthority {
  readonly sqliteVersion: string;
  readonly #database: Database;
  readonly #location: ReturnType<typeof paths>;
  readonly #file: FileIdentity;
  readonly #ownerKey: string;
  readonly #ownerPath: string;
  readonly #resource: string;
  readonly #lifetime = new AbortController();
  #queue: Promise<void> = Promise.resolve();
  #closing = false;
  #fatal = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: Options) {
    let database: Database | undefined;
    let registered: string | undefined;
    let registeredPath: string | undefined;
    try {
      if (!validString(options.resource)) throw unavailable();
      const candidate = candidatePath(options.eventsPath);
      if (ownerPaths.has(candidate)) throw unavailable();
      const location = paths(options.eventsPath);
      if (location.watchPath !== candidate || ownerPaths.has(location.watchPath))
        throw unavailable();
      const file = privateEntry(location.watchPath, "file");
      if (
        file.size === 0 ||
        file.size > MAX_WATCH_DB_BYTES ||
        sameFile(file, location.events) ||
        realpathSync(location.watchPath) !== location.watchPath
      )
        throw unavailable();
      validateSidecars(location.watchPath);
      const key = ownerKey(file);
      if (owners.has(key)) throw unavailable();
      owners.add(key);
      registered = key;
      ownerPaths.add(location.watchPath);
      registeredPath = location.watchPath;
      database = new Database(location.watchPath, { create: false, strict: true });
      configure(database);
      checkSchema(database);
      const rows = statements(database, "SELECT * FROM watch_rows");
      if (rows.length > MAX_WATCH_ROWS) throw unavailable();
      for (const row of rows) materialize(row);
      const version = field(first(database, "SELECT sqlite_version() AS version"), "version");
      if (typeof version !== "string" || version.length === 0) throw unavailable();
      run(database, "BEGIN IMMEDIATE");
      try {
        if (
          run(
            database,
            "UPDATE watch_meta SET owner_nonce = ? WHERE singleton = 1",
            randomBytes(16).toString("hex")
          ) !== 1
        )
          throw unavailable();
        run(database, "COMMIT");
      } catch {
        try {
          run(database, "ROLLBACK");
        } catch {}
        throw unavailable();
      }
      if (!sameFile(privateEntry(location.watchPath, "file"), file)) throw unavailable();
      this.sqliteVersion = version;
      this.#database = database;
      this.#location = location;
      this.#file = fileIdentity(file);
      this.#ownerKey = key;
      this.#ownerPath = location.watchPath;
      this.#resource = options.resource;
    } catch {
      try {
        database?.close(true);
      } catch {}
      if (registered !== undefined) owners.delete(registered);
      if (registeredPath !== undefined) ownerPaths.delete(registeredPath);
      throw unavailable();
    }
  }

  #check(signal: AbortSignal) {
    if (this.#closing || this.#fatal || signal.aborted) throw unavailable();
    const file = privateEntry(this.#location.watchPath, "file");
    const events = privateEntry(this.#location.eventsPath, "file");
    privateEntry(dirname(this.#location.watchPath), "directory");
    if (
      !sameFile(file, this.#file) ||
      !sameFile(events, this.#location.events) ||
      file.size > MAX_WATCH_DB_BYTES
    )
      throw unavailable();
    validateSidecars(this.#location.watchPath);
  }

  prepare(
    request: Prepare,
    observe: (signal: AbortSignal) => Promise<WakeBinding>,
    signal: AbortSignal
  ): Promise<{ ticket: string }> {
    const address = request.address;
    const principal = request.principal;
    const session = request.session;
    if (
      this.#closing ||
      this.#fatal ||
      signal.aborted ||
      !validString(address) ||
      !validString(principal) ||
      !validString(session)
    )
      return Promise.reject(unavailable());
    const job = this.#queue.then(async () => {
      this.#check(signal);
      const previous = readRow(this.#database, address);
      const binding = decodeBinding(
        await observe(AbortSignal.any([signal, this.#lifetime.signal]))
      );
      this.#check(signal);
      if (
        binding.address !== address ||
        binding.session !== session ||
        binding.runtime !== "other" ||
        Object.values(binding).some((part) => !validString(part))
      )
        throw unavailable();

      run(this.#database, "BEGIN IMMEDIATE");
      let committing = false;
      try {
        const current = readRow(this.#database, address);
        if (current?.revision !== previous?.revision) throw unavailable();
        if (
          current !== undefined &&
          current.principal === principal &&
          current.resource === this.#resource &&
          current.event === WATCH_EVENT &&
          sameWakeBinding(current.binding, binding)
        ) {
          run(this.#database, "ROLLBACK");
          return { ticket: current.ticket };
        }
        if (current === undefined) {
          const count = field(
            first(this.#database, "SELECT count(*) AS count FROM watch_rows"),
            "count"
          );
          if (typeof count !== "number" || count >= MAX_WATCH_ROWS) throw unavailable();
        }
        const revision = current === undefined ? 1 : current.revision + 1;
        const ticket = randomBytes(16).toString("base64url");
        const stored = {
          address,
          revision,
          ticket,
          principal,
          resource: this.#resource,
          event: WATCH_EVENT,
          binding: JSON.stringify(binding),
        };
        materialize(stored);
        const changed =
          current === undefined
            ? run(
                this.#database,
                "INSERT INTO watch_rows (address, revision, ticket, principal, resource, event, binding) VALUES (?, ?, ?, ?, ?, ?, ?)",
                stored.address,
                stored.revision,
                stored.ticket,
                stored.principal,
                stored.resource,
                stored.event,
                stored.binding
              )
            : run(
                this.#database,
                "UPDATE watch_rows SET revision = ?, ticket = ?, principal = ?, resource = ?, event = ?, binding = ? WHERE address = ? AND revision = ?",
                stored.revision,
                stored.ticket,
                stored.principal,
                stored.resource,
                stored.event,
                stored.binding,
                stored.address,
                current.revision
              );
        if (changed !== 1) throw unavailable();
        committing = true;
        run(this.#database, "COMMIT");
        return { ticket };
      } catch {
        if (committing) this.#fatal = true;
        if (this.#database.inTransaction) {
          try {
            run(this.#database, "ROLLBACK");
          } catch {
            this.#fatal = true;
          }
        }
        throw unavailable();
      }
    });
    this.#queue = job.then(
      () => undefined,
      () => undefined
    );
    return job.catch(() => {
      throw unavailable();
    });
  }

  async resolve(request: Resolve, signal: AbortSignal): Promise<WakeBinding> {
    try {
      this.#check(signal);
      if (
        !validString(request.address) ||
        !validString(request.principal) ||
        !validTicket(request.ticket)
      )
        throw unavailable();
      const row = readRow(this.#database, request.address);
      if (
        row === undefined ||
        !timingSafeEqual(Buffer.from(request.ticket, "ascii"), Buffer.from(row.ticket, "ascii")) ||
        row.principal !== request.principal ||
        row.resource !== this.#resource ||
        row.event !== WATCH_EVENT
      )
        throw unavailable();
      return row.binding;
    } catch {
      throw unavailable();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#lifetime.abort();
    this.#closePromise = (async () => {
      await this.#queue;
      try {
        this.#database.close(true);
        owners.delete(this.#ownerKey);
        ownerPaths.delete(this.#ownerPath);
      } catch {
        throw unavailable();
      }
    })();
    return this.#closePromise;
  }
}
