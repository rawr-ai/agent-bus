import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { LedgerError } from "./domain.ts";
import type { MailboxSource } from "./mailbox-import.ts";
import type { Pin } from "./Query.ts";

// One fixed R1 operation occupies each installation's root, outside either cursor tree.
export const MAILBOX_TRANSITION_READY_FILE = ".mailbox-transition-ready-r1";
export const MAILBOX_TRANSITION_READY_COMPLETE_FILE = ".mailbox-transition-ready-complete-r1";
export const MAILBOX_TRANSITION_ADMITTED_FILE = ".mailbox-transition-admitted-r1";
export const MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE = ".mailbox-transition-admitted-complete-r1";
export const MAILBOX_TRANSITION_START_PERMIT_FILE = ".mailbox-transition-start-permit-r1";
export const MAILBOX_TRANSITION_EVIDENCE_FILES = [
  MAILBOX_TRANSITION_READY_FILE,
  MAILBOX_TRANSITION_READY_COMPLETE_FILE,
  MAILBOX_TRANSITION_ADMITTED_FILE,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_START_PERMIT_FILE,
] as const;
const maxEvidenceBytes = 1024 * 1024;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
// The native provider proves this exact identifier; do not guess its CID grammar here.
const SourceCommit = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Installation = Schema.String.check(Schema.isPattern(uuidV4));
const Operation = Schema.String.check(Schema.isPattern(uuidV7));
const Digest = Schema.String.check(Schema.isPattern(digest));
const Cut = Schema.Struct({
  incarnation: NonEmpty,
  head: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const Source = Schema.Struct({
  version: Schema.Literal(1),
  ledger: NonEmpty,
  installation: Installation,
  cut: Cut,
  capturedAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffffffffffff })),
  digest: Digest,
});
const Sources = Schema.Tuple([Source, Source]);
const Ready = Schema.Struct({
  version: Schema.Literal(1),
  operation: Operation,
  sourceCommit: SourceCommit,
  sources: Sources,
  cut: Cut,
  verifiedAt: Cut,
  proofDigest: Digest,
  installation: Installation,
});
const Admitted = Schema.Struct({
  version: Schema.Literal(1),
  attestations: Schema.Tuple([Ready, Ready]),
});
const ReadyComplete = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ready-complete"),
  ready: Ready,
});
const AdmittedComplete = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("admitted-complete"),
  installation: Installation,
  admitted: Admitted,
});
const StartPermit = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("start-permit"),
  installation: Installation,
  peer: AdmittedComplete,
});
const ReadyJson = Schema.fromJsonString(Ready);
const AdmittedJson = Schema.fromJsonString(Admitted);
const ReadyCompleteJson = Schema.fromJsonString(ReadyComplete);
const AdmittedCompleteJson = Schema.fromJsonString(AdmittedComplete);
const StartPermitJson = Schema.fromJsonString(StartPermit);
const ProofSummary = Schema.Struct({
  cut: Cut,
  verifiedAt: Cut,
  rows: Schema.Array(Schema.Struct({ address: Schema.String })),
});

type Ready = typeof Ready.Type;
type Admitted = typeof Admitted.Type;
type AdmittedComplete = typeof AdmittedComplete.Type;
type StartPermit = typeof StartPermit.Type;

export interface MailboxTransitionBinding {
  readonly operation: string;
  readonly sourceCommit: string;
  readonly sources: readonly [MailboxSource, MailboxSource];
  readonly localInstallation: string;
}

export interface MailboxTransitionInput extends MailboxTransitionBinding {
  readonly busDir: string;
  readonly proof: {
    readonly cut: Pin;
    readonly verifiedAt: Pin;
    readonly rows: ReadonlyArray<{ readonly address: string }>;
  };
}

export interface MailboxTransitionChecks {
  readonly confirmLocalHeld: () => Effect.Effect<void, LedgerError, FileSystem.FileSystem>;
  readonly verifyLocalFence: (
    binding: MailboxTransitionBinding
  ) => Effect.Effect<void, LedgerError, FileSystem.FileSystem>;
}

export interface MailboxTransitionServeInput {
  readonly busDir: string;
  readonly ledgerName: string;
  readonly incarnation: string;
  readonly localInstallation: string;
}

