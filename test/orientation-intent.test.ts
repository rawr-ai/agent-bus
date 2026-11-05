import { expect, test } from "bun:test";
import { Schema } from "effect";
import { messageIri, revisionIri, scopeIri, witnessIri } from "../src/Ledger.ts";
import {
  bulletinIntent,
  canonicalJson,
  directoryIntent,
  OrientationIntent,
} from "../src/orientation-model.ts";

test("intent constructors preserve handwritten canonical witness bytes", () => {
  const directory = directoryIntent({
    scope: { kind: "directory", directory: "project" },
    expected: null,
    directory: {
      id: "project",
      name: "Project",
      aliases: ["/repo"],
      concerns: [{ id: "one", name: "One", topic: "work" }],
    },
    audience: ["reader"],
    publisher: "publisher",
  });
  const programme = bulletinIntent({
    action: "publish",
    scope: { kind: "programme" },
    expected: null,
    publisher: "publisher",
    body: "Guidance",
    expiresAt: "2027-01-01T00:00:00.000Z",
    recipients: undefined,
  });
  const concern = bulletinIntent({
    action: "publish",
    scope: { kind: "concern", directory: "project", concern: "one" },
    expected: null,
    publisher: "publisher",
    body: "Concern",
    expiresAt: undefined,
    recipients: ["reader"],
  });
  const withdrawal = bulletinIntent({
    action: "withdraw",
    scope: { kind: "concern", directory: "project", concern: "one" },
    expected: "01900000-0000-7000-8000-000000000003",
    publisher: "publisher",
    body: undefined,
    expiresAt: undefined,
    recipients: undefined,
  });
  expect(canonicalJson(directory)).toBe(
    '{"action":"replace","audience":["reader"],"directory":{"aliases":["/repo"],"concerns":[{"id":"one","name":"One","topic":"work"}],"id":"project","name":"Project"},"expected":null,"publisher":"publisher","scope":{"directory":"project","kind":"directory"}}'
  );
  expect(canonicalJson(programme)).toBe(
    '{"action":"publish","audience":{"programme":true},"body":"Guidance","expected":null,"expiresAt":"2027-01-01T00:00:00.000Z","publisher":"publisher","scope":{"kind":"programme"}}'
  );
  expect(canonicalJson(concern)).toBe(
    '{"action":"publish","audience":{"concernTopic":true,"recipients":["reader"]},"body":"Concern","expected":null,"publisher":"publisher","scope":{"concern":"one","directory":"project","kind":"concern"}}'
  );
  expect(canonicalJson(withdrawal)).toBe(
    '{"action":"withdraw","audience":{"previous":true},"expected":"01900000-0000-7000-8000-000000000003","publisher":"publisher","scope":{"concern":"one","directory":"project","kind":"concern"}}'
  );
  for (const recipients of [undefined, []]) {
    const emptyConcern = bulletinIntent({
      action: "publish",
      scope: { kind: "concern", directory: "project", concern: "one" },
      expected: null,
      publisher: "publisher",
      body: "Concern",
      expiresAt: undefined,
      recipients,
    });
    expect(canonicalJson(emptyConcern)).toBe(
      '{"action":"publish","audience":{"concernTopic":true,"recipients":[]},"body":"Concern","expected":null,"publisher":"publisher","scope":{"concern":"one","directory":"project","kind":"concern"}}'
    );
  }
  const decode = Schema.decodeUnknownSync(OrientationIntent, { onExcessProperty: "error" });
  for (const intent of [directory, programme, concern, withdrawal])
    expect(decode(intent)).toEqual(intent);
  expect(() => decode({ ...programme, unexpected: true })).toThrow();
});

test("ledger subject identifiers retain their literal namespaces", () => {
  expect(messageIri("id")).toBe("urn:agent-bus:message:id");
  expect(revisionIri("id")).toBe("urn:agent-bus:revision:id");
  expect(witnessIri("id")).toBe("urn:agent-bus:witness:id");
  expect(scopeIri({ kind: "programme" })).toBe("urn:agent-bus:orientation:programme");
  expect(scopeIri({ kind: "directory", directory: "project" })).toBe(
    "urn:agent-bus:orientation:directory:project"
  );
  expect(scopeIri({ kind: "concern", directory: "project", concern: "one" })).toBe(
    "urn:agent-bus:orientation:concern:project:one"
  );
});
