import { basename, dirname, join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { CursorJson, CursorPosition, cursorFileName, cursorText } from "./Cursors.ts";
import { LedgerError, latestPresences } from "./domain.ts";
import { Ledger } from "./Ledger.ts";

const manifestName = "layout";
const receiptName = ".cursor-export";
const exporting = ".export-pending";
const uuidV7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const interruptedWrite = new RegExp(`^.*\\.json\\.${uuidV7}\\.tmp$`);
const Generation = Schema.String.check(Schema.isPattern(new RegExp(`^${uuidV7}$`)));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Manifest = Schema.fromJsonString(Schema.Struct({ generation: Generation, legacy: Digest }));
const Receipt = Schema.fromJsonString(
  Schema.Struct({ generation: Generation, operation: Generation, exported: Digest })
);
const PendingExport = Schema.fromJsonString(
  Schema.Struct({
    generation: Generation,
    operation: Generation,
    exact: Digest,
    original: Digest,
    exported: Digest,
  })
);
const LegacyJson = Schema.fromJsonString(Schema.Struct({ cursor: CursorPosition }));

type Record = typeof CursorJson.Type;
type File = readonly [name: string, bytes: Uint8Array];
type Output = readonly [name: string, text: string];
type Snapshot = { readonly files: ReadonlyArray<File>; readonly marker?: Uint8Array };
type ExportPlan = typeof PendingExport.Type;

const exactPath = (legacy: string) => `${legacy}.v2`;
const backupPath = (dir: string, generation: string) => `${dir}.saved-${generation}`;
const refused = (message: string) => new LedgerError({ message: `Cursor layout: ${message}` });
const fileError = () => refused("could not read or write cursor state.");
const sha256 = (value: string | Uint8Array) => Bun.CryptoHasher.hash("sha256", value, "hex");
const fingerprint = (files: ReadonlyArray<File>) =>
  sha256(JSON.stringify(files.map(([name, bytes]) => [name, sha256(bytes)])));
const snapshotIdentity = (snapshot: Snapshot | undefined) =>
  sha256(
    JSON.stringify([
      snapshot !== undefined,
      fingerprint(snapshot?.files ?? []),
      snapshot?.marker === undefined ? null : sha256(snapshot.marker),
    ])
  );

const appleDouble = (bytes: Uint8Array) =>
  bytes[0] === 0 && bytes[1] === 5 && bytes[2] === 22 && bytes[3] === 7;

const fromBytes = <A, I>(schema: Schema.Codec<A, I>, bytes: Uint8Array, label: string) =>
  Effect.try({
    try: () => cursorText(bytes),
    catch: () => refused(`${label} is not readable JSON.`),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => refused(`${label} is not readable JSON.`))
  );

const infoAt = (fs: FileSystem.FileSystem, path: string) =>
  fs
    .lstat(path)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(fileError())
      )
    );

const readRegular = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    if ((yield* infoAt(fs, path))?.type !== "File") return yield* fileError();
    return yield* fs.readFile(path).pipe(Effect.mapError(fileError));
  });

const readSnapshot = (fs: FileSystem.FileSystem, path: string, markerName: string) =>
  Effect.gen(function* () {
    const info = yield* infoAt(fs, path);
    if (info === undefined) return undefined;
    if (info.type !== "Directory") return yield* fileError();
    const names = (yield* fs.readDirectory(path).pipe(Effect.mapError(fileError))).sort();
    const files: Array<File> = [];
    let marker: Uint8Array | undefined;
    for (const name of names) {
      const file = join(path, name);
      if (
        name === ".DS_Store" ||
        (markerName === manifestName && name === exporting) ||
        interruptedWrite.test(name)
      )
        continue;
      const bytes = yield* readRegular(fs, file);
      if (name.startsWith("._") && appleDouble(bytes)) continue;
      if (name === markerName) marker = bytes;
      else if (name.endsWith(".json")) files.push([name, bytes]);
      else {
        return yield* refused(`unexpected file ${JSON.stringify(name)}; preserve it for review.`);
      }
    }
    return { files, ...(marker === undefined ? {} : { marker }) } satisfies Snapshot;
  });

const readLegacy = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const snapshot = yield* readSnapshot(fs, path, receiptName);
    const files = snapshot?.files ?? [];
    const receipt =
      snapshot?.marker === undefined
        ? undefined
        : yield* fromBytes(Receipt, snapshot.marker, "the legacy export receipt");
    return {
      exists: snapshot !== undefined,
      files,
      hash: fingerprint(files),
      identity: snapshotIdentity(snapshot),
      receipt,
    };
  });

