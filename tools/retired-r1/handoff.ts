// Build only inside the pinned R1 predecessor tree. Never part of the normal CLI bundle.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { cursorWriterIsStopped } from "../../src/cursor-quiescence.ts";
import { LedgerError } from "../../src/domain.ts";
import { layerFluree } from "../../src/Fluree.ts";
import { loadInstallation } from "../../src/installation.ts";
import { Ledger } from "../../src/Ledger.ts";
import {
  assertMailboxTransitionAdmitted,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  MAILBOX_TRANSITION_START_PERMIT_FILE,
} from "../../src/mailbox-transition-admission.ts";
import { verifyMailboxTransitionGuard } from "../../src/mailbox-transition-guard.ts";
import { QueryGateway } from "../../src/Query.ts";

const bindingName = ".serve-binding-v1";
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
const pack = (value: unknown) => JSON.stringify(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const abort = (message: string): never => {
  throw new Error(message);
};
const refuse = () => new LedgerError({ message: "R1 witnesses or held history do not match." });
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Installation = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
);
const Commit = Schema.String.check(Schema.isPattern(/^b[a-z2-7]+$/), Schema.isMaxLength(4096));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Pin = Schema.Struct({ head: Positive, commit: Commit });
const Witness = Schema.Struct({
  installation: Installation,
  url: NonEmpty,
  digest: Digest,
  capturedAt: Positive,
  sentinel: Digest,
  admitted: Digest,
  permit: Digest,
});
const Plan = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    ledger: NonEmpty,
    incarnation: Commit,
    operation: Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    ),
    source: Pin,
    imported: Pin,
    anchor: Pin,
    installations: Schema.Tuple([Witness, Witness]),
  })
);
const Config = Schema.fromJsonString(
  Schema.Struct({ fluree: Schema.Struct({ url: NonEmpty, ledger: NonEmpty }) })
);
type Plan = typeof Plan.Type;
type Witness = typeof Witness.Type;
const decodePlan = Schema.decodeUnknownSync(Plan, { onExcessProperty: "error" });
const decodeConfig = Schema.decodeUnknownSync(Config);

