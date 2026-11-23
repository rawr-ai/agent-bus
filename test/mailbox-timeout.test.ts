import { expect, test } from "bun:test";
import { Effect } from "effect";
import { type MailboxTransport, makeFlureeMailbox } from "../src/FlureeMailbox.ts";
import type { MailboxStart } from "../src/mailbox-model.ts";

const cut = { head: 1, incarnation: "fixture" };
const start = (): MailboxStart => ({
  version: 1,
  kind: "start",
  operation: Bun.randomUUIDv7(),
  address: "claude/timeouts",
  run: Bun.randomUUIDv7(),
  origin: "import",
  position: 0,
});
const transport = (): MailboxTransport => ({
  instance: cut.incarnation,
  timeout: "20 millis",
  head: Effect.succeed(cut.head),
  incarnation: Effect.succeed(cut.incarnation),
  at: () => Effect.succeed([]),
  history: () => Effect.succeed([]),
  update: () => Effect.succeed(cut.head),
  messageNode: () => ({}),
});

test("a stalled mailbox read fails at the total deadline, never as absence", async () => {
  const store = makeFlureeMailbox({ ...transport(), head: Effect.never });
  await expect(Effect.runPromise(store.mailboxAt("claude/timeouts", cut))).rejects.toThrow(
    "timed out"
  );
  expect(
    (await Effect.runPromise(store.mailboxReceiptAt("claude/timeouts", Bun.randomUUIDv7(), cut)))
      .status
  ).toBe("UNAVAILABLE");
});

test("an update stalled after dispatch settles as UNKNOWN, never a definite no-op", async () => {
  let sent = 0;
  const store = makeFlureeMailbox({
    ...transport(),
    update: () =>
      Effect.sync(() => {
        sent++;
      }).pipe(Effect.flatMap(() => Effect.never)),
  });
  expect((await Effect.runPromise(store.importMailbox(start(), cut))).status).toBe("UNKNOWN");
  expect(sent).toBe(1);
});