const readManifest = (fs: FileSystem.FileSystem, dir: string) =>
  Effect.gen(function* () {
    const info = yield* infoAt(fs, dir);
    if (info === undefined) return undefined;
    if (info.type !== "Directory") return yield* fileError();
    const bytes = yield* readRegular(fs, join(dir, manifestName));
    return yield* fromBytes(Manifest, bytes, "the exact cursor manifest");
  });

type LegacySnapshot = Effect.Success<ReturnType<typeof readLegacy>>;
const checkRetained = (legacy: LegacySnapshot, manifest: typeof Manifest.Type) => {
  if (legacy.receipt?.generation === manifest.generation) {
    return Effect.fail(
      refused(
        "the active legacy path contains this exact generation's export receipt without a pending export; keep serve stopped."
      )
    );
  }
  if (legacy.hash !== manifest.legacy) {
    return Effect.fail(
      refused(
        "retained legacy files changed since migration; preserve both generations and keep serve stopped."
      )
    );
  }
  return Effect.void;
};

const pendingExport = (fs: FileSystem.FileSystem, exact: string) =>
  Effect.gen(function* () {
    const file = join(exact, exporting);
    if ((yield* infoAt(fs, file)) === undefined) return undefined;
    const bytes = yield* readRegular(fs, file);
    return yield* fromBytes(PendingExport, bytes, "the pending export");
  });

const exportUnfinished = () =>
  refused("a legacy export is unfinished; keep serve stopped and resume it or run abort-export.");

/** Publish a complete sibling directory, never an active path with only some of its files. */
const stage = (fs: FileSystem.FileSystem, target: string, files: ReadonlyArray<Output>) =>
  Effect.gen(function* () {
    const parent = dirname(target);
    yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(fileError));
    const prepared = yield* fs
      .makeTempDirectoryScoped({ directory: parent, prefix: ".cursor-stage-" })
      .pipe(Effect.mapError(fileError));
    for (const [name, text] of files) {
      yield* fs
        .writeFileString(join(prepared, name), text, { flag: "wx", mode: 0o600 })
        .pipe(Effect.mapError(fileError));
    }
    return prepared;
  });

const publish = (fs: FileSystem.FileSystem, prepared: string, target: string) =>
  Effect.gen(function* () {
    if ((yield* infoAt(fs, target)) !== undefined) {
      return yield* refused("a target directory already exists; do not replace it.");
    }
    yield* fs.rename(prepared, target).pipe(Effect.mapError(fileError));
  });

const exactOutput = (
  records: ReadonlyArray<Record>,
  manifest: typeof Manifest.Type
): Array<Output> => [
  [manifestName, JSON.stringify(manifest)],
  ...records.map((record) => [cursorFileName(record.address), JSON.stringify(record)] as const),
];

/** Fresh installations need no migration; existing legacy data can only be converted offline. */
export const openCursorDirectory = (legacy: string, installation: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exact = exactPath(legacy);
    const manifest = yield* readManifest(fs, exact);
    const old = yield* readLegacy(fs, legacy);
    if (manifest !== undefined) {
      if (yield* pendingExport(fs, exact)) return yield* exportUnfinished();
      yield* checkRetained(old, manifest);
    } else {
      if (old.receipt !== undefined) {
        return yield* refused(
          "no active exact generation remains and a legacy export receipt is present. Keep serve stopped; verify the completed export before migrating current positions (docs/runbooks/recover.md)."
        );
      }
      if (old.files.length > 0) {
        return yield* refused(
          "run agent-bus cursors --action migrate with serve disabled and stopped before starting it."
        );
      }
      const ledger = yield* Ledger;
      const { local } = yield* historicalNames(ledger, installation);
      yield* checkLocalPositions(local, []);
      const files = exactOutput([], { generation: Bun.randomUUIDv7(), legacy: old.hash });
      const prepared = yield* stage(fs, exact, files);
      yield* publish(fs, prepared, exact);
    }
    return exact;
  }).pipe(Effect.scoped);

const legacyName = (address: string) => {
  try {
    return `${encodeURIComponent(address)}.json`;
  } catch {
    return undefined;
  }
};

const atCut = (cursor: number, head: number, label: string) =>
  cursor <= head
    ? Effect.void
    : Effect.fail(refused(`${label} is ahead of the pinned ledger; do not reset it.`));

