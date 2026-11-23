import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { LedgerError } from "../src/domain.ts";
import type { MailboxSource } from "../src/mailbox-import.ts";
import {
  acceptMailboxTransitionPeer,
  assertMailboxTransitionAdmitted,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_ADMITTED_FILE,
  MAILBOX_TRANSITION_EVIDENCE_FILES,
  MAILBOX_TRANSITION_READY_COMPLETE_FILE,
  MAILBOX_TRANSITION_READY_FILE,
  MAILBOX_TRANSITION_START_PERMIT_FILE,
  type MailboxTransitionBinding,
  type MailboxTransitionChecks,
  type MailboxTransitionInput,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "../src/mailbox-transition-admission.ts";

const one = "00000000-0000-4000-8000-000000000001";
const two = "00000000-0000-4000-8000-000000000002";
const third = "00000000-0000-4000-8000-000000000003";
const operation = "00000000-0000-7000-8000-000000000001";
const otherOperation = "00000000-0000-7000-8000-000000000002";
const sourceCommit = "fluree:commit:independently-retained-source";
const otherSourceCommit = "fluree:commit:foreign-source";
const cut = { incarnation: "ledger-instance", head: 14 };
const verifiedAt = { incarnation: "ledger-instance", head: 17 };
const sources: readonly [MailboxSource, MailboxSource] = [
  {
    version: 1,
    ledger: "team:main",
    installation: one,
    cut,
    capturedAt: 1,
    digest: "a".repeat(64),
  },
  {
    version: 1,
    ledger: "team:main",
    installation: two,
    cut,
    capturedAt: 2,
    digest: "b".repeat(64),
  },
];
const proof = {
  cut,
  verifiedAt,
  rows: [
    {
      address: "alpha",
      latestPresenceId: "p1",
      lastJoinId: "j1",
      latestStatus: "joined",
      operation,
      status: "VERIFIED_IMPORT",
      position: 4,
    },
    {
      address: "beta",
      latestPresenceId: "p2",
      lastJoinId: null,
      latestStatus: "left",
      operation: otherOperation,
      status: "VERIFIED_CLASSIFICATION",
      reason: "missing",
    },
  ],
};
const error = () => new LedgerError({ message: "private simulated failure" });
const checks: MailboxTransitionChecks = {
  confirmLocalHeld: () => Effect.void,
  verifyLocalFence: () => Effect.void,
};
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-admission-"));
  const roots = [join(root, "one"), join(root, "two")] as const;
  for (const dir of roots) mkdirSync(dir);
  const input = (index: 0 | 1): MailboxTransitionInput => ({
    busDir: roots[index],
    operation,
    sourceCommit,
    sources,
    localInstallation: index === 0 ? one : two,
    proof,
  });
  const context = (
    index: 0 | 1,
    overrides: Partial<{ ledgerName: string; incarnation: string; localInstallation: string }> = {}
  ) => ({
    busDir: roots[index],
    ledgerName: "team:main",
    incarnation: cut.incarnation,
    localInstallation: index === 0 ? one : two,
    ...overrides,
  });
  const serve = (
    index: 0 | 1,
    overrides: Partial<{ ledgerName: string; incarnation: string; localInstallation: string }> = {}
  ) => assertMailboxTransitionAdmitted(context(index, overrides), checks.verifyLocalFence);
  const ready = (index: 0 | 1, suppliedChecks = checks) =>
    run(recordMailboxTransitionReady(input(index), suppliedChecks));
  const admit = (index: 0 | 1, peer: string, suppliedChecks = checks) =>
    run(acceptMailboxTransitionPeer(input(index), peer, suppliedChecks));
  const admitted = (index: 0 | 1) =>
    readFileSync(join(roots[index], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE), "utf8");
  const permit = (index: 0 | 1, peer: string, suppliedChecks = checks) =>
    run(permitMailboxTransitionServe(context(index), peer, suppliedChecks));
  return {
    roots,
    input,
    context,
    serve,
    ready,
    admit,
    admitted,
    permit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("both independent installations require complete matching readiness and admission", async () => {
  const f = fixture();
  try {
    await expect(run(f.serve(0))).rejects.toThrow();
    await expect(f.admit(0, "")).rejects.toThrow();
    const readyOne = await f.ready(0);
    await expect(run(f.serve(0))).rejects.toThrow();
    await expect(f.admit(0, "")).rejects.toThrow();
    await expect(f.admit(0, readyOne)).rejects.toThrow();
    const readyTwo = await f.ready(1);
    await expect(run(f.serve(0))).rejects.toThrow();
    const digest = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
    expect(readyOne).toContain(`"proofDigest":"${digest}"`);
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE), "utf8")).toBe(
      readyOne
    );
    expect(readyOne).toContain('"kind":"ready-complete"');
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE), "utf8")).not.toBe(
      readyOne
    );
    await f.admit(0, readyTwo);
    await expect(run(f.serve(0))).rejects.toThrow();
    await expect(run(f.serve(1))).rejects.toThrow();
    await f.admit(1, readyOne);
    await f.permit(0, f.admitted(1));
    await f.permit(1, f.admitted(0));
    await run(f.serve(0));
    await run(f.serve(1));
    for (const root of f.roots) {
      for (const file of MAILBOX_TRANSITION_EVIDENCE_FILES) {
        expect(lstatSync(join(root, file)).mode & 0o777).toBe(0o600);
      }
    }
    let observed: MailboxTransitionBinding | undefined;
    await run(
      assertMailboxTransitionAdmitted(
        {
          busDir: f.roots[0],
          ledgerName: "team:main",
          incarnation: cut.incarnation,
          localInstallation: one,
        },
        (binding) =>
          Effect.sync(() => {
            observed = binding;
          })
      )
    );
    expect(observed).toEqual({ operation, sourceCommit, sources, localInstallation: one });
    // Serve does not query or compare a current head; ordinary traffic may advance it beyond K.
    const restartedAtHead = {
      busDir: f.roots[0],
      ledgerName: "team:main",
      incarnation: cut.incarnation,
      localInstallation: one,
      currentHead: 100,
    };
    await run(assertMailboxTransitionAdmitted(restartedAtHead, checks.verifyLocalFence));
  } finally {
    f.cleanup();
  }
});

