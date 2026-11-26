import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import { cursorFileName } from "./Cursors.ts";
import { type CursorImportFile, cursorImportSnapshot } from "./cursor-layout.ts";
import { LedgerError, latestPresences, type Message, runOf, type Subscriber } from "./domain.ts";
import { loadInstallation } from "./installation.ts";
import { Ledger } from "./Ledger.ts";
import {
  type MailboxStart,
  type MailboxUnresolved,
  mailboxHolderRef,
  mailboxInstallationRef,
  mailboxIntentMatches,
  mailboxPresenceRef,
  mailboxRunRef,
} from "./mailbox-model.ts";
import type { Pin } from "./Query.ts";

export const MailboxSourceJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    ledger: Schema.String,
    installation: Schema.String,
    cut: Schema.Struct({
      incarnation: Schema.String,
      head: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
    capturedAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffffffffffff })),
    digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  })
);
export type MailboxSource = typeof MailboxSourceJson.Type;

export interface PairedCopy {
  readonly root: string;
  readonly receipt: MailboxSource;
}

const refused = (message: string) => new LedgerError({ message: `Mailbox import: ${message}` });
const sameCut = (one: Pin, two: Pin) =>
  one.incarnation === two.incarnation && one.head === two.head;

const component = (value: string) =>
  value !== "" &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0");

/** The file writer encoded the ledger name, but used the incarnation verbatim. */
export const legacyCursorPath = (root: string, ledger: string, incarnation: string) =>
  Effect.gen(function* () {
    const invalid = () => refused("the ledger and incarnation must name safe cursor directories.");
    const directory = yield* Effect.try({ try: () => encodeURIComponent(ledger), catch: invalid });
    if (!component(directory) || !component(incarnation)) return yield* invalid();
    return join(root, "fluree-cursors", directory, incarnation);
  });

/** Read-only evidence taken beside the original files, with that installation held. */
export const captureMailboxSource = (
  root: string,
  ledgerName: string,
  cut: Pin,
  confirmHeld: Effect.Effect<void, LedgerError>
) =>
  Effect.gen(function* () {
    yield* confirmHeld;
    const ledger = yield* Ledger;
    if (!sameCut(cut, (yield* ledger.presenceAt()).cut)) {
      return yield* refused("the original ledger is not at the requested cut.");
    }
    const installation = yield* loadInstallation(root);
    const path = yield* legacyCursorPath(root, ledgerName, cut.incarnation);
    const { digest } = yield* cursorImportSnapshot(path);
    yield* confirmHeld;
    const confirmed = yield* cursorImportSnapshot(path);
    if (confirmed.digest !== digest)
      return yield* refused("the cursor inventory changed during capture.");
    if (!sameCut(cut, (yield* ledger.presenceAt()).cut)) {
      return yield* refused(
        "the ledger changed during capture; hold both old writers and recapture."
      );
    }
    return {
      version: 1,
      ledger: ledgerName,
      installation,
      cut,
      capturedAt: Date.now(),
      digest,
    } satisfies MailboxSource;
  });