const historicalNames = (ledger: Ledger["Service"], installation: string) =>
  Effect.gen(function* () {
    const { entries, cut } = yield* ledger.presenceAt();
    if (cut.incarnation !== ledger.instance)
      return yield* refused("the ledger incarnation changed.");
    const candidates = new Map<string, Set<string>>();
    for (const { from } of entries) {
      const name = legacyName(from)?.toLowerCase();
      if (name === undefined) continue;
      const group = candidates.get(name) ?? new Set<string>();
      group.add(from);
      candidates.set(name, group);
    }
    const local = [...latestPresences(entries).values()]
      .filter(
        ({ presence }) => presence.status === "joined" && presence.installation === installation
      )
      .map(({ address }) => address);
    return { candidates, cut, local };
  });

const checkLocalPositions = (local: ReadonlyArray<string>, records: ReadonlyArray<Record>) => {
  const retained = new Set(records.map(({ address }) => address));
  const missing = local.filter((address) => !retained.has(address)).sort();
  const first = missing[0];
  if (first === undefined) return Effect.void;
  const preview =
    first.length > 96 ? `${JSON.stringify(first.slice(0, 96))} (truncated)` : JSON.stringify(first);
  const name = legacyName(first);
  const legacy =
    name !== undefined && name.length <= 255 ? `; legacy file ${JSON.stringify(name)}` : "";
  return Effect.fail(
    refused(
      `${missing.length} currently held local address(es) have no attributable cursor; first: ${preview} (exact file ${cursorFileName(first)}${legacy}). Preserve state for repair.`
    )
  );
};

const legacyRecords = (old: LegacySnapshot, ledger: Ledger["Service"], installation: string) =>
  Effect.gen(function* () {
    const { candidates, cut, local } = yield* historicalNames(ledger, installation);
    const records: Array<Record> = [];
    for (const [name, bytes] of old.files) {
      const label = `legacy file ${JSON.stringify(name)}`;
      const variants = candidates.get(name.toLowerCase());
      if (variants !== undefined && variants.size > 1) {
        return yield* refused(
          `${label} matches ${variants.size} historical addresses; no cursor was assigned.`
        );
      }
      const address = variants?.values().next().value;
      if (address === undefined || legacyName(address) !== name) {
        return yield* refused(`${label} has no exact historical witness; no cursor was assigned.`);
      }
      const { cursor } = yield* fromBytes(LegacyJson, bytes, label);
      yield* atCut(cursor, cut.head, label);
      records.push({ address, cursor });
    }
    yield* checkLocalPositions(local, records);
    return { records, cut };
  });

const exactRecords = (snapshot: Snapshot, head: number) =>
  Effect.gen(function* () {
    const records: Array<Record> = [];
    for (const [name, bytes] of snapshot.files) {
      const label = `exact file ${JSON.stringify(name)}`;
      const record = yield* fromBytes(CursorJson, bytes, label);
      if (cursorFileName(record.address) !== name) {
        return yield* refused(`${label} has a mismatched address witness.`);
      }
      yield* atCut(record.cursor, head, label);
      records.push(record);
    }
    return records;
  });

const legacyOutput = (
  records: ReadonlyArray<Record>,
  historical: ReadonlyMap<string, ReadonlySet<string>>
) =>
  Effect.gen(function* () {
    const folded = new Set<string>();
    const result: Array<Output> = [];
    for (const { address, cursor } of records) {
      const name = legacyName(address);
      // The old writer appends ".<36-character UUID>.tmp" before renaming.
      if (name === undefined || name.length + 41 > 255) {
        return yield* refused(
          "an exact address cannot be written by the legacy format; do not downgrade."
        );
      }
      const key = name.toLowerCase();
      const variants = historical.get(key);
      if (folded.has(key) || (variants !== undefined && variants.size > 1)) {
        return yield* refused("two exact addresses alias in the legacy format; do not downgrade.");
      }
      if (!variants?.has(address)) {
        return yield* refused("an exact cursor has no historical witness; do not downgrade.");
      }
      folded.add(key);
      result.push([name, JSON.stringify({ cursor })]);
    }
    return result.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  });

const publishPlan = (fs: FileSystem.FileSystem, exact: string, plan: ExportPlan) => {
  const file = join(exact, exporting);
  const temp = `${file}.json.${Bun.randomUUIDv7()}.tmp`;
  return fs
    .writeFileString(temp, JSON.stringify(plan), { flag: "wx", mode: 0o600 })
    .pipe(
      Effect.andThen(fs.link(temp, file)),
      Effect.mapError(fileError),
      Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore))
    );
};

const projected = (old: LegacySnapshot, plan: ExportPlan) =>
  old.receipt?.generation === plan.generation &&
  old.receipt.operation === plan.operation &&
  old.receipt.exported === plan.exported &&
  old.hash === plan.exported;

