import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { cursorFileName } from "./Cursors.ts";
import { type CursorImportFile, cursorImportSnapshot } from "./cursor-layout.ts";
import { LedgerError, latestPresences, runOf } from "./domain.ts";
import { loadInstallation } from "./installation.ts";
import { Ledger } from "./Ledger.ts";
import {
  type MailboxStart,
  type MailboxUnresolved,
  mailboxIntentMatches,
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

interface PairedCopy {
  readonly root: string;
  readonly receipt: MailboxSource;
}

const refused = (message: string) => new LedgerError({ message: `Mailbox import: ${message}` });
const sameCut = (one: Pin, two: Pin) =>
  one.incarnation === two.incarnation && one.head === two.head;

export const legacyCursorPath = (root: string, ledger: string, incarnation: string) =>
  join(root, "fluree-cursors", encodeURIComponent(ledger), encodeURIComponent(incarnation));

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
    const { digest } = yield* cursorImportSnapshot(
      legacyCursorPath(root, ledgerName, cut.incarnation)
    );
    yield* confirmHeld;
    const confirmed = yield* cursorImportSnapshot(
      legacyCursorPath(root, ledgerName, cut.incarnation)
    );
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
  address: string,
  run: string,
  owner: string | undefined,
  one: { readonly receipt: MailboxSource; readonly files: ReadonlyMap<string, CursorImportFile> },
  two: { readonly receipt: MailboxSource; readonly files: ReadonlyMap<string, CursorImportFile> }
): MailboxStart | MailboxUnresolved => {
  const name = cursorFileName(address);
  const a = one.files.get(name);
  const b = two.files.get(name);
  const operation = operationFor(address, one.receipt, two.receipt);
  const unresolved = (reason: MailboxUnresolved["reason"]): MailboxUnresolved => ({
    version: 1,
    kind: "unresolved",
    operation,
    address,
    reason,
  });
  if (a !== undefined && b !== undefined) return unresolved("conflict");
  if (owner !== one.receipt.installation && owner !== two.receipt.installation) {
    return unresolved("unattributable");
  }
  const current = owner === one.receipt.installation ? a : b;
  const elsewhere = owner === one.receipt.installation ? b : a;
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
    const currentCut = Effect.gen(function* () {
      const current = (yield* ledger.presenceAt()).cut;
      if (current.incarnation !== cut.incarnation || current.head < cut.head) {
        return yield* refused("the original ledger cut is no longer available.");
      }
      return current;
    });
    yield* currentCut;
    const read = yield* ledger.presenceAt(cut.head);
    if (!sameCut(read.cut, cut))
      return yield* refused("the original presence cut could not be established.");
    const verify = (copy: PairedCopy) =>
      Effect.gen(function* () {
        if ((yield* loadInstallation(copy.root)) !== copy.receipt.installation) {
          return yield* refused("a copied installation does not match its retained receipt.");
        }
        const { digest, files } = yield* cursorImportSnapshot(
          legacyCursorPath(copy.root, ledgerName, cut.incarnation)
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
    const owners = latestPresences(
      read.entries.filter(({ presence }) => presence?.status === "joined")
    );
    const holdings = latestPresences(read.entries);
    const planned = [...holdings.values()]
      .sort((left, right) =>
        left.address < right.address ? -1 : left.address > right.address ? 1 : 0
      )
      .map((holding) => {
        const owner = owners.get(holding.address);
        return decide(
          holding.address,
          runOf(owner ?? holding),
          owner?.presence.installation,
          one,
          two
        );
      });
    yield* confirmHeld;
    const rows: Array<ImportRow> = [];
    for (const record of planned) {
      const { address, operation } = record;
      const current = yield* currentCut;
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
      yield* confirmHeld;
      const result = yield* record.kind === "start"
        ? ledger.importMailbox(record, cut)
        : ledger.classifyMailboxImport(record, cut);
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