test("invalid source pair, proof bounds, row ordering, operation and identity never create evidence", async () => {
  const f = fixture();
  try {
    const base = f.input(0);
    const bad: ReadonlyArray<MailboxTransitionInput> = [
      { ...base, operation: "not-a-v7" },
      { ...base, sourceCommit: "" },
      { ...base, sourceCommit: "x".repeat(4097) },
      { ...base, localInstallation: third },
      { ...base, sources: [sources[1], sources[0]] },
      { ...base, sources: [sources[0], sources[0]] },
      { ...base, sources: [sources[0], { ...sources[1], ledger: "other" }] },
      { ...base, sources: [sources[0], { ...sources[1], cut: { ...cut, head: 13 } }] },
      { ...base, proof: { ...proof, cut: { ...cut, head: 13 } } },
      { ...base, proof: { ...proof, verifiedAt: { ...verifiedAt, head: 13 } } },
      { ...base, proof: { ...proof, verifiedAt: cut, rows: [] } },
      { ...base, proof: { ...proof, verifiedAt: { ...verifiedAt, incarnation: "replaced" } } },
      { ...base, proof: { ...proof, rows: [proof.rows[1]!, proof.rows[0]!] } },
      { ...base, proof: { ...proof, rows: [proof.rows[0]!, proof.rows[0]!] } },
    ];
    for (const input of bad)
      await expect(run(recordMailboxTransitionReady(input, checks))).rejects.toThrow();
    for (const file of MAILBOX_TRANSITION_EVIDENCE_FILES)
      expect(existsSync(join(f.roots[0], file))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("peer and local attestations are strict, ordered, complete and bound to identical full proof", async () => {
  const variants = [
    "operation",
    "receipt",
    "proof",
    "verifiedAt",
    "cut",
    "identity",
    "source-commit",
    "source-missing",
    "candidate",
    "wrong-kind",
    "extra",
    "nested-extra",
    "partial",
    "noncanonical",
  ] as const;
  for (const variant of variants) {
    const f = fixture();
    try {
      const local = await f.ready(0);
      let peerInput = f.input(1);
      if (variant === "operation") peerInput = { ...peerInput, operation: otherOperation };
      if (variant === "source-commit")
        peerInput = { ...peerInput, sourceCommit: otherSourceCommit };
      if (variant === "receipt")
        peerInput = { ...peerInput, sources: [sources[0], { ...sources[1], capturedAt: 3 }] };
      if (variant === "proof") {
        const changedProof = {
          ...proof,
          rows: [{ ...proof.rows[0]!, position: 5 }, proof.rows[1]!],
        };
        peerInput = {
          ...peerInput,
          proof: changedProof,
        };
      }
      if (variant === "verifiedAt")
        peerInput = { ...peerInput, proof: { ...proof, verifiedAt: { ...verifiedAt, head: 18 } } };
      if (variant === "cut") {
        const changed = { ...cut, head: 13 };
        peerInput = {
          ...peerInput,
          sources: [
            { ...sources[0], cut: changed },
            { ...sources[1], cut: changed },
          ],
          proof: { ...proof, cut: changed },
        };
      }
      let peer = await run(recordMailboxTransitionReady(peerInput, checks));
      if (variant === "identity") peer = local;
      if (variant === "source-missing")
        peer = peer.replace(`"sourceCommit":"${sourceCommit}",`, "");
      if (variant === "candidate")
        peer = readFileSync(join(f.roots[1], MAILBOX_TRANSITION_READY_FILE), "utf8");
      if (variant === "wrong-kind")
        peer = peer.replace('"kind":"ready-complete"', '"kind":"admitted-complete"');
      if (variant === "extra")
        peer = peer.replace('{"version":1', '{"extra":"private","version":1');
      if (variant === "nested-extra")
        peer = peer.replace('"ready":{"version":1', '"ready":{"extra":true,"version":1');
      if (variant === "partial") peer = peer.slice(0, -1);
      if (variant === "noncanonical") peer = `${peer}\n`;
      await expect(f.admit(0, peer)).rejects.toThrow();
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE))).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

test("serve rejects wrong context, missing or changed files, and a failed sentinel", async () => {
  const f = fixture();
  try {
    const local = await f.ready(0);
    const peer = await f.ready(1);
    await f.admit(0, peer);
    await f.admit(1, local);
    await f.permit(0, f.admitted(1));
    await f.permit(1, f.admitted(0));
    await expect(run(f.serve(0, { ledgerName: "other" }))).rejects.toThrow();
    await expect(run(f.serve(0, { incarnation: "replaced" }))).rejects.toThrow();
    await expect(run(f.serve(0, { localInstallation: two }))).rejects.toThrow();
    await expect(run(f.serve(0, { localInstallation: third }))).rejects.toThrow();
    await expect(
      run(
        assertMailboxTransitionAdmitted(
          {
            busDir: f.roots[0],
            ledgerName: "team:main",
            incarnation: cut.incarnation,
            localInstallation: one,
          },
          () => Effect.fail(error())
        )
      )
    ).rejects.toThrow();
    const path = join(f.roots[0], MAILBOX_TRANSITION_READY_FILE);
    writeFileSync(path, `${local} `);
    await expect(run(f.serve(0))).rejects.toThrow();
  } finally {
    f.cleanup();
  }
});

test("failed postchecks preserve candidates but never authorize admission or serve", async () => {
  for (const failed of ["hold", "fence"] as const) {
    const f = fixture();
    try {
      let calls = 0;
      const failPost: MailboxTransitionChecks = {
        confirmLocalHeld: () =>
          Effect.suspend(() =>
            failed === "hold" && ++calls === 2 ? Effect.fail(error()) : Effect.void
          ),
        verifyLocalFence: () =>
          Effect.suspend(() =>
            failed === "fence" && ++calls === 2 ? Effect.fail(error()) : Effect.void
          ),
      };
      await expect(f.ready(0, failPost)).rejects.toThrow();
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE))).toBe(true);
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE))).toBe(false);
      const peer = await f.ready(1);
      await expect(f.admit(0, peer)).rejects.toThrow();
      await expect(run(f.serve(0))).rejects.toThrow();
      const local = await f.ready(0);
      calls = 0;
      await expect(f.admit(0, peer, failPost)).rejects.toThrow();
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE))).toBe(true);
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE))).toBe(false);
      await expect(run(f.serve(0))).rejects.toThrow();
      await f.admit(0, peer);
      await f.admit(1, local);
      await f.permit(0, f.admitted(1));
      await run(f.serve(0));
    } finally {
      f.cleanup();
    }
  }
});