// Each operator and package executes on a private, controlled root. Never follow a link,
// block on a special file, read an unbounded witness or include its contents in an error.
const evidence = async (path: string, limit: number, privateFile = true) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > limit ||
      (privateFile && ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()))
    ) {
      return abort("Unsafe evidence file.");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const { bytesRead } = await file.read(bytes, n, bytes.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    const after = await lstat(path);
    const text = bytes.subarray(0, n).toString("utf8");
    if (
      !after.isFile() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      n !== before.size ||
      !bytes.subarray(0, n).equals(Buffer.from(text, "utf8"))
    ) {
      return abort("Evidence changed during read.");
    }
    return text;
  } finally {
    await file.close();
  }
};
const existingBinding = async (root: string) => {
  const path = join(root, bindingName);
  try {
    return await evidence(path, 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return abort("Existing serving binding cannot be read safely.");
  }
};
const syncDir = async (root: string) => {
  const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
};
const publishBinding = async (root: string, bytes: string) => {
  const prior = await existingBinding(root);
  if (prior !== undefined) {
    if (prior !== bytes) return abort("Existing serving binding conflicts; it was not replaced.");
    await syncDir(root);
    return;
  }
  const stage = join(root, `${bindingName}.${randomUUID()}.tmp`);
  const file = await open(stage, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(stage, join(root, bindingName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await existingBinding(root)) !== bytes) {
      return abort("Existing serving binding conflicts; it was not replaced.");
    }
    await syncDir(root);
  } finally {
    await unlink(stage);
  }
};

const held = () => {
  if (
    process.platform !== "darwin" ||
    !cursorWriterIsStopped(
      process.env.AGENT_BUS_LABEL,
      process.getuid?.(),
      process.env.AGENT_BUS_PORT,
      (command, args, capture) => {
        const result = Bun.spawnSync([command, ...args], {
          env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          stdout: capture === "stderr" ? "ignore" : "pipe",
          stderr: capture === "stdout" ? "ignore" : "pipe",
          timeout: 10_000,
        });
        return {
          status: result.exitCode,
          text: (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? ""),
        };
      }
    )
  )
    return abort("The exact local serve job is not confirmed held.");
};
const binding = (plan: Plan, item: Witness) =>
  pack({
    version: 1,
    installation: item.installation,
    url: item.url,
    ledger: plan.ledger,
    incarnation: plan.incarnation,
    era: plan.source.head + 1,
    anchor: { head: plan.anchor.head, commit: plan.anchor.commit },
  });
const checked = (planDigest: string, plan: Plan, item: Witness) =>
  pack({
    version: 1,
    plan: planDigest,
    installation: item.installation,
    binding: hash(binding(plan, item)),
  });

const verify = async (root: string, plan: Plan, local: Witness) => {
  const marker = join(
    root,
    "fluree-cursors",
    encodeURIComponent(plan.ledger),
    `${plan.incarnation}.v2`,
    ".export-pending"
  );
  const configPath = join(root, "config.json");
  const tokenPath = join(root, "fluree-token");
  const configText = await evidence(configPath, 4096, false);
  const tokenText = await evidence(tokenPath, 8192);
  const { fluree } = decodeConfig(configText);
  const url = new URL(fluree.url);
  if (
    url.origin !== fluree.url ||
    !["http:", "https:"].includes(url.protocol) ||
    fluree.url !== local.url ||
    fluree.ledger !== plan.ledger ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tokenText.trim())
  ) {
    return abort("The configured store or credential is not the approved target.");
  }
  const verifyLocalFiles = async () => {
    held();
    for (const [path, expected] of [
      [marker, local.sentinel],
      [join(root, MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE), local.admitted],
      [join(root, MAILBOX_TRANSITION_START_PERMIT_FILE), local.permit],
    ] as const) {
      if (hash(await evidence(path, 1024 * 1024)) !== expected)
        return abort("A retained R1 witness does not match its independent digest.");
    }
    if (
      (await evidence(configPath, 4096, false)) !== configText ||
      (await evidence(tokenPath, 8192)) !== tokenText ||
      (await Effect.runPromise(loadInstallation(root).pipe(Effect.provide(platform)))) !==
        local.installation
    ) {
      return abort("The configured installation or credential changed.");
    }
  };
  await verifyLocalFiles();
  await Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const query = yield* QueryGateway;
      const pin = yield* query.pin;
      if (
        pin.head !== plan.anchor.head ||
        pin.incarnation !== plan.incarnation ||
        ledger.instance !== plan.incarnation
      )
        return yield* refuse();
      yield* assertMailboxTransitionAdmitted(
        {
          busDir: root,
          ledgerName: plan.ledger,
          incarnation: plan.incarnation,
          localInstallation: local.installation,
        },
        (admitted) =>
          Effect.gen(function* () {
            if (
              admitted.operation !== plan.operation ||
              admitted.sourceCommit !== plan.source.commit ||
              admitted.verifiedAt.head !== plan.imported.head ||
              admitted.verifiedAt.incarnation !== plan.incarnation ||
              admitted.verifiedCommit !== plan.imported.commit ||
              admitted.sources.some((source, i) => {
                const expected = plan.installations[i]!;
                return (
                  source.installation !== expected.installation ||
                  source.ledger !== plan.ledger ||
                  source.cut.head !== plan.source.head ||
                  source.cut.incarnation !== plan.incarnation ||
                  source.digest !== expected.digest ||
                  source.capturedAt !== expected.capturedAt
                );
              })
            )
              return yield* refuse();
            yield* verifyMailboxTransitionGuard(
              root,
              plan.ledger,
              admitted.sources,
              local.installation,
              plan.operation
            );
            const activation = yield* ledger.ownershipActivationAt({
              source: admitted.sources[0].cut,
              operation: plan.operation,
            });
            if (
              activation.sourceCommit !== plan.source.commit ||
              (yield* ledger.sourceCommitAt(admitted.verifiedAt)) !== plan.imported.commit
            ) {
              return yield* refuse();
            }
          })
      );
      if (
        (yield* ledger.ownershipEraAt(pin)) !== plan.source.head + 1 ||
        (yield* ledger.sourceCommitAt(pin)) !== plan.anchor.commit
      )
        return yield* refuse();
      const after = yield* query.pin;
      if (
        after.head !== pin.head ||
        after.incarnation !== pin.incarnation ||
        (yield* ledger.sourceCommitAt(after)) !== plan.anchor.commit
      )
        return yield* refuse();
    }).pipe(
      Effect.provide(layerFluree({ ...fluree, token: tokenText.trim() }, { existingOnly: true })),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provide(platform)
    )
  );
  await verifyLocalFiles();
};

