/**
 * One throwaway, in-memory Fluree server per test process, shared by every
 * suite that needs a real query engine. Like the installed server, its data and
 * admin APIs require a token signed by a key it trusts. The `fluree` binary is
 * required: without it the suites that use this fail instead of skipping.
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
  for (let launchAttempt = 0; launchAttempt < 5; launchAttempt++) {
    const port = 18_500 + Math.floor(Math.random() * 1400);
    const url = `http://127.0.0.1:${port}`;
    const child = Bun.spawn(
      [flureeBin, "server", "run", "--memory", "--listen-addr", `127.0.0.1:${port}`, "--"].concat([
        "--cors-enabled=false",
        ...auth,
      ]),
      { stdout: "ignore", stderr: "ignore" }
    );
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
      const ready = await fetch(`${url}/health`).then(
        (r) => r.ok,
        () => false
      );
      if (ready) return { url, token, process: child };
      await Bun.sleep(100);
    }
    child.kill();
    await child.exited;
  }
  throw new Error("fluree server did not start");
};

let server: Promise<Server> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let ledgers = 0;

// Every test file runs in this one process; the server ends with it.
process.once("exit", () => child?.kill());

const shared = () => {
  server ??= launch().then((running) => {
    child = running.process;
    return running;
  });
  return server;
};

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