test("a peer candidate copied after a failed postcheck is not transferable ready evidence", async () => {
  const f = fixture();
  try {
    const local = await f.ready(0);
    let heldChecks = 0;
    const lostHold: MailboxTransitionChecks = {
      confirmLocalHeld: () =>
        Effect.suspend(() => (++heldChecks === 2 ? Effect.fail(error()) : Effect.void)),
      verifyLocalFence: checks.verifyLocalFence,
    };
    await expect(f.ready(1, lostHold)).rejects.toThrow();
    const candidate = readFileSync(join(f.roots[1], MAILBOX_TRANSITION_READY_FILE), "utf8");
    expect(existsSync(join(f.roots[1], MAILBOX_TRANSITION_READY_COMPLETE_FILE))).toBe(false);
    await expect(f.admit(0, candidate)).rejects.toThrow();
    expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE))).toBe(false);
    await expect(run(f.serve(0))).rejects.toThrow();

    const completion = await f.ready(1);
    expect(completion).not.toBe(candidate);
    expect(completion).toContain('"kind":"ready-complete"');
    expect(readFileSync(join(f.roots[1], MAILBOX_TRANSITION_READY_FILE), "utf8")).toBe(candidate);
    expect(await f.ready(1)).toBe(completion);
    await f.admit(0, completion);
    await expect(run(f.serve(0))).rejects.toThrow();
    await f.admit(1, local);
    await f.permit(0, f.admitted(1));
    await run(f.serve(0));
  } finally {
    f.cleanup();
  }
});

