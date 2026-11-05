import { expect, test } from "bun:test";
import { Effect } from "effect";
import { messageIri, revisionIri, scopeIri, witnessIri } from "../src/Ledger.ts";
import { DAMAGE_MESSAGE, revisionAt } from "../src/orientation-read.ts";
import { QueryGateway } from "../src/Query.ts";

const revision = "01900000-0000-7000-8000-000000000001";
const notification = "01900000-0000-7000-8000-000000000002";
const ts = "2026-11-03T12:00:00.000Z";
const directoryScope = { kind: "directory" as const, directory: "project" };
const programmeScope = { kind: "programme" as const };
const concernScope = { kind: "concern" as const, directory: "project", concern: "one" };
const directory = {
  id: "project",
  name: "Project",
  aliases: ["/repo"],
  concerns: [{ id: "one", name: "One", topic: "work" }],
};
const base = { publisher: "publisher", publishedAt: ts, notification };
const cases = [
  {
    name: "directory",
    scope: directoryScope,
    record: { kind: "directory", directory, ...base, audience: ["reader"] },
    intent:
      '{"action":"replace","audience":["reader"],"directory":{"aliases":["/repo"],"concerns":[{"id":"one","name":"One","topic":"work"}],"id":"project","name":"Project"},"expected":null,"publisher":"publisher","scope":{"directory":"project","kind":"directory"}}',
    mutations: [
      {
        kind: "directory",
        directory: { ...directory, aliases: ["/different"] },
        ...base,
        audience: ["reader"],
      },
      {
        kind: "directory",
        directory: { ...directory, concerns: [{ id: "one", name: "One", topic: "other" }] },
        ...base,
        audience: ["reader"],
      },
    ],
  },
  {
    name: "programme publication",
    scope: programmeScope,
    record: {
      kind: "bulletin",
      scope: programmeScope,
      action: "publish",
      body: "Guidance",
      expiresAt: "2027-01-01T00:00:00.000Z",
      ...base,
      audience: ["*"],
    },
    intent:
      '{"action":"publish","audience":{"programme":true},"body":"Guidance","expected":null,"expiresAt":"2027-01-01T00:00:00.000Z","publisher":"publisher","scope":{"kind":"programme"}}',
    mutations: [
      {
        kind: "bulletin",
        scope: programmeScope,
        action: "publish",
        body: "Changed",
        expiresAt: "2027-01-01T00:00:00.000Z",
        ...base,
        audience: ["*"],
      },
      {
        kind: "bulletin",
        scope: programmeScope,
        action: "publish",
        body: "Guidance",
        expiresAt: "2028-01-01T00:00:00.000Z",
        ...base,
        audience: ["*"],
      },
    ],
  },
  {
    name: "concern publication",
    scope: concernScope,
    record: {
      kind: "bulletin",
      scope: concernScope,
      action: "publish",
      body: "Concern",
      ...base,
      audience: ["#old-topic", "reader"],
    },
    intent:
      '{"action":"publish","audience":{"concernTopic":true,"recipients":["reader"]},"body":"Concern","expected":null,"publisher":"publisher","scope":{"concern":"one","directory":"project","kind":"concern"}}',
    mutations: [
      {
        kind: "bulletin",
        scope: concernScope,
        action: "publish",
        body: "Concern",
        ...base,
        audience: ["#old-topic", "other"],
      },
      {
        kind: "bulletin",
        scope: concernScope,
        action: "publish",
        body: "Concern",
        ...base,
        audience: ["#extra", "#old-topic", "reader"],
      },
    ],
  },
  {
    name: "withdrawal",
    scope: concernScope,
    record: {
      kind: "bulletin",
      scope: concernScope,
      action: "withdraw",
      ...base,
      audience: ["#old-topic", "reader"],
    },
    intent:
      '{"action":"withdraw","audience":{"previous":true},"expected":"01900000-0000-7000-8000-000000000003","publisher":"publisher","scope":{"concern":"one","directory":"project","kind":"concern"}}',
    mutations: [
      {
        kind: "bulletin",
        scope: concernScope,
        action: "publish",
        body: "Concern",
        ...base,
        audience: ["#old-topic", "reader"],
      },
    ],
  },
];

for (const fixture of cases) {
  test(`${fixture.name} checks intent at the requested historical cut`, async () => {
    const cuts: number[] = [];
    let stored: unknown = fixture.record;
    let noticeAudience = fixture.record.audience;
    let witness: unknown = [[fixture.intent, revision, messageIri(notification)]];
    const gateway = QueryGateway.of({
      pin: Effect.die("must not pin"),
      sparql: () => Effect.die("unexpected sparql"),
      jsonld: (t, query) =>
        Effect.sync(() => {
          cuts.push(t);
          const where = query.where;
          const first = Array.isArray(where) ? where[0] : where;
          const subject =
            typeof first === "object" && first !== null && "@id" in first
              ? first["@id"]
              : undefined;
          if (subject === revisionIri(revision))
            return [[scopeIri(fixture.scope), JSON.stringify(stored), messageIri(notification)]];
          if (subject === witnessIri(revision)) return witness;
          if (subject === messageIri(notification))
            return [
              [
                JSON.stringify({
                  id: notification,
                  ts,
                  from: "publisher",
                  to: noticeAudience,
                  kind: "message",
                  body: "notice",
                }),
              ],
            ];
          throw new Error("unexpected current-state lookup");
        }),
    });
    const read = () => Effect.runPromise(revisionAt(gateway, 7, fixture.scope, revision));
    expect(JSON.stringify((await read())?.value)).toBe(JSON.stringify(fixture.record));
    for (const mutation of fixture.mutations) {
      stored = mutation;
      noticeAudience = mutation.audience;
      await expect(read()).rejects.toMatchObject({ message: DAMAGE_MESSAGE });
    }
    stored = fixture.record;
    noticeAudience = fixture.record.audience;
    for (const bad of [
      [],
      [
        [fixture.intent, revision, messageIri(notification)],
        [fixture.intent, revision, messageIri(notification)],
      ],
      [["not-json", revision, messageIri(notification)]],
      [[fixture.intent, "01900000-0000-7000-8000-000000000003", messageIri(notification)]],
      [[fixture.intent, revision, messageIri("01900000-0000-7000-8000-000000000003")]],
    ]) {
      witness = bad;
      await expect(read()).rejects.toMatchObject({ message: DAMAGE_MESSAGE });
    }
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.every((cut) => cut === 7)).toBe(true);
  });
}
