import { expect, test } from "bun:test";
import { Effect } from "effect";
import { LedgerError, Message, Presence } from "../src/domain.ts";
import { messageIri } from "../src/Ledger.ts";
import { mailboxWindow } from "../src/mailbox-window.ts";

test("a failed or malformed carrier read does not trigger a wider presence query", async () => {
  const capacity = new LedgerError({ message: "capacity" });
  for (const reply of [
    Effect.fail(new LedgerError({ message: "capacity" })),
    Effect.succeed([["subject", "malformed row"]]),
    Effect.succeed([["subject", "{bad carrier}", 2]]),
  ]) {
    let requests = 0;
    const error = await Effect.runPromise(
      Effect.flip(
        mailboxWindow(
          2,
          2,
          () => {
            requests++;
            return reply;
          },
          capacity,
          () => Effect.die(new Error("Unexpected presence query.")),
          () => Effect.fail(new LedgerError({ message: "Invalid carrier." }))
        )
      )
    );
    expect(error._tag).toBe("LedgerError");
    expect(requests).toBe(1);
  }
});

test("the bounded remainder must account for every unproved carrier at its own commit", async () => {
  const message = new Message({
    id: Bun.randomUUIDv7(),
    from: "fixture/large",
    to: ["*"],
    ts: new Date().toISOString(),
    kind: "presence",
    body: "joined",
    presence: new Presence({ runtime: "other", status: "joined", topics: [] }),
  });
  const subject = messageIri(message.id);
  const capacity = new LedgerError({ message: "capacity" });
  for (const remainder of [[], [["urn:other", "value", 3]], [["urn:mail", "value", 4]]]) {
    let requests = 0;
    const error = await Effect.runPromise(
      Effect.flip(
        mailboxWindow(
          2,
          4,
          () => {
            requests++;
            if (requests === 1) return Effect.fail(capacity);
            if (requests === 2)
              return Effect.succeed([
                [subject, 2],
                ["urn:mail", 3],
              ]);
            return Effect.succeed(remainder);
          },
          capacity,
          () => Effect.succeed([{ subject, entryT: 2, t: 2, message }]),
          () => Effect.die(new Error("An unproved remainder was decoded."))
        )
      )
    );
    expect(error.message).toContain("inventory is inconsistent");
    expect(requests).toBe(3);
  }
});