test("both admissions precede either start; the second permit survives head advance", async () => {
  const f = fixture();
  try {
    const firstReady = await f.ready(0);
    const secondReady = await f.ready(1);
    await f.admit(0, secondReady);
    await expect(run(f.serve(0))).rejects.toThrow();
    await expect(f.permit(0, f.admitted(0))).rejects.toThrow();
    expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE))).toBe(false);

    let calls = 0;
    const losePeerHold: MailboxTransitionChecks = {
      confirmLocalHeld: () =>
        Effect.suspend(() => (++calls === 2 ? Effect.fail(error()) : Effect.void)),
      verifyLocalFence: checks.verifyLocalFence,
    };
    await expect(f.admit(1, firstReady, losePeerHold)).rejects.toThrow();
    const incomplete = readFileSync(join(f.roots[1], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8");
    await expect(f.permit(0, incomplete)).rejects.toThrow();
    expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE))).toBe(false);

    await f.admit(1, firstReady);
    const firstAdmission = f.admitted(0);
    const secondAdmission = f.admitted(1);
    expect(firstAdmission).not.toBe(secondAdmission);
    await f.permit(0, secondAdmission);
    await run(f.serve(0));

    // Only the loaded incarnation is consulted here, even after ordinary mailbox traffic advances head.
    const afterFirstStarts = { ...f.context(1), currentHead: verifiedAt.head + 20 };
    await run(permitMailboxTransitionServe(afterFirstStarts, firstAdmission, checks));
    await run(assertMailboxTransitionAdmitted(afterFirstStarts, checks.verifyLocalFence));
  } finally {
    f.cleanup();
  }
});

