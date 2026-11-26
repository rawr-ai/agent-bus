import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlureeConfig } from "../src/Fluree.ts";
import { type Supervised, spawnSupervised } from "./supervised.ts";

export interface FileFlureeServer {
  readonly url: string;
  readonly token: string;
  readonly freshLedger: (name?: string) => FlureeConfig & { readonly token: string };
  /** Reopen this disposable store with the selected executable, preserving its files and endpoint. */
  readonly restart: (executable: string) => Promise<void>;
  /** Preserve and reopen a physically independent whole-store copy while the child is stopped. */
  readonly coldCopy: (name: string) => Promise<void>;
  /** Recover a new working copy of a retained cold image at the fixture's original endpoint. */
  readonly openCopy: (name: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

let serverNumber = 0;

/** One owned, authenticated file-backed server. Stop it in the owning suite's afterAll. */
export const startFileFlureeServer = async (
  initialExecutable?: string
): Promise<FileFlureeServer> => {
  const work = mkdtempSync(join(tmpdir(), "agent-bus-file-fluree-"));
  const number = ++serverNumber;
  let child: Supervised | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (child !== undefined && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      rmSync(work, { recursive: true, force: true });
    })();
    return stopping;
  };
  const command = (args: ReadonlyArray<string>, stdin?: string) => {
    const result = Bun.spawnSync([...args], {
      cwd: work,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stderr: "ignore",
      timeout: 10_000,
    });
    if (!result.success) throw new Error("The disposable Fluree fixture command failed");
    return result.stdout.toString().trim();
  };
  try {
    const fluree = initialExecutable ?? Bun.which("fluree");
    if (fluree === null) throw new Error("The qualified fluree is not on PATH");
    const key = JSON.parse(command([fluree, "token", "keygen", "--format", "json"])) as {
      readonly privateKey: { readonly hex: string };
      readonly did: string;
    };
    const token = command(
      [fluree, "token", "create", "--private-key", "@-", "--all", "--read-all", "--write-all"],
      key.privateKey.hex
    );
    command([fluree, "init"]);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = (() => {
      try {
        return Number(probe.url.port);
      } finally {
        probe.stop(true);
      }
    })();
    const url = `http://127.0.0.1:${port}`;
    const auth = ["data", "admin"].flatMap((scope) => [
      `--${scope}-auth-mode`,
      "required",
      `--${scope}-auth-trusted-issuer`,
      key.did,
    ]);
    let executable = fluree;
    let storage = join(work, "storage");
    const halt = async () => {
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    };
    const captures = new Map<string, string>();
    const launch = async () => {
      child = spawnSupervised(
        [
          executable,
          "server",
          "run",
          "--config",
          join(work, ".fluree", "config.toml"),
          "--storage-path",
          storage,
          "--listen-addr",
          `127.0.0.1:${port}`,
          "--",
          "--cors-enabled=false",
          ...auth,
        ],
        { cwd: work, stdout: "ignore", stderr: "ignore" }
      );
      const status = (headers: Record<string, string>) =>
        fetch(`${url}/v1/fluree/ledgers`, { headers, signal: AbortSignal.timeout(500) }).then(
          (response) => response.status,
          () => 0
        );
      for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
        if (
          (await status({ authorization: `Bearer ${token}` })) === 200 &&
          (await status({})) === 401
        ) {
          return;
        }
        await Bun.sleep(100);
      }
      throw new Error("The disposable authenticated Fluree fixture did not start");
    };
    await launch();
    let ledgers = 0;
    return {
      url,
      token,
      freshLedger: (name = "bus-test") => ({
        url,
        token,
        ledger: `${name}-${process.pid}-${number}-${++ledgers}:main`,
      }),
      restart: async (replacement) => {
        await halt();
        executable = replacement;
        await launch();
      },
      coldCopy: async (name) => {
        if (captures.has(name)) throw new Error("Disposable store capture already exists");
        await halt();
        const root = mkdtempSync(join(work, "cold-"));
        const target = join(root, "storage");
        cpSync(storage, target, { recursive: true, force: false, errorOnExist: true });
        captures.set(name, target);
        await launch();
      },
      openCopy: async (name) => {
        const source = captures.get(name);
        if (source === undefined) throw new Error("No disposable cold image was recorded");
        await halt();
        // Never open a capture itself; Fluree can change its index even without a write.
        const root = mkdtempSync(join(work, "recovered-"));
        storage = join(root, "storage");
        cpSync(source, storage, { recursive: true, force: false, errorOnExist: true });
        await launch();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