const main = async () => {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      plan: { type: "string" },
      "expect-plan": { type: "string" },
      installation: { type: "string" },
      "peer-checked": { type: "string" },
      "expect-peer-checked": { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !["check", "publish"].includes(positionals[0] ?? "") ||
    values.plan === undefined ||
    values["expect-plan"] === undefined ||
    values.installation === undefined ||
    (positionals[0] === "publish"
      ? values["peer-checked"] === undefined || values["expect-peer-checked"] === undefined
      : values["peer-checked"] !== undefined || values["expect-peer-checked"] !== undefined)
  ) {
    return abort(
      "Usage: check|publish --plan PRIVATE_FILE --expect-plan SHA256 --installation UUID [publish: --peer-checked PRIVATE_FILE --expect-peer-checked SHA256]. Set AGENT_BUS_DIR, AGENT_BUS_LABEL and AGENT_BUS_PORT to the verified held job."
    );
  }
  const root = process.env.AGENT_BUS_DIR;
  if (
    root === undefined ||
    !root.startsWith("/") ||
    resolve(root) !== root ||
    (await realpath(root)) !== root ||
    !(await lstat(root)).isDirectory()
  )
    return abort("Unsafe state root.");
  const planBytes = await evidence(values.plan, 16_384);
  const planDigest = hash(planBytes);
  if (planDigest !== values["expect-plan"]) return abort("Independent plan digest does not match.");
  const plan = decodePlan(planBytes);
  const [a, b] = plan.installations;
  const local =
    a.installation === values.installation
      ? a
      : b.installation === values.installation
        ? b
        : undefined;
  const peer = local === a ? b : a;
  if (
    a.installation >= b.installation ||
    local === undefined ||
    plan.source.head + 1 > plan.imported.head ||
    plan.imported.head > plan.anchor.head
  )
    return abort("The approved cut or installation pair is invalid.");
  const expected = binding(plan, local);
  const prior = await existingBinding(root);
  if (prior !== undefined && prior !== expected)
    return abort("Existing serving binding conflicts.");
  const peerPath = values["peer-checked"];
  const checkPeer = async () => {
    if (peerPath === undefined) return abort("Peer check evidence is required.");
    const bytes = await evidence(peerPath, 4096);
    if (
      hash(bytes) !== values["expect-peer-checked"] ||
      bytes !== `${checked(planDigest, plan, peer)}\n`
    )
      return abort("Peer check does not match the approved plan.");
  };
  if (positionals[0] === "publish") await checkPeer();
  await verify(root, plan, local);
  if (positionals[0] === "check") {
    console.log(checked(planDigest, plan, local));
  } else {
    await checkPeer();
    held();
    await publishBinding(root, expected);
    console.log("serve-binding-v1");
  }
};

try {
  await main();
} catch {
  // Provider, schema and filesystem causes may contain private configuration or evidence.
  console.error("R1 handoff refused. Preserve the evidence and keep both original jobs held.");
  process.exitCode = 1;
}
