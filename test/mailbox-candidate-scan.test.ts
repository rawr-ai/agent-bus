import { expect, test } from "bun:test";
import { Effect } from "effect";
import { LedgerError } from "../src/domain.ts";
import { scanMailboxCandidates } from "../src/mailbox-candidate-scan.ts";

const overflow = new LedgerError({ message: "routing response exceeded byte limit" });
const invalid = () => new LedgerError({ message: "invalid response" });
const routing = (subject: string, t: number) =>
  (["id", "from"] as const).map(
    (p) => [subject, `bus:${p}`, subject, t, true, "xsd:string"] as const
  );

test("one early type in forty windows takes one subject lookup through the cut, not forty", async () => {
  const types: Array<number> = [];
  const requests: Array<unknown> = [];
  const rows = await Effect.runPromise(
    scanMailboxCandidates(
      3,
      20_003,
      500,
      (start) => {
        types.push(start);
        return Effect.succeed(start === 4 ? [["s", start, true]] : []);
      },
      (start, stop, subjects) => {
        requests.push([start, stop, subjects]);
        return Effect.succeed(routing("s", 4));
      },
      overflow,
      invalid
    )
  );
  expect(types).toEqual(Array.from({ length: 40 }, (_, i) => 4 + 500 * i));
  expect(requests).toEqual([[4, 20_003, ["s"]]]);
  expect(rows).toEqual([{ subject: "s", end: 4, routing: { id: "s", from: "s", to: [] } }]);
});

test("dense windows use disjoint ranges; only a capacity failure retries by bounded subject batches", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `s${i}`);
  for (const failure of [undefined, overflow, invalid()]) {
    const requests: Array<[number, number, number | undefined]> = [];
    const result = Effect.runPromise(
      scanMailboxCandidates(
        0,
        1000,
        500,
        (start) => Effect.succeed(start === 1 ? ids.map((id) => [id, 1, true] as const) : []),
        (start, stop, subjects) => {
          requests.push([start, stop, subjects?.length]);
          if (start === 501 && failure !== undefined && subjects === undefined)
            return Effect.fail(failure);
          if (start === 1) return Effect.succeed(ids.flatMap((id) => routing(id, 1)));
          return Effect.succeed(
            subjects === undefined || subjects.includes("s100")
              ? [["s100", "bus:from", "s100", 1000, false, "xsd:string"]]
              : []
          );
        },
        overflow,
        invalid
      )
    );
    if (failure !== undefined && failure !== overflow)
      await expect(result).rejects.toThrow("invalid response");
    else {
      const rows = await result;
      expect(rows.length).toBe(101);
      expect(rows[0]?.routing).toEqual({ id: "s0", from: "s0", to: [] });
      expect(rows[100]).toEqual({ subject: "s100", end: 1 });
    }
    expect(requests.slice(0, 2)).toEqual([
      [1, 500, undefined],
      [501, 1000, undefined],
    ]);
    expect(requests.slice(2)).toEqual(
      failure === overflow
        ? [
            [501, 1000, 100],
            [501, 1000, 1],
          ]
        : []
    );
  }
});
