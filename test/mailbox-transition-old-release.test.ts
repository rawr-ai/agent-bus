import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { cursorImportSnapshot } from "../src/cursor-layout.ts";
import { LedgerError } from "../src/domain.ts";
import { layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";
import {
  captureMailboxSource,
  importMailboxPositions,
  verifyMailboxImport,
} from "../src/mailbox-import.ts";
import {
  acceptMailboxTransitionPeer,
  MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE,
  type MailboxTransitionBinding,
  type MailboxTransitionChecks,
  permitMailboxTransitionServe,
  recordMailboxTransitionReady,
} from "../src/mailbox-transition-admission.ts";
import {
  installMailboxTransitionGuard,
  verifyMailboxTransitionGuard,
} from "../src/mailbox-transition-guard.ts";
import { QueryGateway } from "../src/Query.ts";
import { startFileFlureeServer } from "./fluree-file-server.ts";
import { insertRaw } from "./fluree-server.ts";
import { ownership } from "./processes.ts";
import { spawnSupervised } from "./supervised.ts";

// This exercises real processes and components on synthetic roots, not launchd or the operator CLI.
const release = process.env.AGENT_BUS_OLD_RELEASE;
const anchor = process.env.AGENT_BUS_OLD_RELEASE_SHA256;
const flureeAnchor = process.env.AGENT_BUS_FLUREE_SHA256;
const flureeVersion = process.env.AGENT_BUS_FLUREE_VERSION;
const candidateRoot = process.env.AGENT_BUS_CANDIDATE_RELEASE;
const candidateAnchor = process.env.AGENT_BUS_CANDIDATE_RELEASE_SHA256;
const candidateCommit = process.env.AGENT_BUS_CANDIDATE_COMMIT;
const candidateTree = process.env.AGENT_BUS_CANDIDATE_TREE;
const selected = [
  release,
  anchor,
  flureeAnchor,
  flureeVersion,
  candidateRoot,
  candidateAnchor,
  candidateCommit,
  candidateTree,
].some((value) => value !== undefined);
const qualify = selected ? test : test.skip;
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const messages = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const verifyFluree = (expected: string, version: string) => {
  expect(expected).toMatch(/^[0-9a-f]{64}$/);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const executable = Bun.which("fluree");
  if (executable === null) throw new Error("The selected Fluree executable is not on PATH.");
  expect(lstatSync(executable).isFile()).toBe(true);
  expect(sha256(readFileSync(executable))).toBe(expected);
  const result = Bun.spawnSync([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe(`fluree ${version}`);
  return executable;
};

const verifyArtifact = (
  root: string,
  expected: string,
  home: string,
  commit: string,
  tree?: string
) => {
  expect(isAbsolute(root)).toBe(true);
  expect(expected).toMatch(/^[0-9a-f]{64}$/);
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  if (tree !== undefined) expect(tree).toMatch(/^[0-9a-f]{40}$/);
  for (const dir of [root, join(root, "runtime"), join(root, "app")]) {
    expect(lstatSync(dir).isDirectory()).toBe(true);
  }
  const manifestPath = join(root, "manifest.json");
  expect(lstatSync(manifestPath).isFile()).toBe(true);
  const bytes = readFileSync(manifestPath);
  expect(sha256(bytes)).toBe(expected);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      commit: Schema.String,
      tree: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    })
  )(parsed);
  expect(manifest.commit).toBe(commit);
  if (tree !== undefined) expect(manifest.tree).toBe(tree);
  for (const name of ["runtime/bun", "app/bunfig.toml", "app/release.js", "app/cli.js"]) {
    const file = join(root, name);
    expect(lstatSync(file).isFile()).toBe(true);
    const entries = manifest.files.filter((entry) => entry.path === name);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("The release bootstrap entry is missing.");
    expect(sha256(readFileSync(file))).toBe(entry.sha256);
  }
  const result = Bun.spawnSync(
    [
      join(root, "runtime/bun"),
      "--no-env-file",
      `--config=${join(root, "app/bunfig.toml")}`,
      join(root, "app/release.js"),
      "verify",
      root,
      "--expect",
      expected,
    ],
    { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" }
  );
  expect(result.exitCode).toBe(0);
  const verdict: unknown = JSON.parse(result.stdout.toString());
  expect(Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean }))(verdict).ok).toBe(true);
};

