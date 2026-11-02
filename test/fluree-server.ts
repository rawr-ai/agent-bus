/**
 * One throwaway, in-memory Fluree server per test process, shared by every
 * suite that needs a real query engine. Like the installed server, its data and
 * admin APIs require a token signed by a key it trusts. The `fluree` binary is
 * required: without it the suites that use this fail instead of skipping.
 *
 * `bun test` runs every file in one process and does not emit the process's `exit`
 * event, so the server is stopped by `stopFlureeServer`, which test/preload.ts
 * registers as a global afterAll: it runs once, after the last test file.
 */
import type { FlureeConfig } from "../src/Fluree.ts";

export const flureeBin = Bun.which("fluree");

const command = (args: ReadonlyArray<string>, stdin?: string) => {
  const result = Bun.spawnSync([...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stderr: "ignore",
  });
  if (!result.success) throw new Error(`${args.slice(0, 3).join(" ")} failed`);
  return result.stdout.toString().trim();
};

interface Server {
  readonly url: string;
  readonly token: string;
  readonly process: ReturnType<typeof Bun.spawn>;
}

/** Whether nothing listens on the port now: a quick bind and release. */
const portFree = (port: number) => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

const launch = async (): Promise<Server> => {
  if (flureeBin === null) {
    throw new Error("The fluree CLI is not on PATH; the query and store suites need it.");
  }
  const key = JSON.parse(command([flureeBin, "token", "keygen", "--format", "json"])) as {
    readonly privateKey: { readonly hex: string };
    readonly did: string;
  };
  // No subject: a token naming an identity would be held to identity policies, which deny writes.
  const token = command(
    [flureeBin, "token", "create", "--private-key", "@-", "--all", "--read-all", "--write-all"],
    key.privateKey.hex
  );
  const auth = ["data", "admin"].flatMap((scope) => [
    `--${scope}-auth-mode`,
    "required",
    `--${scope}-auth-trusted-issuer`,
    key.did,
  ]);
  // Only the child trusts the key made above, and it refuses requests without a token: a
  // server that answers both ways is this child, never another process on the same port.
  const ours = async (url: string) => {
    const status = (headers: Record<string, string>) =>
      fetch(`${url}/v1/fluree/ledgers`, { headers }).then(
        (r) => r.status,
        () => 0
      );
    return (
      (await status({ authorization: `Bearer ${token}` })) === 200 && (await status({})) === 401
    );
  };
  for (let launchAttempt = 0; launchAttempt < 5; launchAttempt++) {
    if (stopped) break;
    const port = 18_500 + Math.floor(Math.random() * 1400);
    if (!portFree(port)) continue;
    const url = `http://127.0.0.1:${port}`;
    const spawned = Bun.spawn(
      [flureeBin, "server", "run", "--memory", "--listen-addr", `127.0.0.1:${port}`, "--"].concat([
        "--cors-enabled=false",
        ...auth,
      ]),
      { stdout: "ignore", stderr: "ignore" }
    );
    // Known to stop from the moment it exists, so a launch still polling is never orphaned.
    child = spawned;
    let ready = false;
    try {
      for (let attempt = 0; attempt < 50 && spawned.exitCode === null && !stopped; attempt++) {
        if (await ours(url)) {
          ready = true;
          return { url, token, process: spawned };
        }
        await Bun.sleep(100);
      }
    } finally {
      // Any attempt that does not return its server, whether it timed out, was stopped or
      // threw, ends its own child before the next one starts.
      if (!ready) await end(spawned);
    }
  }
  throw new Error(stopped ? "the shared fluree server was stopped" : "fluree server did not start");
};

/** Stops one child and waits until it has exited; harmless once it has. */
const end = async (proc: ReturnType<typeof Bun.spawn>) => {
  proc.kill();
  await proc.exited;
};

let server: Promise<Server> | undefined;
/** The child of the launch in progress, or of the running server. */
let child: ReturnType<typeof Bun.spawn> | undefined;
let stopped = false;
let stopping: Promise<void> | undefined;
let ledgers = 0;

const shared = () => {
  server ??= launch();
  return server;
};

/**
 * Stops the shared server and waits for it to exit, once per process: later calls return the
 * same stop. A launch still in progress ends its own child first; a failed launch is not
 * reported again here. After it, the server cannot be started again.
 */
export const stopFlureeServer = (): Promise<void> => {
  stopping ??= (async () => {
    stopped = true;
    await server?.catch(() => undefined);
    if (child !== undefined) await end(child);
  })();
  return stopping;
};

/** The running server's process id, for the lifecycle regression. */
export const flureeServerPid = async () => (await shared()).process.pid;

export interface FlureeServer {
  readonly url: string;
  readonly token: string;
}

/** The shared server, started on first use. */
export const flureeServer = (): Promise<FlureeServer> => shared();

/** A config for a new, empty ledger on a started server. */
export const ledgerOn = (server: FlureeServer, name = "bus-test") => {
  ledgers += 1;
  return { url: server.url, ledger: `${name}-${process.pid}-${ledgers}:main`, token: server.token };
};

/** A config for a new, empty ledger on the shared server. */
export const freshLedger = async (name = "bus-test") => ledgerOn(await shared(), name);

/** Inserts a raw JSON-LD node, bypassing the bus: for damaged entries in tests. */
export const insertRaw = async (config: FlureeConfig & { token: string }, node: unknown) => {
  const response = await fetch(
    `${config.url}/v1/fluree/insert?ledger=${encodeURIComponent(config.ledger)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(node),
    }
  );
  if (!response.ok) throw new Error(`raw insert failed (HTTP ${response.status})`);
};

/** Sends a request to the shared server with its token, for refusal checks that bypass the bus. */
export const flureeFetch = async (path: string, init: RequestInit = {}) => {
  const running = await shared();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${running.token}`);
  return fetch(`${running.url}${path}`, { ...init, headers });
};