test("the externally retained H commit binds ready, admit, permit and serve", async () => {
  const f = fixture();
  try {
    const firstReady = await f.ready(0);
    const secondReady = await f.ready(1);
    expect(firstReady).toContain(`"sourceCommit":"${sourceCommit}"`);
    expect(secondReady).toContain(`"sourceCommit":"${sourceCommit}"`);
    const conflicting = { ...f.input(0), sourceCommit: otherSourceCommit };
    await expect(
      run(acceptMailboxTransitionPeer(conflicting, secondReady, checks))
    ).rejects.toThrow();
    expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE))).toBe(false);
    await f.admit(0, secondReady);
    await f.admit(1, firstReady);
    expect(f.admitted(0)).toContain(`"sourceCommit":"${sourceCommit}"`);
    expect(f.admitted(1)).toContain(`"sourceCommit":"${sourceCommit}"`);

    let expected = otherSourceCommit;
    const anchored: MailboxTransitionChecks = {
      confirmLocalHeld: checks.confirmLocalHeld,
      verifyLocalFence: (binding) =>
        binding.sourceCommit === expected ? Effect.void : Effect.fail(error()),
    };
    await expect(f.permit(0, f.admitted(1), anchored)).rejects.toThrow();
    expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE))).toBe(false);
    expected = sourceCommit;
    await f.permit(0, f.admitted(1), anchored);
    const permit = readFileSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE), "utf8");
    expect(permit).toContain(`"sourceCommit":"${sourceCommit}"`);
    await run(assertMailboxTransitionAdmitted(f.context(0), anchored.verifyLocalFence));
    // The caller compares the retained binding with the independently read native witness.
    expected = otherSourceCommit;
    await expect(
      run(assertMailboxTransitionAdmitted(f.context(0), anchored.verifyLocalFence))
    ).rejects.toThrow();

    const oldPermit = permit.replaceAll(`"sourceCommit":"${sourceCommit}",`, "");
    writeFileSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE), oldPermit);
    expected = sourceCommit;
    await expect(
      run(assertMailboxTransitionAdmitted(f.context(0), anchored.verifyLocalFence))
    ).rejects.toThrow();
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE), "utf8")).toBe(
      oldPermit
    );
  } finally {
    f.cleanup();
  }
});

test("start permit requires the other completed admission with identical pair, K and proof", async () => {
  const variants = [
    "missing",
    "own",
    "candidate",
    "wrong-identity",
    "wrong-k",
    "wrong-proof",
    "wrong-operation",
    "wrong-source",
    "old-missing-source",
    "extra",
    "partial",
    "noncanonical",
  ] as const;
  for (const variant of variants) {
    const f = fixture();
    try {
      const firstReady = await f.ready(0);
      const secondReady = await f.ready(1);
      await f.admit(0, secondReady);
      await f.admit(1, firstReady);
      const secondAdmission = f.admitted(1);
      const bytes =
        variant === "missing"
          ? ""
          : variant === "own"
            ? f.admitted(0)
            : variant === "candidate"
              ? readFileSync(join(f.roots[1], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8")
              : variant === "wrong-identity"
                ? secondAdmission.replace(`"installation":"${two}"`, `"installation":"${third}"`)
                : variant === "wrong-k"
                  ? secondAdmission.replaceAll(
                      `"head":${verifiedAt.head}`,
                      `"head":${verifiedAt.head + 1}`
                    )
                  : variant === "wrong-proof"
                    ? secondAdmission.replaceAll(
                        createHash("sha256").update(JSON.stringify(proof)).digest("hex"),
                        "f".repeat(64)
                      )
                    : variant === "wrong-operation"
                      ? secondAdmission.replaceAll(operation, otherOperation)
                      : variant === "wrong-source"
                        ? secondAdmission.replaceAll(sourceCommit, otherSourceCommit)
                        : variant === "old-missing-source"
                          ? secondAdmission.replaceAll(`"sourceCommit":"${sourceCommit}",`, "")
                          : variant === "extra"
                            ? secondAdmission.replace('{"version":1', '{"extra":true,"version":1')
                            : variant === "partial"
                              ? secondAdmission.slice(0, -1)
                              : `${secondAdmission}\n`;
      await expect(f.permit(0, bytes)).rejects.toThrow();
      await expect(run(f.serve(0))).rejects.toThrow();
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE))).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

test("failed prechecks, postchecks or lost local admission cannot publish a permit", async () => {
  for (const failed of [
    "hold-before",
    "hold-after",
    "fence-before",
    "fence-after",
    "local-loss",
  ] as const) {
    const f = fixture();
    try {
      const firstReady = await f.ready(0);
      const secondReady = await f.ready(1);
      await f.admit(0, secondReady);
      await f.admit(1, firstReady);
      let holds = 0;
      let fences = 0;
      const lost: MailboxTransitionChecks = {
        confirmLocalHeld: () =>
          Effect.suspend(() => {
            holds++;
            return (failed === "hold-before" && holds === 1) ||
              (failed === "hold-after" && holds === 2)
              ? Effect.fail(error())
              : Effect.void;
          }),
        verifyLocalFence: () =>
          Effect.suspend(() => {
            fences++;
            if (failed === "local-loss" && fences === 2) {
              unlinkSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE));
            }
            return (failed === "fence-before" && fences === 1) ||
              (failed === "fence-after" && fences === 2)
              ? Effect.fail(error())
              : Effect.void;
          }),
      };
      await expect(f.permit(0, f.admitted(1), lost)).rejects.toThrow();
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE))).toBe(false);
      await expect(run(f.serve(0))).rejects.toThrow();
      if (failed !== "local-loss") {
        await f.permit(0, f.admitted(1));
        await run(f.serve(0));
      }
    } finally {
      f.cleanup();
    }
  }
});