const refused = () =>
  new LedgerError({
    message:
      "Mailbox transition admission evidence is missing, invalid, or changed; keep the old writer stopped.",
  });

const sameCut = (a: Pin, b: Pin) => a.incarnation === b.incarnation && a.head === b.head;
const canonicalCut = (cut: Pin) => ({ incarnation: cut.incarnation, head: cut.head });
const canonicalSource = (source: MailboxSource) => ({
  version: source.version,
  ledger: source.ledger,
  installation: source.installation,
  cut: canonicalCut(source.cut),
  capturedAt: source.capturedAt,
  digest: source.digest,
});
const canonicalReady = (ready: Ready): Ready => ({
  version: 1,
  operation: ready.operation,
  sourceCommit: ready.sourceCommit,
  sources: [canonicalSource(ready.sources[0]), canonicalSource(ready.sources[1])],
  cut: canonicalCut(ready.cut),
  verifiedAt: canonicalCut(ready.verifiedAt),
  proofDigest: ready.proofDigest,
  installation: ready.installation,
});
const readyBytes = (ready: Ready) => JSON.stringify(canonicalReady(ready));
const canonicalAdmitted = (admitted: Admitted): Admitted => ({
  version: 1,
  attestations: [
    canonicalReady(admitted.attestations[0]),
    canonicalReady(admitted.attestations[1]),
  ],
});
const admittedBytes = (admitted: Admitted) => JSON.stringify(canonicalAdmitted(admitted));
const readyCompleteBytes = (ready: Ready) =>
  JSON.stringify({ version: 1, kind: "ready-complete", ready: canonicalReady(ready) });
const canonicalAdmittedComplete = (completion: AdmittedComplete): AdmittedComplete => ({
  version: 1,
  kind: "admitted-complete",
  installation: completion.installation,
  admitted: canonicalAdmitted(completion.admitted),
});
const admittedCompleteBytes = (admitted: Admitted, installation: string) =>
  JSON.stringify(
    canonicalAdmittedComplete({ version: 1, kind: "admitted-complete", installation, admitted })
  );
const permitBytes = (permit: StartPermit) =>
  JSON.stringify({
    version: 1,
    kind: "start-permit",
    installation: permit.installation,
    peer: canonicalAdmittedComplete(permit.peer),
  });

const validateReady = (ready: Ready) => {
  const [one, two] = ready.sources;
  return (
    one.installation < two.installation &&
    one.ledger === two.ledger &&
    sameCut(one.cut, two.cut) &&
    sameCut(one.cut, ready.cut) &&
    ready.verifiedAt.incarnation === ready.cut.incarnation &&
    ready.verifiedAt.head > ready.cut.head &&
    (ready.installation === one.installation || ready.installation === two.installation)
  );
};

const validatePair = (admitted: Admitted) => {
  const [one, two] = admitted.attestations;
  return (
    validateReady(one) &&
    validateReady(two) &&
    one.installation === one.sources[0].installation &&
    two.installation === one.sources[1].installation &&
    readyBytes({ ...one, installation: two.installation }) === readyBytes(two)
  );
};

const validateAdmittedComplete = (completion: AdmittedComplete) =>
  validatePair(completion.admitted) &&
  completion.admitted.attestations.some(
    (attestation) => attestation.installation === completion.installation
  );

const decodeReady = (bytes: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) return yield* refused();
    const ready = yield* Schema.decodeUnknownEffect(ReadyJson, { onExcessProperty: "error" })(
      bytes
    ).pipe(Effect.mapError(refused));
    if (!validateReady(ready) || readyBytes(ready) !== bytes) return yield* refused();
    return canonicalReady(ready);
  });

const decodeAdmitted = (bytes: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) return yield* refused();
    const admitted = yield* Schema.decodeUnknownEffect(AdmittedJson, { onExcessProperty: "error" })(
      bytes
    ).pipe(Effect.mapError(refused));
    if (!validatePair(admitted) || admittedBytes(admitted) !== bytes) return yield* refused();
    return admitted;
  });

