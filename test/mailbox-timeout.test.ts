import { expect, test } from "bun:test";
import { Effect } from "effect";
import { type MailboxTransport, makeFlureeMailbox } from "../src/FlureeMailbox.ts";

const cut = { head: 1, incarnation: "fixture" };
const transport = (): MailboxTransport => ({
  ownership: {
    eraAt: () => Effect.succeed(1),
    prepare: () => Effect.succeed("urn:slot"),
    proves: () => Effect.succeed(true),
  },
  instance: cut.incarnation,
  timeout: "20 millis",
  head: Effect.succeed(cut.head),
  incarnation: Effect.succeed(cut.incarnation),
  at: (_head, body) =>
    Effect.succeed(
      Array.isArray(body.select) && body.select.includes("?marker")
        ? [[null, null, null, null, false, null, false, null]]
        : Array.isArray(body.select) && body.select.includes("?predicate")
          ? [[null, null, null, null, null, false, null, null, false]]
          : []
    ),
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