test("start permit publication is exclusive, retries exact bytes, and serve refuses tampering", async () => {
  for (const occupied of ["partial", "foreign", "symlink"] as const) {
    const f = fixture();
    try {
      const firstReady = await f.ready(0);
      const secondReady = await f.ready(1);
      await f.admit(0, secondReady);
      await f.admit(1, firstReady);
      const path = join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE);
      if (occupied === "symlink") symlinkSync(join(f.roots[1], "missing"), path);
      else writeFileSync(path, occupied === "partial" ? "{" : "foreign private content");
      const original = occupied === "symlink" ? "" : readFileSync(path, "utf8");
      await expect(f.permit(0, f.admitted(1))).rejects.toThrow();
      await expect(run(f.serve(0))).rejects.toThrow();
      if (occupied === "symlink") expect(lstatSync(path).isSymbolicLink()).toBe(true);
      else expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    const firstReady = await f.ready(0);
    const secondReady = await f.ready(1);
    await f.admit(0, secondReady);
    await f.admit(1, firstReady);
    await f.permit(0, f.admitted(1));
    const path = join(f.roots[0], MAILBOX_TRANSITION_START_PERMIT_FILE);
    const original = readFileSync(path, "utf8");
    await f.permit(0, f.admitted(1));
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    await run(f.serve(0));
    for (const changed of [
      original.replace(`"installation":"${one}"`, `"installation":"${two}"`),
      original.replace(`"installation":"${two}"`, `"installation":"${one}"`),
      original.replaceAll(`"head":${verifiedAt.head}`, `"head":${verifiedAt.head + 1}`),
      original.replace('{"version":1', '{"extra":true,"version":1'),
    ]) {
      expect(changed).not.toBe(original);
      writeFileSync(path, changed);
      await expect(run(f.serve(0))).rejects.toThrow();
    }
    writeFileSync(path, `${original}\n`);
    await expect(run(f.serve(0))).rejects.toThrow();
    await expect(f.permit(0, f.admitted(1))).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(`${original}\n`);
  } finally {
    f.cleanup();
  }
});

test("a bare, altered or partial completion cannot stand in for local completed evidence", async () => {
  for (const damaged of ["candidate", "mismatch", "partial", "extra"] as const) {
    const f = fixture();
    try {
      const completion = await f.ready(0);
      const peer = await f.ready(1);
      const path = join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE);
      const candidate = readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE), "utf8");
      const bytes =
        damaged === "candidate"
          ? candidate
          : damaged === "mismatch"
            ? completion.replace(operation, otherOperation)
            : damaged === "partial"
              ? completion.slice(0, -1)
              : completion.replace('{"version":1', '{"private":true,"version":1');
      writeFileSync(path, bytes);
      await expect(f.admit(0, peer)).rejects.toThrow();
      await expect(f.ready(0)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE), "utf8")).toBe(candidate);
      expect(existsSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE))).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