const parkedPath = (legacy: string, plan: ExportPlan) => `${legacy}.aborted-${plan.operation}`;

/** During export the current old path is the original, absent, or this plan's untouched output. */
const originalLegacy = (
  fs: FileSystem.FileSystem,
  backup: string,
  current: LegacySnapshot,
  plan: ExportPlan
) =>
  Effect.gen(function* () {
    if (current.identity === plan.original) return current;
    if (current.exists && !projected(current, plan)) {
      return yield* refused("legacy files diverged from the export plan; keep serve stopped.");
    }
    const original = yield* readLegacy(fs, backup);
    if (original.identity !== plan.original) {
      return yield* refused("the original legacy backup no longer matches; keep serve stopped.");
    }
    return original;
  });

const confirmExactSource = (fs: FileSystem.FileSystem, exact: string, plan: ExportPlan) =>
  Effect.gen(function* () {
    const current = yield* readSnapshot(fs, exact, manifestName);
    const pending = yield* pendingExport(fs, exact);
    if (
      snapshotIdentity(current) !== plan.exact ||
      JSON.stringify(pending) !== JSON.stringify(plan)
    ) {
      return yield* refused("the exact files or pending export changed; keep serve stopped.");
    }
  });

const abortExport = (
  fs: FileSystem.FileSystem,
  legacy: string,
  exact: string,
  plan: ExportPlan,
  confirmOffline: Effect.Effect<void, LedgerError>
) =>
  Effect.gen(function* () {
    const backup = backupPath(legacy, plan.generation);
    const parked = parkedPath(legacy, plan);
    yield* confirmOffline;
    yield* confirmExactSource(fs, exact, plan);
    const current = yield* readLegacy(fs, legacy);
    const original = yield* originalLegacy(fs, backup, current, plan);
    if (current.identity !== plan.original) {
      if (current.exists) yield* publish(fs, legacy, parked);
      if (original.exists) yield* publish(fs, backup, legacy);
    }
    yield* confirmOffline;
    yield* confirmExactSource(fs, exact, plan);
    if ((yield* readLegacy(fs, legacy)).identity !== plan.original) {
      return yield* refused("the original legacy files changed during abort; keep serve stopped.");
    }
    // Exact is still authoritative. Remove the hold only after its old source is safely restored.
    const output = (yield* infoAt(fs, parked)) === undefined ? {} : { parked: basename(parked) };
    yield* fs.remove(join(exact, exporting)).pipe(Effect.mapError(fileError));
    return output;
  });

export type CursorAction = "check" | "migrate" | "export" | "abort-export";
type LegacyExport =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };
type CursorReport = {
  readonly incarnation: string;
  readonly head: number;
  readonly count: number;
  readonly parked?: string;
} & (
  | { readonly state: "legacy"; readonly generation?: never }
  | {
      readonly state: "exact";
      readonly generation: string;
      readonly legacyExport?: LegacyExport;
    }
  | { readonly state: "exported"; readonly generation: string }
);