const verifyWorkspace = (commit: string, tree: string, home: string) => {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dirname(import.meta.dir), ...args], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    if (result.exitCode !== 0)
      throw new Error("The candidate source identity could not be checked.");
    return result.stdout.toString().trim();
  };
  expect(git("rev-parse", "--verify", "HEAD^{commit}")).toBe(commit);
  expect(git("rev-parse", "--verify", "HEAD^{tree}")).toBe(tree);
  if (git("status", "--porcelain=v1", "--untracked-files=all") !== "") {
    throw new Error("The candidate source worktree is not clean.");
  }
};

const freePort = (allocated: Set<number>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (!allocated.has(port)) {
      allocated.add(port);
      return port;
    }
  }
  throw new Error("Could not allocate a distinct disposable port.");
};

const portIsFree = (port: number) => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

const directoryBytes = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      expect(entry.isFile()).toBe(true);
      return [entry.name, readFileSync(join(directory, entry.name)).toString("hex")] as const;
    });

const spawnServer = (
  command: ReadonlyArray<string>,
  runtimeDir: string,
  root: string,
  fixture: string,
  processes: ReturnType<typeof ownership>,
  allocated: Set<number>
) => {
  const port = freePort(allocated);
  const child = processes.supervisor(
    spawnSupervised([...command, "serve", "--codex", "/usr/bin/false"], {
      cwd: fixture,
      env: {
        HOME: root,
        PATH: `${runtimeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        AGENT_BUS_DIR: root,
        AGENT_BUS_PORT: String(port),
      },
      stdout: "ignore",
      stderr: "pipe",
    })
  );
  return { child, port, stderr: new Response(child.stderr).text() };
};

qualify(
  selected
    ? `the real released file writers transition to admitted ledger mailboxes (${candidateRoot === undefined ? "source" : "packaged"} candidate)`
    : "old-release transition qualification (set AGENT_BUS_OLD_RELEASE, AGENT_BUS_OLD_RELEASE_SHA256, AGENT_BUS_FLUREE_SHA256 and AGENT_BUS_FLUREE_VERSION)",
  async () => {
    if (
      release === undefined ||
      anchor === undefined ||
      flureeAnchor === undefined ||
      flureeVersion === undefined
    ) {
      throw new Error("Set all four old-release and selected-Fluree qualification variables.");
    }
    let candidatePackage:
      | {
          readonly root: string;
          readonly anchor: string;
          readonly commit: string;
          readonly tree: string;
        }
      | undefined;
    if (
      [candidateRoot, candidateAnchor, candidateCommit, candidateTree].some(
        (value) => value !== undefined
      )
    ) {
      if (
        candidateRoot === undefined ||
        candidateAnchor === undefined ||
        candidateCommit === undefined ||
        candidateTree === undefined
      ) {
        throw new Error(
          "Set all four candidate-release qualification variables, or omit all four."
        );
      }
      candidatePackage = {
        root: candidateRoot,
        anchor: candidateAnchor,
        commit: candidateCommit,
        tree: candidateTree,
      };
    }
    const fixture = mkdtempSync(join(tmpdir(), "agent-bus-old-transition-"));
    const processes = ownership();
    const allocated = new Set<number>();
    const oldChildren: Array<ReturnType<typeof spawnServer>> = [];
    const clients = new Set<Client>();
    let disposeRuntime: (() => Promise<void>) | undefined;
    let stopFluree: (() => Promise<void>) | undefined;
    try {
      verifyArtifact(release, anchor, fixture, "a18838d7483f8c377097bd7f00e42a98dc5b73d9");
      if (candidatePackage !== undefined) {
        verifyWorkspace(candidatePackage.commit, candidatePackage.tree, fixture);
        verifyArtifact(
          candidatePackage.root,
          candidatePackage.anchor,
          fixture,
          candidatePackage.commit,
          candidatePackage.tree
        );
      }
      const fluree = verifyFluree(flureeAnchor, flureeVersion);
      const provider = await startFileFlureeServer();
      stopFluree = () => provider.stop();
      const config = provider.freshLedger("old-transition");
      const roots = [join(fixture, "one"), join(fixture, "two")] as const;
      const identities = [randomUUID(), randomUUID()] as const;
      for (const [index, root] of roots.entries()) {
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(
          join(root, "config.json"),
          JSON.stringify({ fluree: { url: config.url, ledger: config.ledger } }),
          { mode: 0o600 }
        );
        writeFileSync(join(root, "fluree-token"), config.token, { mode: 0o600 });
        writeFileSync(join(root, "installation-id"), `${identities[index]}\n`, { mode: 0o600 });
      }
      const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
      let activeRuntime = ManagedRuntime.make(
        layerFluree(config, { existingOnly: true }).pipe(Layer.provideMerge(platform))
      );
      disposeRuntime = () => activeRuntime.dispose();
      const cutNow = () =>
        activeRuntime
          .runPromise(Effect.flatMap(Ledger, (ledger) => ledger.presenceAt()))
          .then((r) => r.cut);
      // Let the released writer create the ledger; candidate initialization would seed its
      // ownership era before the old presences exist and would not model an old installation.
      let incarnation = "";

      const spawn = (root: string) => {
        const server = spawnServer(
          [
            join(release, "runtime/bun"),
            "--no-env-file",
            `--config=${join(release, "app/bunfig.toml")}`,
            join(release, "app/cli.js"),
          ],
          dirname(join(release, "runtime/bun")),
          root,
          fixture,
          processes,
          allocated
        );
        oldChildren.push(server);
        return server;
      };
      const candidate = (root: string) => {
        const binary =
          candidatePackage === undefined
            ? process.execPath
            : join(candidatePackage.root, "runtime/bun");
        const command =
          candidatePackage === undefined
            ? [binary, "--no-env-file", join(import.meta.dir, "../src/bin.ts")]
            : [
                binary,
                "--no-env-file",
                `--config=${join(candidatePackage.root, "app/bunfig.toml")}`,
                join(candidatePackage.root, "app/cli.js"),
              ];
        return spawnServer(command, dirname(binary), root, fixture, processes, allocated);
      };
      const connect = async (server: ReturnType<typeof spawnServer>) => {
        for (let attempt = 0; attempt < 100 && server.child.exitCode === null; attempt++) {
          const client = new Client({ name: "old-transition-test", version: "1" });
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`))
            );
            clients.add(client);
            const result = await client.callTool({ name: "bus_queries", arguments: {} });
            expect(result.isError).not.toBe(true);
            const actual = object(result.structuredContent).ledger;
            if (typeof actual !== "string") throw new Error("The ledger identity is absent.");
            if (incarnation === "") incarnation = actual;
            expect(actual).toBe(incarnation);
            return client;
          } catch {
            clients.delete(client);
            await client.close().catch(() => {});
            await Bun.sleep(100);
          }
        }
        throw new Error("The verified old server did not start against the disposable ledger.");
      };
      const stop = async (server: ReturnType<typeof spawnServer>, client?: Client) => {
        if (client !== undefined) {
          clients.delete(client);
          await client.close();
        }
        if (server.child.exitCode === null) server.child.kill();
        await server.child.exited;
        expect(portIsFree(server.port)).toBe(true);
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        return object(result.structuredContent);
      };
      const one = spawn(roots[0]);
      const clientOne = await connect(one);
      const two = spawn(roots[1]);
      const clientTwo = await connect(two);
      expect((await cutNow()).incarnation).toBe(incarnation);
      const author = "fixture/old-transition-author";
      const readers = ["fixture/old-transition-one", "fixture/old-transition-two"] as const;
      const unresolved = "fixture/old-transition-unresolved";
      const session = (address: string) => `synthetic:${address}`;
      for (const [client, address] of [
        [clientOne, author],
        [clientOne, readers[0]],
        [clientOne, unresolved],
        [clientTwo, readers[1]],
      ] as const) {
        await call(client, "bus_join", {
          address,
          session: session(address),
          runtime: "other",
          cwd: fixture,
          topics: [],
        });
      }
      const send = async (to: string, body: string) => {
        const result = await call(clientOne, "bus_publish", {
          from: author,
          session: session(author),
          to: [to],
          body,
        });
        if (typeof result.id !== "string")
          throw new Error("The old publish returned no message id.");
        return result.id;
      };
      const acknowledged = await send(readers[0], "already read");
      const read = await call(clientOne, "bus_read", {
        address: readers[0],
        session: session(readers[0]),
      });
      expect(messages(read.messages).map((message) => message.id)).toEqual([acknowledged]);
      const unread = [
        await send(readers[0], "unread one"),
        await send(readers[1], "unread two"),
      ] as const;
      const unresolvedMail = await send(unresolved, "unread but position is damaged");
      expect(new Set([acknowledged, ...unread, unresolvedMail]).size).toBe(4);
      await stop(one, clientOne);
      await stop(two, clientTwo);

      const cut = await cutNow();
      expect(cut.incarnation).toBe(incarnation);
      const readCommit = async (head: number) => {
        const response = await fetch(
          `${config.url}/v1/fluree/show/${encodeURIComponent(config.ledger)}?commit=${encodeURIComponent(`t:${head}`)}`,
          { headers: { authorization: `Bearer ${config.token}` } }
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        const commit = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String.check(Schema.isMinLength(1)),
            t: Schema.Int,
            parents: Schema.optionalKey(Schema.Array(Schema.String)),
          })
        )(body);
        expect(commit.t).toBe(head);
        return commit;
      };
      const sourceCommit = (await readCommit(cut.head)).id;
      expect(
        await activeRuntime.runPromise(
          Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(cut))
        )
      ).toBe(sourceCommit);
      expect(await cutNow()).toEqual(cut);
      const oldEra = await activeRuntime.runPromise(
        Effect.flatMap(QueryGateway, (query) =>
          query.jsonld(cut.head, {
            select: ["?era"],
            where: { "@id": "urn:agent-bus:ownership-era", "bus:presenceEra": "?era" },
          })
        )
      );
      expect(oldEra).toEqual([]);
      // Damage only a disposable address's old-created cursor; this must not become position zero.
      const damaged = join(
        roots[0],
        "fluree-cursors",
        encodeURIComponent(config.ledger),
        `${incarnation}.v2`,
        `${sha256(Buffer.from(unresolved, "utf16le"))}.json`
      );
      const originalDamaged: unknown = JSON.parse(readFileSync(damaged, "utf8"));
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(originalDamaged).address
      ).toBe(unresolved);
      writeFileSync(damaged, "{}", { mode: 0o600 });
      const originals = roots.map((root, index) => {
        const reader = readers[index];
        if (reader === undefined) throw new Error("The disposable reader fixture is incomplete.");
        const parent = join(root, "fluree-cursors", encodeURIComponent(config.ledger));
        const generations = readdirSync(parent, { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.endsWith(".v2")
        );
        expect(generations.map((entry) => entry.name)).toEqual([`${incarnation}.v2`]);
        const exact = join(parent, generations[0]?.name ?? "missing");
        const filename = `${sha256(Buffer.from(reader, "utf16le"))}.json`;
        const position: unknown = JSON.parse(readFileSync(join(exact, filename), "utf8"));
        const decoded = Schema.decodeUnknownSync(
          Schema.Struct({ address: Schema.String, cursor: Schema.Number })
        )(position);
        expect(decoded.address).toBe(reader);
        expect(decoded.cursor).toBeLessThan(cut.head);
        return {
          exact,
          position: decoded.cursor,
          bytes: directoryBytes(exact),
          identity: readFileSync(join(root, "installation-id")),
        };
      });
      // A clean restart is the control for a marker-specific refusal below.
      for (const [index, root] of roots.entries()) {
        const clean = spawn(root);
        const client = await connect(clean);
        await stop(clean, client);
        const original = originals[index];
        if (original === undefined) throw new Error("The disposable cursor fixture is incomplete.");
        expect(directoryBytes(original.exact)).toEqual(original.bytes);
        expect(readFileSync(join(root, "installation-id"))).toEqual(original.identity);
      }
      expect(await cutNow()).toEqual(cut);
      const held = Effect.sync(() => {
        for (const server of oldChildren) {
          expect(server.child.exitCode).not.toBeNull();
          expect(portIsFree(server.port)).toBe(true);
        }
      });
      const first = await activeRuntime.runPromise(
        captureMailboxSource(roots[0], config.ledger, cut, held)
      );
      const second = await activeRuntime.runPromise(
        captureMailboxSource(roots[1], config.ledger, cut, held)
      );
      const sources = [first, second] as const;
      expect(sources.map((source) => source.installation)).toEqual([...identities]);
      const copiedRoots = [join(fixture, "copy-one"), join(fixture, "copy-two")] as const;
      for (const [index, root] of roots.entries()) {
        const copy = copiedRoots[index];
        if (copy === undefined) throw new Error("The disposable copy fixture is incomplete.");
        mkdirSync(copy, { mode: 0o700 });
        copyFileSync(join(root, "installation-id"), join(copy, "installation-id"));
        cpSync(join(root, "fluree-cursors"), join(copy, "fluree-cursors"), { recursive: true });
      }
      const copies = [
        { root: copiedRoots[0], receipt: first },
        { root: copiedRoots[1], receipt: second },
      ] as const;
      const operation = Bun.randomUUIDv7();
      const markers: string[] = [];
      for (const [index, root] of roots.entries()) {
        const source = sources[index];
        const original = originals[index];
        const installation = identities[index];
        if (source === undefined || original === undefined || installation === undefined) {
          throw new Error("The disposable installation fixture is incomplete.");
        }
        const sentinel = await activeRuntime.runPromise(
          installMailboxTransitionGuard(root, config.ledger, sources, installation, operation, held)
        );
        expect(
          await activeRuntime.runPromise(
            verifyMailboxTransitionGuard(root, config.ledger, sources, installation, operation)
          )
        ).toEqual(sentinel);
        const legacy = original.exact.slice(0, -3);
        expect(
          (
            await activeRuntime.runPromise(
              cursorImportSnapshot(legacy, { expectedSentinel: sentinel })
            )
          ).digest
        ).toBe(source.digest);
        expect(
          directoryBytes(original.exact).filter(([name]) => name !== ".export-pending")
        ).toEqual(original.bytes);
        markers.push(readFileSync(join(original.exact, ".export-pending")).toString("hex"));
        expect(readFileSync(join(root, "installation-id"))).toEqual(original.identity);
      }
      expect(await cutNow()).toEqual(cut);
      for (const [index, root] of roots.entries()) {
        const refused = spawn(root);
        const status = await Promise.race([
          refused.child.exited,
          Bun.sleep(10_000).then(() => {
            throw new Error("The old server did not refuse the sentinel.");
          }),
        ]);
        expect(status).not.toBe(0);
        expect(await refused.stderr).toMatch(/pending export.*not readable JSON/i);
        expect(portIsFree(refused.port)).toBe(true);
        const original = originals[index];
        if (original === undefined) throw new Error("The disposable cursor fixture is incomplete.");
        expect(
          directoryBytes(original.exact).filter(([name]) => name !== ".export-pending")
        ).toEqual(original.bytes);
        const marker = markers[index];
        const installation = identities[index];
        if (marker === undefined || installation === undefined) {
          throw new Error("The disposable marker fixture is incomplete.");
        }
        expect(readFileSync(join(original.exact, ".export-pending")).toString("hex")).toBe(marker);
        await activeRuntime.runPromise(
          verifyMailboxTransitionGuard(root, config.ledger, sources, installation, operation)
        );
        expect(readFileSync(join(root, "installation-id"))).toEqual(original.identity);
      }
      expect(await cutNow()).toEqual(cut);

      const rejectCandidate = async (root: string) => {
        const refused = candidate(root);
        const status = await Promise.race([
          refused.child.exited,
          Bun.sleep(10_000).then(() => {
            throw new Error("The candidate did not refuse incomplete admission.");
          }),
        ]);
        expect(status).not.toBe(0);
        expect(await refused.stderr).toMatch(/admission evidence is missing, invalid, or changed/i);
        expect(portIsFree(refused.port)).toBe(true);
      };
      await rejectCandidate(roots[0]);
      expect(await cutNow()).toEqual(cut);

      const guardedHeld = Effect.gen(function* () {
        yield* held;
        for (const [index, root] of roots.entries()) {
          const installation = identities[index];
          if (installation === undefined) throw new Error("Missing disposable installation.");
          yield* verifyMailboxTransitionGuard(
            root,
            config.ledger,
            sources,
            installation,
            operation
          );
        }
        yield* held;
      }).pipe(Effect.provide(BunFileSystem.layer));
      const eraIntent = { source: cut, commit: sourceCommit, operation };
      const activateEra = Effect.gen(function* () {
        yield* guardedHeld;
        const ledger = yield* Ledger;
        const result = yield* ledger.activateOwnershipEra(eraIntent);
        yield* guardedHeld;
        return result;
      });
      const activation = await activeRuntime.runPromise(activateEra);
      expect(activation.status).toBe("APPLIED");
      if (activation.status !== "APPLIED") throw new Error("The ownership era was not applied.");
      expect(activation.cut).toEqual({ incarnation, head: cut.head + 1 });
      const eraCommit = await readCommit(activation.cut.head);
      expect(eraCommit.id).toBe(activation.commit);
      expect(eraCommit.parents).toEqual([sourceCommit]);
      const repeated = await activeRuntime.runPromise(activateEra);
      expect(repeated.status).toBe("ALREADY_APPLIED");
      if (repeated.status !== "ALREADY_APPLIED") throw new Error("The era retry was not verified.");
      expect(repeated.cut).toEqual(activation.cut);
      expect(repeated.commit).toBe(activation.commit);
      expect(await cutNow()).toEqual(activation.cut);
      const imported = await activeRuntime.runPromise(
        importMailboxPositions(config.ledger, copies, identities[0], guardedHeld)
      );
      expect(imported.cut).toEqual(cut);
      const oneOriginal = originals[0];
      const twoOriginal = originals[1];
      if (oneOriginal === undefined || twoOriginal === undefined) {
        throw new Error("The disposable original cursor fixture is incomplete.");
      }
      const authorCursor: unknown = JSON.parse(
        readFileSync(
          join(oneOriginal.exact, `${sha256(Buffer.from(author, "utf16le"))}.json`),
          "utf8"
        )
      );
      const authorPosition = Schema.decodeUnknownSync(
        Schema.Struct({ address: Schema.String, cursor: Schema.Int })
      )(authorCursor);
      expect(authorPosition.address).toBe(author);
      const expectedAddresses = [author, ...readers, unresolved].sort();
      expect(imported.rows.map((row) => row.address)).toEqual(expectedAddresses);
      expect(imported.rows).toEqual(
        expect.arrayContaining([
          {
            address: author,
            operation: expect.any(String),
            status: "IMPORTED",
            position: authorPosition.cursor,
          },
          {
            address: readers[0],
            operation: expect.any(String),
            status: "IMPORTED",
            position: oneOriginal.position,
          },
          {
            address: readers[1],
            operation: expect.any(String),
            status: "IMPORTED",
            position: twoOriginal.position,
          },
          {
            address: unresolved,
            operation: expect.any(String),
            status: "CLASSIFIED",
            reason: "unreadable",
          },
        ])
      );
      const verify = (installation: string) =>
        Effect.gen(function* () {
          yield* guardedHeld;
          const proof = yield* verifyMailboxImport(config.ledger, copies, installation);
          yield* guardedHeld;
          return proof;
        });
      const beforeReopen = await activeRuntime.runPromise(verify(identities[0]));
      expect(await activeRuntime.runPromise(verify(identities[1]))).toEqual(beforeReopen);
      // Advance the disposable index beyond the imported proof before reopening the provider.
      for (let i = 0; i < 96; i++) {
        await insertRaw(config, {
          "@id": `urn:fixture:old-transition-index:${i}`,
          "urn:fixture:old-transition-index-tag": `entry-${i}`,
        });
      }
      const headBeforeReopen = await cutNow();
      expect(headBeforeReopen.incarnation).toBe(incarnation);
      expect(headBeforeReopen.head).toBeGreaterThan(beforeReopen.verifiedAt.head);
      const decodeIndex = Schema.decodeUnknownSync(
        Schema.Struct({ ledger: Schema.Struct({ "index-t": Schema.Int }) })
      );
      let indexed = 0;
      const deadline = Date.now() + 30_000;
      while (indexed < beforeReopen.verifiedAt.head && Date.now() < deadline) {
        const info = await fetch(
          `${config.url}/v1/fluree/info/${encodeURIComponent(config.ledger)}`,
          {
            headers: { authorization: `Bearer ${config.token}` },
            signal: AbortSignal.timeout(2_000),
          }
        );
        if (!info.ok) throw new Error("The disposable provider index status is unavailable.");
        indexed = decodeIndex(await info.json()).ledger["index-t"];
        if (indexed < beforeReopen.verifiedAt.head) await Bun.sleep(100);
      }
      expect(indexed).toBeGreaterThanOrEqual(beforeReopen.verifiedAt.head);
      await activeRuntime.runPromise(guardedHeld);
      await activeRuntime.dispose();
      expect(verifyFluree(flureeAnchor, flureeVersion)).toBe(fluree);
      await provider.restart(fluree);
      activeRuntime = ManagedRuntime.make(
        layerFluree(config, { existingOnly: true }).pipe(Layer.provideMerge(platform))
      );
      expect(await cutNow()).toEqual(headBeforeReopen);
      expect(
        await activeRuntime.runPromise(
          Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(cut))
        )
      ).toBe(sourceCommit);
      const proof = await activeRuntime.runPromise(verify(identities[0]));
      expect(proof.cut).toEqual(beforeReopen.cut);
      expect(proof.rows).toEqual(beforeReopen.rows);
      expect(proof.verifiedAt).toEqual(headBeforeReopen);
      expect(proof.verifiedAt.head).toBeGreaterThan(beforeReopen.verifiedAt.head);
      expect(await activeRuntime.runPromise(verify(identities[1]))).toEqual(proof);
      expect(proof.cut).toEqual(cut);
      expect(proof.verifiedAt.incarnation).toBe(incarnation);
      expect(proof.verifiedAt.head).toBeGreaterThan(cut.head);
      const verifiedCommit = await activeRuntime.runPromise(
        Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(proof.verifiedAt))
      );
      expect((await readCommit(proof.verifiedAt.head)).id).toBe(verifiedCommit);
      expect(proof.rows.map((row) => row.address)).toEqual(expectedAddresses);
      expect(proof.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            address: author,
            status: "VERIFIED_IMPORT",
            position: authorPosition.cursor,
          }),
          expect.objectContaining({
            address: readers[0],
            status: "VERIFIED_IMPORT",
            position: oneOriginal.position,
          }),
          expect.objectContaining({
            address: readers[1],
            status: "VERIFIED_IMPORT",
            position: twoOriginal.position,
          }),
          expect.objectContaining({
            address: unresolved,
            status: "VERIFIED_CLASSIFICATION",
            reason: "unreadable",
          }),
        ])
      );

      const orderedSources =
        first.installation < second.installation
          ? ([first, second] as const)
          : ([second, first] as const);
      const inputs = [
        {
          busDir: roots[0],
          operation,
          sourceCommit,
          verifiedCommit,
          sources: orderedSources,
          localInstallation: identities[0],
          proof,
        },
        {
          busDir: roots[1],
          operation,
          sourceCommit,
          verifiedCommit,
          sources: orderedSources,
          localInstallation: identities[1],
          proof,
        },
      ] as const;
      const serveInputs = [
        {
          busDir: roots[0],
          ledgerName: config.ledger,
          incarnation,
          localInstallation: identities[0],
        },
        {
          busDir: roots[1],
          ledgerName: config.ledger,
          incarnation,
          localInstallation: identities[1],
        },
      ] as const;
      const proofBytes = JSON.stringify(proof);
      const verifyK = (binding: MailboxTransitionBinding) =>
        Effect.tryPromise({
          try: async () => {
            const reachable = (current: { readonly incarnation: string; readonly head: number }) =>
              current.incarnation === binding.verifiedAt.incarnation &&
              current.head >= binding.verifiedAt.head;
            if (!reachable(await cutNow())) throw new Error();
            const commit = await activeRuntime.runPromise(
              Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(binding.verifiedAt))
            );
            if (commit !== binding.verifiedCommit || !reachable(await cutNow())) throw new Error();
          },
          catch: () => new LedgerError({ message: "The disposable verification commit changed." }),
        });
      const checks = (index: 0 | 1): MailboxTransitionChecks => ({
        confirmLocalHeld: () => guardedHeld,
        verifyLocalFence: (binding) =>
          Effect.gen(function* () {
            yield* guardedHeld;
            if (binding.sourceCommit !== sourceCommit) {
              return yield* new LedgerError({ message: "The disposable source commit changed." });
            }
            yield* verifyK(binding);
            yield* verifyMailboxTransitionGuard(
              roots[index],
              config.ledger,
              binding.sources,
              binding.localInstallation,
              binding.operation
            );
            const current = yield* Effect.tryPromise({
              try: () =>
                activeRuntime.runPromise(
                  verifyMailboxImport(config.ledger, copies, identities[index])
                ),
              catch: () =>
                new LedgerError({ message: "The disposable import proof could not be verified." }),
            });
            if (JSON.stringify(current) !== proofBytes) {
              return yield* new LedgerError({ message: "The disposable import proof changed." });
            }
            yield* guardedHeld;
          }),
      });
      const readyOne = await activeRuntime.runPromise(
        recordMailboxTransitionReady(inputs[0], checks(0))
      );
      const readyTwo = await activeRuntime.runPromise(
        recordMailboxTransitionReady(inputs[1], checks(1))
      );
      await activeRuntime.runPromise(acceptMailboxTransitionPeer(inputs[0], readyTwo, checks(0)));
      await activeRuntime.runPromise(acceptMailboxTransitionPeer(inputs[1], readyOne, checks(1)));
      const admittedOne = readFileSync(
        join(roots[0], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
        "utf8"
      );
      const admittedTwo = readFileSync(
        join(roots[1], MAILBOX_TRANSITION_ADMITTED_COMPLETE_FILE),
        "utf8"
      );
      const permitChecks = (index: 0 | 1): MailboxTransitionChecks => ({
        confirmLocalHeld: () => guardedHeld,
        verifyLocalFence: (binding) =>
          Effect.gen(function* () {
            yield* guardedHeld;
            if (binding.sourceCommit !== sourceCommit) {
              return yield* new LedgerError({ message: "The disposable source commit changed." });
            }
            yield* verifyK(binding);
            yield* verifyMailboxTransitionGuard(
              roots[index],
              config.ledger,
              binding.sources,
              binding.localInstallation,
              binding.operation
            );
            const witness = yield* Effect.tryPromise({
              try: () =>
                activeRuntime.runPromise(
                  Effect.flatMap(Ledger, (ledger) =>
                    ledger.ownershipActivationAt({ source: cut, operation: binding.operation })
                  )
                ),
              catch: () =>
                new LedgerError({ message: "The disposable activation could not be verified." }),
            });
            if (
              witness.sourceCommit !== sourceCommit ||
              witness.commit !== activation.commit ||
              witness.cut.incarnation !== incarnation ||
              witness.cut.head !== cut.head + 1
            ) {
              return yield* new LedgerError({ message: "The disposable activation changed." });
            }
            yield* guardedHeld;
          }),
      });
      await rejectCandidate(roots[0]);
      expect(await cutNow()).toEqual(proof.verifiedAt);
      await activeRuntime.runPromise(
        permitMailboxTransitionServe(serveInputs[0], admittedTwo, permitChecks(0))
      );

      const nextOne = candidate(roots[0]);
      const nextClientOne = await connect(nextOne);
      const newSend = await call(nextClientOne, "bus_publish", {
        from: author,
        session: session(author),
        to: [readers[0]],
        body: "fresh new-format C",
        operation: Bun.randomUUIDv7(),
      });
      if (typeof newSend.id !== "string") throw new Error("The candidate publish returned no id.");
      expect(new Set([acknowledged, ...unread, unresolvedMail, newSend.id]).size).toBe(5);
      const advanced = await cutNow();
      expect(advanced.incarnation).toBe(incarnation);
      expect(advanced.head).toBeGreaterThan(proof.verifiedAt.head);
      await rejectCandidate(roots[1]);
      expect(await cutNow()).toEqual(advanced);
      await activeRuntime.runPromise(
        permitMailboxTransitionServe(serveInputs[1], admittedOne, permitChecks(1))
      );
      expect(await cutNow()).toEqual(advanced);
      const nextTwo = candidate(roots[1]);
      const nextClientTwo = await connect(nextTwo);
      const readCandidate = async (client: Client, address: string) =>
        messages(
          (await call(client, "bus_read", { address, session: session(address) })).messages
        ).map((message) => message.id);
      const delivered = await readCandidate(nextClientOne, readers[0]);
      expect(delivered).toEqual([unread[0], newSend.id]);
      expect(delivered).not.toContain(acknowledged);
      expect(await readCandidate(nextClientTwo, readers[1])).toEqual([unread[1]]);
      expect(await readCandidate(nextClientOne, readers[0])).toEqual([]);
      expect(await readCandidate(nextClientTwo, readers[1])).toEqual([]);
      const beforeUnresolved = await cutNow();
      const unresolvedRead = CallToolResultSchema.parse(
        await nextClientOne.callTool({
          name: "bus_read",
          arguments: { address: unresolved, session: session(unresolved) },
        })
      );
      expect(unresolvedRead.isError).toBe(true);
      const firstError = unresolvedRead.content[0];
      expect(firstError?.type).toBe("text");
      if (firstError?.type !== "text") throw new Error("The unresolved refusal had no text.");
      expect(firstError.text).toMatch(/mailbox position is unresolved \(unreadable\)/i);
      expect(await cutNow()).toEqual(beforeUnresolved);
      await stop(nextOne, nextClientOne);
      await stop(nextTwo, nextClientTwo);
      for (const [index, root] of roots.entries()) {
        const reader = readers[index];
        if (reader === undefined) throw new Error("Missing disposable reader.");
        const restarted = candidate(root);
        const client = await connect(restarted);
        expect(await readCandidate(client, reader)).toEqual([]);
        await stop(restarted, client);
        const original = originals[index];
        const marker = markers[index];
        if (original === undefined || marker === undefined)
          throw new Error("Missing disposable cursor state.");
        expect(
          directoryBytes(original.exact).filter(([name]) => name !== ".export-pending")
        ).toEqual(original.bytes);
        expect(readFileSync(join(original.exact, ".export-pending")).toString("hex")).toBe(marker);
        expect(readFileSync(join(root, "installation-id"))).toEqual(original.identity);
      }
    } finally {
      try {
        for (const client of clients) await client.close().catch(() => {});
        await processes.stop();
      } finally {
        try {
          await disposeRuntime?.();
        } finally {
          try {
            await stopFluree?.();
          } finally {
            rmSync(fixture, { recursive: true, force: true });
          }
        }
      }
    }
  },
  120_000
);
