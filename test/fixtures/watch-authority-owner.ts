import { WatchAuthority } from "../../src/private-web/watch-authority.ts";

const [eventsPath, resource, mode] = Bun.argv.slice(2);
if (eventsPath === undefined || resource === undefined) throw new Error("Missing fixture input.");
try {
  const authority = new WatchAuthority({ eventsPath, resource });
  if (mode === "try") {
    console.log("acquired");
    await authority.close();
  } else {
    process.on("SIGTERM", () => {
      authority
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    const binding = {
      address: "chatgpt/owner",
      session: "owner-session",
      runtime: "other" as const,
      installation: "installation",
      incarnation: "incarnation",
      run: "owner-run",
    };
    const { ticket } = await authority.prepare(
      { address: binding.address, principal: "owner-principal", session: binding.session },
      async () => binding,
      new AbortController().signal
    );
    Bun.gc(true);
    console.log(JSON.stringify({ pid: process.pid, ticket }));
    setInterval(() => {}, 60_000);
  }
} catch {
  console.log("refused");
}