/** One versioned operation per exact address, stable across process loss and source order. */
const operationFor = (address: string, one: MailboxSource, two: MailboxSource) => {
  const time = Math.max(one.capturedAt, two.capturedAt).toString(16).padStart(12, "0");
  const data = JSON.stringify([
    "agent-bus/mailbox-import/v1",
    one.ledger,
    one.cut.incarnation,
    one.cut.head,
    one.installation,
    one.digest,
    one.capturedAt,
    two.installation,
    two.digest,
    two.capturedAt,
    address,
  ]);
  const hash = createHash("sha256").update(data).digest("hex");
  const variant = (8 | (Number.parseInt(hash.slice(3, 4), 16) & 3)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hash.slice(0, 3)}-${variant}${hash.slice(4, 7)}-${hash.slice(7, 19)}`;
};

const decide = (
  holding: Subscriber,
  lastJoin: Subscriber | undefined,
  one: { readonly receipt: MailboxSource; readonly files: ReadonlyMap<string, CursorImportFile> },
  two: { readonly receipt: MailboxSource; readonly files: ReadonlyMap<string, CursorImportFile> }
): MailboxStart | MailboxUnresolved => {
  const { address } = holding;
  const run = runOf(lastJoin ?? holding);
  const owner = lastJoin?.presence.installation;
  const name = cursorFileName(address);
  const a = one.files.get(name);
  const b = two.files.get(name);
  const cut = one.receipt.cut;
  const presenceRef = mailboxPresenceRef(holding.joinId);
  const vacancy =
    holding.presence.status === "left" &&
    lastJoin !== undefined &&
    holding.presence.runtime === lastJoin.presence.runtime &&
    holding.presence.session !== undefined &&
    holding.presence.session === lastJoin.presence.session
      ? {
          cut,
          presenceRef,
          runRef: mailboxRunRef(run),
          holderRef: mailboxHolderRef(holding.presence.runtime, holding.presence.session),
          noFiles:
            a === undefined &&
            b === undefined &&
            (owner === undefined ||
              owner === one.receipt.installation ||
              owner === two.receipt.installation),
        }
      : undefined;
  const operation = operationFor(address, one.receipt, two.receipt);
  const unresolved = (reason: MailboxUnresolved["reason"]): MailboxUnresolved => ({
    version: 1,
    kind: "unresolved",
    operation,
    address,
    reason,
    ...(vacancy === undefined ? {} : { vacant: vacancy }),
  });
  if (a !== undefined && b !== undefined) return unresolved("conflict");
  if (
    lastJoin === undefined ||
    (holding.presence.status === "left" &&
      (holding.presence.runtime !== lastJoin.presence.runtime ||
        holding.presence.session !== lastJoin.presence.session))
  ) {
    return unresolved("unattributable");
  }
  if (
    owner !== undefined &&
    owner !== one.receipt.installation &&
    owner !== two.receipt.installation
  ) {
    return unresolved("unattributable");
  }
  if (vacancy?.noFiles) return unresolved("missing");
  // Identify where the old owner could read, not where the historical join was made.
  // Only the two independently captured and verified source inventories participate.
  const source =
    owner === undefined
      ? a === undefined
        ? two
        : one
      : owner === one.receipt.installation
        ? one
        : two;
  const current = source === one ? a : b;
  const elsewhere = source === one ? b : a;
  if (current === undefined) return unresolved(elsewhere !== undefined ? "stale" : "missing");
  if (current.status === "unreadable") return unresolved("unreadable");
  if (current.record.address !== address) return unresolved("unattributable");
  if (current.record.cursor > one.receipt.cut.head) return unresolved("ahead");
  return {
    version: 1,
    kind: "start",
    operation,
    address,
    run,
    origin: "import",
    position: current.record.cursor,
    ...(owner === undefined || holding.presence.status === "left"
      ? {
          legacySource: {
            cut,
            presenceRef,
            installationRef: mailboxInstallationRef(source.receipt.installation),
          },
        }
      : {}),
  };
};

interface ImportRow {
  readonly address: string;
  readonly operation: string;
  readonly status:
    | "IMPORTED"
    | "CLASSIFIED"
    | "VERIFIED_IMPORT"
    | "VERIFIED_CLASSIFICATION"
    | "UNCHANGED";
  readonly position?: number;
  readonly reason?: MailboxUnresolved["reason"];
}

const presenceIndex = (entries: ReadonlyArray<Message>) => ({
  holdings: latestPresences(entries),
  owners: latestPresences(entries.filter(({ presence }) => presence?.status === "joined")),
});

const currentPresence = (ledger: Ledger["Service"], cut: Pin) =>
  Effect.gen(function* () {
    const current = yield* ledger.presenceAt();
    if (current.cut.incarnation !== cut.incarnation || current.cut.head < cut.head) {
      return yield* refused("the original ledger cut is no longer available.");
    }
    return current;
  });

const planMailboxImport = (
  ledgerName: string,
  copies: readonly [PairedCopy, PairedCopy],
  localInstallation: string
) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const [a, b] = copies;
    const cut = a.receipt.cut;
    if (
      a.receipt.installation === b.receipt.installation ||
      a.receipt.ledger !== ledgerName ||
      b.receipt.ledger !== ledgerName ||
      (a.receipt.installation !== localInstallation &&
        b.receipt.installation !== localInstallation) ||
      !sameCut(cut, b.receipt.cut) ||
      cut.incarnation !== ledger.instance
    ) {
      return yield* refused(
        "two distinct installations, the configured ledger, and the same captured cut are required."
      );
    }
    const read = yield* ledger.presenceAt(cut.head);
    if (!sameCut(read.cut, cut))
      return yield* refused("the original presence cut could not be established.");
    const verify = (copy: PairedCopy) =>
      Effect.gen(function* () {
        if ((yield* loadInstallation(copy.root)) !== copy.receipt.installation) {
          return yield* refused("a copied installation does not match its retained receipt.");
        }
        const { digest, files } = yield* cursorImportSnapshot(
          yield* legacyCursorPath(copy.root, ledgerName, cut.incarnation)
        );
        if (digest !== copy.receipt.digest) {
          return yield* refused(
            "a copied cursor inventory does not match the captured generation; nothing was imported."
          );
        }
        return { receipt: copy.receipt, files };
      });
    const verified = yield* Effect.all([verify(a), verify(b)]);
    const [one, two] =
      a.receipt.installation < b.receipt.installation ? verified : [verified[1], verified[0]];
    const { holdings, owners } = presenceIndex(read.entries);
    const planned = [...holdings.values()]
      .sort((left, right) =>
        left.address < right.address ? -1 : left.address > right.address ? 1 : 0
      )
      .map((holding) => {
        const owner = owners.get(holding.address);
        const record = decide(holding, owner, one, two);
        return { holding, owner, record };
      });
    return { cut, planned };
  });

const sameHolding = (
  now: ReturnType<typeof presenceIndex>,
  holding: Subscriber,
  owner: Subscriber | undefined
) =>
  isDeepStrictEqual(holding, now.holdings.get(holding.address)) &&
  isDeepStrictEqual(owner, now.owners.get(holding.address));

/** Only quiesced, verified snapshots are considered; no startup or serving path imports. */
export const importMailboxPositions = (
  ledgerName: string,
  copies: readonly [PairedCopy, PairedCopy],
  localInstallation: string,
  confirmHeld: Effect.Effect<void, LedgerError>
) =>
  Effect.gen(function* () {
    yield* confirmHeld;
    const ledger = yield* Ledger;
    const { cut, planned } = yield* planMailboxImport(ledgerName, copies, localInstallation);
    yield* currentPresence(ledger, cut);
    yield* confirmHeld;
    const rows: Array<ImportRow> = [];
    for (const { holding, owner, record } of planned) {
      const { address, operation } = record;
      const now = yield* currentPresence(ledger, cut);
      const current = now.cut;
      const witness = yield* ledger.mailboxReceiptAt(address, operation, current);
      const recorded =
        record.kind === "start" ? { position: record.position } : { reason: record.reason };
      if (witness.status === "FOUND") {
        if (!mailboxIntentMatches(record, witness.record)) {
          return yield* refused(
            `operation ${operation} has another intent; keep both old writers held.`
          );
        }
        rows.push({
          address,
          operation,
          ...recorded,
          status: record.kind === "start" ? "VERIFIED_IMPORT" : "VERIFIED_CLASSIFICATION",
        });
        continue;
      }
      if (witness.status !== "ABSENT") {
        return yield* refused(
          `operation ${operation} is not confirmed; resume with the same two captures and both old writers held.`
        );
      }
      const existing = yield* ledger.mailboxAt(address, current);
      if (existing.status !== "ABSENT") {
        rows.push({ address, operation, status: "UNCHANGED" });
        continue;
      }
      // The files belong to the captured holding. A later import or writer-era
      // marker may advance the ledger without changing that holding.
      const relevant = now.entries.filter((entry) => entry.from === address);
      if (!sameHolding(presenceIndex(relevant), holding, owner)) {
        return yield* refused(
          `the holding for ${address} changed after capture; keep both old writers held.`
        );
      }
      yield* confirmHeld;
      const result = yield* record.kind === "start"
        ? ledger.importMailbox(record, current)
        : ledger.classifyMailboxImport(record, current);
      if (result.status !== "APPLIED") {
        return yield* refused(
          `operation ${operation} returned ${result.status}; preserve both captures and keep both old writers held.`
        );
      }
      rows.push({
        address,
        operation,
        ...recorded,
        status: record.kind === "start" ? "IMPORTED" : "CLASSIFIED",
      });
    }
    return { cut, rows };
  });

type VerifiedImportRow = {
  readonly address: string;
  readonly operation: string;
  readonly latestStatus: Subscriber["presence"]["status"];
  readonly latestPresenceId: string;
  readonly lastJoinId: string | null;
  readonly legacyAccess?:
    | "manual-on-source"
    | "return-on-source"
    | "vacant-no-files"
    | "fresh-claimant-only";
  readonly sourceInstallationRef?: string;
} & (
  | { readonly status: "VERIFIED_IMPORT"; readonly position: number }
  | { readonly status: "VERIFIED_CLASSIFICATION"; readonly reason: MailboxUnresolved["reason"] }
);

export interface MailboxImportProof {
  readonly cut: Pin;
  readonly verifiedAt: Pin;
  readonly rows: ReadonlyArray<VerifiedImportRow>;
}

/** Read-only paired release evidence at one cut. A historical import alone cannot verify a current mailbox. */
export const verifyMailboxImport = (
  ledgerName: string,
  copies: readonly [PairedCopy, PairedCopy],
  localInstallation: string
) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const { cut, planned } = yield* planMailboxImport(ledgerName, copies, localInstallation);
    const { cut: verifiedAt, entries } = yield* currentPresence(ledger, cut);
    const now = presenceIndex(entries);
    if (planned.length !== now.holdings.size) {
      return yield* refused("the set of holdings changed after capture.");
    }
    const rows: Array<VerifiedImportRow> = [];
    for (const { holding, owner, record } of planned) {
      const { address, operation } = record;
      if (!sameHolding(now, holding, owner)) {
        return yield* refused(`the holding for ${address} changed after capture.`);
      }
      // mailboxAt validates the marker, sole pointer and its named receipt together.
      const state = yield* ledger.mailboxAt(address, verifiedAt);
      if (
        state.status === "ABSENT" ||
        state.current.t <= cut.head ||
        state.current.t > verifiedAt.head ||
        state.current.record.previous !== null ||
        !mailboxIntentMatches(record, state.current.record)
      ) {
        return yield* refused(`no exact current receipt for ${address} at the verification cut.`);
      }
      const identity = {
        address,
        operation,
        latestStatus: holding.presence.status,
        latestPresenceId: holding.joinId,
        lastJoinId: owner?.joinId ?? null,
      };
      if (
        record.kind === "start" &&
        state.status === "FOUND" &&
        state.position === record.position &&
        state.position <= cut.head
      ) {
        rows.push({
          ...identity,
          status: "VERIFIED_IMPORT",
          position: state.position,
          ...(record.legacySource === undefined
            ? {}
            : {
                legacyAccess:
                  holding.presence.status === "joined"
                    ? ("manual-on-source" as const)
                    : ("return-on-source" as const),
                sourceInstallationRef: record.legacySource.installationRef,
              }),
        });
      } else if (
        record.kind === "unresolved" &&
        state.status === "UNRESOLVED" &&
        state.reason === record.reason
      ) {
        rows.push({
          ...identity,
          status: "VERIFIED_CLASSIFICATION",
          reason: state.reason,
          ...(record.vacant === undefined
            ? {}
            : {
                legacyAccess: record.vacant.noFiles
                  ? ("vacant-no-files" as const)
                  : ("fresh-claimant-only" as const),
              }),
        });
      } else {
        return yield* refused(`incorrect current position or classification for ${address}.`);
      }
    }
    return { cut, verifiedAt, rows } satisfies MailboxImportProof;
  });