const decodeReadyComplete = (bytes: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) return yield* refused();
    const completion = yield* Schema.decodeUnknownEffect(ReadyCompleteJson, {
      onExcessProperty: "error",
    })(bytes).pipe(Effect.mapError(refused));
    if (!validateReady(completion.ready) || readyCompleteBytes(completion.ready) !== bytes) {
      return yield* refused();
    }
    return canonicalReady(completion.ready);
  });

const decodeAdmittedComplete = (bytes: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) return yield* refused();
    const completion = yield* Schema.decodeUnknownEffect(AdmittedCompleteJson, {
      onExcessProperty: "error",
    })(bytes).pipe(Effect.mapError(refused));
    if (
      !validateAdmittedComplete(completion) ||
      admittedCompleteBytes(completion.admitted, completion.installation) !== bytes
    ) {
      return yield* refused();
    }
    return canonicalAdmittedComplete(completion);
  });

const decodeStartPermit = (bytes: string) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) return yield* refused();
    const permit = yield* Schema.decodeUnknownEffect(StartPermitJson, {
      onExcessProperty: "error",
    })(bytes).pipe(Effect.mapError(refused));
    if (!validateAdmittedComplete(permit.peer) || permitBytes(permit) !== bytes) {
      return yield* refused();
    }
    return permit;
  });

const isAlreadyExists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";
const isNotFound = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