/** The caller supplies the installation's stopped-writer proof for write actions. */
export const cursorTransition = (
  legacy: string,
  installation: string,
  action: CursorAction,
  confirmOffline: Effect.Effect<void, LedgerError>
): Effect.Effect<CursorReport, LedgerError, FileSystem.FileSystem | Ledger> =>
  Effect.gen(function* () {
    if (action !== "check") yield* confirmOffline;
    const fs = yield* FileSystem.FileSystem;
    const ledger = yield* Ledger;
    const exact = exactPath(legacy);
    const manifest = yield* readManifest(fs, exact);
    const old = yield* readLegacy(fs, legacy);

    if (manifest === undefined && action === "abort-export") {
      return yield* refused(
        "no active exact generation remains to resume; a completed export cannot abort. Keep serve stopped and follow the verified forward recovery (docs/runbooks/recover.md)."
      );
    }
    if (manifest === undefined && action === "export") {
      const receipt = old.receipt;
      if (
        receipt === undefined ||
        old.hash !== receipt.exported ||
        (yield* readManifest(fs, backupPath(exact, receipt.generation)))?.generation !==
          receipt.generation
      ) {
        return yield* refused(
          "no completed export of the current cursor state was found; do not downgrade."
        );
      }
      const { cut } = yield* legacyRecords(old, ledger, installation);
      return {
        state: "exported" as const,
        ...cut,
        generation: receipt.generation,
        count: old.files.length,
      };
    }
    if (manifest === undefined) {
      const { records, cut } = yield* legacyRecords(old, ledger, installation);
      if (action === "migrate") {
        const generation = Bun.randomUUIDv7();
        const files = exactOutput(records, { generation, legacy: old.hash });
        const staging = yield* stage(fs, exact, files);
        yield* confirmOffline;
        const current = yield* readLegacy(fs, legacy);
        if (current.identity !== old.identity) {
          return yield* refused("legacy files changed during migration. Nothing was published.");
        }
        yield* publish(fs, staging, exact);
        return { state: "exact" as const, ...cut, generation, count: records.length };
      }
      return { state: "legacy" as const, ...cut, count: records.length };
    }

    const pending = yield* pendingExport(fs, exact);
    if (pending !== undefined && action !== "export" && action !== "abort-export") {
      return yield* exportUnfinished();
    }
    const snapshot = yield* readSnapshot(fs, exact, manifestName);
    if (snapshot?.marker === undefined) return yield* fileError();
    const exactIdentity = snapshotIdentity(snapshot);
    if (
      pending !== undefined &&
      (pending.generation !== manifest.generation || pending.exact !== exactIdentity)
    ) {
      return yield* refused("the exact files changed after export began; keep serve stopped.");
    }
    const history = yield* historicalNames(ledger, installation);
    const head = history.cut.head;
    const records = yield* exactRecords(snapshot, head);
    yield* checkLocalPositions(history.local, records);
    const report = {
      incarnation: ledger.instance,
      generation: manifest.generation,
      head,
      count: records.length,
    };
    if (action !== "export") {
      if (pending !== undefined) {
        const recovery = yield* abortExport(fs, legacy, exact, pending, confirmOffline);
        return { state: "exact" as const, ...report, ...recovery };
      }
      yield* checkRetained(old, manifest);
      if (action === "check") {
        // Report only projection refusals, not faults reading or validating the state above.
        const legacyExport = yield* legacyOutput(records, history.candidates).pipe(
          Effect.match({
            onSuccess: (): LegacyExport => ({ eligible: true }),
            onFailure: ({ message }): LegacyExport => ({ eligible: false, reason: message }),
          })
        );
        return { state: "exact" as const, ...report, legacyExport };
      }
      return { state: "exact" as const, ...report };
    }

    if (pending !== undefined && (yield* infoAt(fs, parkedPath(legacy, pending))) !== undefined) {
      return yield* refused("the abort has already parked the projection; resume abort-export.");
    }
    const files = yield* legacyOutput(records, history.candidates);
    const exported = fingerprint(files.map(([name, text]) => [name, Buffer.from(text, "utf8")]));
    const plan = pending ?? {
      generation: manifest.generation,
      operation: Bun.randomUUIDv7(),
      exact: exactIdentity,
      original: old.identity,
      exported,
    };
    if (plan.exported !== exported) return yield* refused("the planned legacy projection changed.");
    const backup = backupPath(legacy, plan.generation);
    if (pending === undefined) yield* checkRetained(old, manifest);
    yield* originalLegacy(fs, backup, old, plan);
    if (!projected(old, plan)) {
      const receipt = { generation: plan.generation, operation: plan.operation, exported };
      const staging = yield* stage(fs, legacy, [...files, [receiptName, JSON.stringify(receipt)]]);
      yield* confirmOffline;
      const current = yield* readLegacy(fs, legacy);
      if (current.identity !== old.identity) {
        return yield* refused("legacy files changed during export; do not downgrade.");
      }
      if (pending === undefined) {
        if (snapshotIdentity(yield* readSnapshot(fs, exact, manifestName)) !== plan.exact) {
          return yield* refused("exact files changed during staging; do not downgrade.");
        }
        yield* publishPlan(fs, exact, plan);
      }
      yield* confirmExactSource(fs, exact, plan);
      if (current.exists) {
        yield* publish(fs, legacy, backup);
        yield* confirmOffline;
        yield* confirmExactSource(fs, exact, plan);
        yield* originalLegacy(fs, backup, yield* readLegacy(fs, legacy), plan);
      }
      yield* publish(fs, staging, legacy);
    }
    yield* confirmOffline;
    yield* confirmExactSource(fs, exact, plan);
    const installed = yield* readLegacy(fs, legacy);
    yield* originalLegacy(fs, backup, installed, plan);
    if (!projected(installed, plan)) {
      return yield* refused("the published legacy files changed during export; do not downgrade.");
    }
    // Keep the exact generation authoritative until the complete legacy one is in place.
    yield* publish(fs, exact, backupPath(exact, manifest.generation));
    return { state: "exported" as const, ...report };
  }).pipe(Effect.scoped);