test("serve requires the canonical admitted completion matching its candidate", async () => {
  for (const damaged of ["candidate", "mismatch", "partial", "extra"] as const) {
    const f = fixture();
    try {
      const local = await f.ready(0);
      const peer = await f.ready(1);
      await f.admit(0, peer);
      await f.admit(1, local);
      await f.permit(0, f.admitted(1));
      const candidate = readFileSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8");
      const path = join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE);
      const completion = readFileSync(path, "utf8");
      const bytes =
        damaged === "candidate"
          ? candidate
          : damaged === "mismatch"
            ? completion.replace(operation, otherOperation)
            : damaged === "partial"
              ? completion.slice(0, -1)
              : completion.replace('{"version":1', '{"private":true,"version":1');
      writeFileSync(path, bytes);
      await expect(run(f.serve(0))).rejects.toThrow();
      await expect(f.admit(0, peer)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8")).toBe(
        candidate
      );
    } finally {
      f.cleanup();
    }
  }
});

test("exclusive retry accepts identical bytes and refuses occupied, corrupt or symlink evidence", async () => {
  for (const occupied of ["partial", "corrupt", "symlink", "foreign"] as const) {
    const f = fixture();
    try {
      const path = join(f.roots[0], MAILBOX_TRANSITION_READY_FILE);
      if (occupied === "symlink") symlinkSync(join(f.roots[1], "missing"), path);
      else
        writeFileSync(
          path,
          occupied === "partial"
            ? "{"
            : occupied === "corrupt"
              ? "not json"
              : "private foreign bytes"
        );
      const before = occupied === "symlink" ? "" : readFileSync(path, "utf8");
      await expect(f.ready(0)).rejects.toThrow();
      if (occupied === "symlink") expect(lstatSync(path).isSymbolicLink()).toBe(true);
      else expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    const local = await f.ready(0);
    expect(await f.ready(0)).toBe(local);
    const peer = await f.ready(1);
    await f.admit(0, peer);
    const admitted = readFileSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8");
    const admittedCompletion = readFileSync(
      join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
      "utf8"
    );
    const localCandidate = readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE), "utf8");
    expect(admittedCompletion).toContain('"kind":"admitted-complete"');
    expect(admittedCompletion).not.toBe(admitted);
    await f.admit(0, peer);
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_FILE), "utf8")).toBe(admitted);
    const conflict = { ...f.input(0), operation: otherOperation };
    await expect(run(recordMailboxTransitionReady(conflict, checks))).rejects.toThrow();
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_FILE), "utf8")).toBe(
      localCandidate
    );
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE), "utf8")).toBe(
      admittedCompletion
    );
  } finally {
    f.cleanup();
  }
});

test("orphaned or occupied completion and a replaced local ready stay untouched and fail closed", async () => {
  for (const stage of ["ready", "admitted"] as const) {
    for (const kind of ["partial", "symlink"] as const) {
      const f = fixture();
      try {
        const peer = stage === "admitted" ? await f.ready(1) : "";
        if (stage === "admitted") await f.ready(0);
        const candidate =
          stage === "ready" ? MAILBOX_TRANSITION_READY_FILE : MAILBOX_TRANSITION_ADMITTED_FILE;
        const completion =
          stage === "ready"
            ? MAILBOX_TRANSITION_READY_COMPLETE_FILE
            : MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE;
        const path = join(f.roots[0], completion);
        if (kind === "symlink") symlinkSync(join(f.roots[1], "missing"), path);
        else writeFileSync(path, "{");
        if (stage === "ready") await expect(f.ready(0)).rejects.toThrow();
        else await expect(f.admit(0, peer)).rejects.toThrow();
        expect(existsSync(join(f.roots[0], candidate))).toBe(false);
        if (kind === "symlink") expect(lstatSync(path).isSymbolicLink()).toBe(true);
        else expect(readFileSync(path, "utf8")).toBe("{");
        await expect(run(f.serve(0))).rejects.toThrow();
      } finally {
        f.cleanup();
      }
    }
  }
  const f = fixture();
  try {
    const local = await f.ready(0);
    const peer = await f.ready(1);
    const path = join(f.roots[0], MAILBOX_TRANSITION_READY_FILE);
    unlinkSync(path);
    symlinkSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE), path);
    await expect(f.admit(0, peer)).rejects.toThrow();
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE), "utf8")).toBe(
      local
    );
    unlinkSync(path);
    await expect(f.ready(0)).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(f.roots[0], MAILBOX_TRANSITION_READY_COMPLETE_FILE), "utf8")).toBe(
      local
    );
  } finally {
    f.cleanup();
  }
});