// O_NOFOLLOW applies to the evidence file itself; busDir is an existing trusted installation root.
const readRegular = async (busDir: string, name: string) => {
  if (!(await lstat(busDir)).isDirectory()) throw new Error();
  const file = await open(
    join(busDir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxEvidenceBytes) throw new Error();
    const bytes = await file.readFile();
    if (bytes.byteLength > maxEvidenceBytes) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
};

const readEvidence = (busDir: string, name: string) =>
  Effect.tryPromise({ try: () => readRegular(busDir, name), catch: refused });

// A completion without its exact candidate is damaged evidence, not a retry.
const checkCompletion = (
  busDir: string,
  candidate: string,
  completion: string,
  candidateBytes: string,
  completionBytes: string
) =>
  Effect.tryPromise({
    try: async () => {
      try {
        await lstat(join(busDir, completion));
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      if (
        (await readRegular(busDir, completion)) !== completionBytes ||
        (await readRegular(busDir, candidate)) !== candidateBytes
      )
        throw new Error();
    },
    catch: refused,
  });

// Link a complete private file into place. Never replace an occupied destination.
const publish = (busDir: string, name: string, bytes: string) =>
  Effect.tryPromise({
    try: async () => {
      if (Buffer.byteLength(bytes, "utf8") > maxEvidenceBytes) throw new Error();
      if (!(await lstat(busDir)).isDirectory()) throw new Error();
      const temporary = join(busDir, `.mailbox-transition-${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        try {
          await file.chmod(0o600);
          await file.writeFile(bytes, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, join(busDir, name));
        } catch (error) {
          if (!isAlreadyExists(error) || (await readRegular(busDir, name)) !== bytes) throw error;
        }
      } finally {
        await unlink(temporary);
      }
    },
    catch: refused,
  });

const bindingFor = (ready: Ready, localInstallation: string): MailboxTransitionBinding => ({
  operation: ready.operation,
  sourceCommit: ready.sourceCommit,
  sources: ready.sources,
  localInstallation,
});

const checkHeld = (checks: MailboxTransitionChecks, binding: MailboxTransitionBinding) =>
  Effect.gen(function* () {
    yield* checks.confirmLocalHeld().pipe(Effect.mapError(refused));
    yield* checks.verifyLocalFence(binding).pipe(Effect.mapError(refused));
  });

const expectedReady = (input: MailboxTransitionInput) =>
  Effect.gen(function* () {
    const sources = yield* Schema.decodeUnknownEffect(Sources, { onExcessProperty: "error" })(
      input.sources
    ).pipe(Effect.mapError(refused));
    const summary = yield* Schema.decodeUnknownEffect(ProofSummary)(input.proof).pipe(
      Effect.mapError(refused)
    );
    yield* Schema.decodeUnknownEffect(Schema.Json)(input.proof).pipe(Effect.mapError(refused));
    for (let i = 1; i < summary.rows.length; i++) {
      const previous = summary.rows[i - 1];
      const current = summary.rows[i];
      if (previous === undefined || current === undefined || previous.address >= current.address) {
        return yield* refused();
      }
    }
    const json = yield* Effect.try({ try: () => JSON.stringify(input.proof), catch: refused });
    if (json === undefined) return yield* refused();
    const candidate = yield* Schema.decodeUnknownEffect(Ready, { onExcessProperty: "error" })({
      version: 1,
      operation: input.operation,
      sourceCommit: input.sourceCommit,
      sources,
      cut: summary.cut,
      verifiedAt: summary.verifiedAt,
      proofDigest: createHash("sha256").update(json).digest("hex"),
      installation: input.localInstallation,
    }).pipe(Effect.mapError(refused));
    if (!validateReady(candidate)) return yield* refused();
    return canonicalReady(candidate);
  });

/**
 * The verifier must produce identical, host-independent JSON on both installations,
 * including the same K and strictly address-ordered rows. The full JSON is hashed.
 * A completion record follows the candidate's postcheck; a crash or failed check
 * leaves the candidate unusable. Local evidence is not an authenticated remote fence
 * or a power-loss durability claim.
 */
export const recordMailboxTransitionReady = (
  input: MailboxTransitionInput,
  checks: MailboxTransitionChecks
): Effect.Effect<string, LedgerError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const ready = yield* expectedReady(input);
    const binding = bindingFor(ready, input.localInstallation);
    const bytes = readyBytes(ready);
    const completion = readyCompleteBytes(ready);
    yield* checkHeld(checks, binding);
    yield* checkCompletion(
      input.busDir,
      MAILBOX_TRANSITION_READY_FILE,
      MAILBOX_TRANSITION_READY_COMPLETE_FILE,
      bytes,
      completion
    );
    yield* publish(input.busDir, MAILBOX_TRANSITION_READY_FILE, bytes);
    yield* checkHeld(checks, binding);
    if ((yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_FILE)) !== bytes) {
      return yield* refused();
    }
    yield* publish(input.busDir, MAILBOX_TRANSITION_READY_COMPLETE_FILE, completion);
    if (
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_FILE)) !== bytes ||
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_COMPLETE_FILE)) !== completion
    )
      return yield* refused();
    return completion;
  });

/** The transferred peer document is operator-attested, not proof that the peer remains stopped. */
export const acceptMailboxTransitionPeer = (
  input: MailboxTransitionInput,
  peerReadyBytes: string,
  checks: MailboxTransitionChecks
): Effect.Effect<void, LedgerError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const expected = yield* expectedReady(input);
    const binding = bindingFor(expected, input.localInstallation);
    yield* checkHeld(checks, binding);
    const localBytes = yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_FILE);
    const localCompletion = yield* readEvidence(
      input.busDir,
      MAILBOX_TRANSITION_READY_COMPLETE_FILE
    );
    const local = yield* decodeReady(localBytes);
    yield* decodeReadyComplete(localCompletion);
    const peer = yield* decodeReadyComplete(peerReadyBytes);
    if (localBytes !== readyBytes(expected) || localCompletion !== readyCompleteBytes(local))
      return yield* refused();
    const attestations: [Ready, Ready] =
      local.installation === local.sources[0].installation ? [local, peer] : [peer, local];
    const admitted: Admitted = { version: 1, attestations };
    if (!validatePair(admitted)) return yield* refused();
    const bytes = admittedBytes(admitted);
    const completion = admittedCompleteBytes(admitted, input.localInstallation);
    yield* checkCompletion(
      input.busDir,
      MAILBOX_TRANSITION_ADMITTED_FILE,
      MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
      bytes,
      completion
    );
    yield* publish(input.busDir, MAILBOX_TRANSITION_ADMITTED_FILE, bytes);
    yield* checkHeld(checks, binding);
    if (
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_FILE)) !== localBytes ||
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_COMPLETE_FILE)) !==
        localCompletion ||
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_ADMITTED_FILE)) !== bytes
    )
      return yield* refused();
    yield* publish(input.busDir, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE, completion);
    if (
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_ADMITTED_FILE)) !== bytes ||
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE)) !== completion
    )
      return yield* refused();
  });

const readLocalAdmission = (input: MailboxTransitionServeInput) =>
  Effect.gen(function* () {
    const candidate = yield* readEvidence(input.busDir, MAILBOX_TRANSITION_ADMITTED_FILE);
    const completion = yield* readEvidence(input.busDir, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE);
    const admitted = yield* decodeAdmitted(candidate);
    yield* decodeAdmittedComplete(completion);
    if (completion !== admittedCompleteBytes(admitted, input.localInstallation))
      return yield* refused();
    const [one, two] = admitted.attestations;
    const local = one.installation === input.localInstallation ? one : two;
    if (
      local.installation !== input.localInstallation ||
      local.sources[0].ledger !== input.ledgerName ||
      local.cut.incarnation !== input.incarnation
    )
      return yield* refused();
    const bytes = yield* readEvidence(input.busDir, MAILBOX_TRANSITION_READY_FILE);
    const readyCompletion = yield* readEvidence(
      input.busDir,
      MAILBOX_TRANSITION_READY_COMPLETE_FILE
    );
    yield* decodeReady(bytes);
    yield* decodeReadyComplete(readyCompletion);
    if (bytes !== readyBytes(local) || readyCompletion !== readyCompleteBytes(local))
      return yield* refused();
    return {
      admitted,
      binding: bindingFor(local, input.localInstallation),
      candidate,
      completion,
      bytes,
      readyCompletion,
    };
  });

type LocalAdmission = Effect.Success<ReturnType<typeof readLocalAdmission>>;
const sameLocalAdmission = (a: LocalAdmission, b: LocalAdmission) =>
  a.candidate === b.candidate &&
  a.completion === b.completion &&
  a.bytes === b.bytes &&
  a.readyCompletion === b.readyCompletion;

const peerMatches = (local: LocalAdmission, peer: AdmittedComplete) => {
  const [one, two] = local.admitted.attestations;
  const other =
    local.binding.localInstallation === one.installation ? two.installation : one.installation;
  return (
    peer.installation === other && admittedBytes(peer.admitted) === admittedBytes(local.admitted)
  );
};

/**
 * The peer completion is operator-attested, not proof that the peer remains stopped.
 * Both installations must have completed admission before either is permitted to start.
 * Once admitted, a later permit does not repeat the verifier or require head K.
 */
export const permitMailboxTransitionServe = (
  input: MailboxTransitionServeInput,
  peerAdmittedCompletionBytes: string,
  checks: MailboxTransitionChecks
): Effect.Effect<void, LedgerError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const local = yield* readLocalAdmission(input);
    yield* checkHeld(checks, local.binding);
    const peer = yield* decodeAdmittedComplete(peerAdmittedCompletionBytes);
    if (!peerMatches(local, peer)) return yield* refused();
    if (!sameLocalAdmission(local, yield* readLocalAdmission(input))) return yield* refused();
    yield* checkHeld(checks, local.binding);
    if (!sameLocalAdmission(local, yield* readLocalAdmission(input))) return yield* refused();
    const bytes = permitBytes({
      version: 1,
      kind: "start-permit",
      installation: input.localInstallation,
      peer,
    });
    yield* publish(input.busDir, MAILBOX_TRANSITION_START_PERMIT_FILE, bytes);
    if (
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_START_PERMIT_FILE)) !== bytes ||
      !sameLocalAdmission(local, yield* readLocalAdmission(input))
    )
      return yield* refused();
  });

/** Use for an existing legacy installation after loading its identity and ledger incarnation. */
export const assertMailboxTransitionAdmitted = (
  input: MailboxTransitionServeInput,
  verifyLocalFence: MailboxTransitionChecks["verifyLocalFence"]
): Effect.Effect<void, LedgerError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const local = yield* readLocalAdmission(input);
    const bytes = yield* readEvidence(input.busDir, MAILBOX_TRANSITION_START_PERMIT_FILE);
    const permit = yield* decodeStartPermit(bytes);
    if (permit.installation !== input.localInstallation || !peerMatches(local, permit.peer)) {
      return yield* refused();
    }
    yield* verifyLocalFence(local.binding).pipe(Effect.mapError(refused));
    if (
      (yield* readEvidence(input.busDir, MAILBOX_TRANSITION_START_PERMIT_FILE)) !== bytes ||
      !sameLocalAdmission(local, yield* readLocalAdmission(input))
    )
      return yield* refused();
  });
