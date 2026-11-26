import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { createFlureeLedgerOnce, type FlureeConfig, layerFluree } from "../src/Fluree.ts";
import { Ledger } from "../src/Ledger.ts";

export async function createFixtureLedger(config: FlureeConfig) {
  const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);
  const created = await Effect.runPromise(
    createFlureeLedgerOnce(config).pipe(Effect.provide(platform))
  );
  if (created.status !== "CREATED") throw new Error("The disposable era-1 ledger was not created.");
  const commit = await Effect.runPromise(
    Effect.flatMap(Ledger, (ledger) => ledger.sourceCommitAt(created.cut)).pipe(
      Effect.provide(layerFluree(config, { existingOnly: true })),
      Effect.provide(platform)
    )
  );
  return { ...created.cut, commit };
}

export const fixtureAttach = (
  installation: string,
  pin: Awaited<ReturnType<typeof createFixtureLedger>>
) => [
  "bind-existing-ledger",
  "--expected-installation",
  installation.trim(),
  "--expected-incarnation",
  pin.incarnation,
  "--expected-head",
  String(pin.head),
  "--expected-commit",
  pin.commit,
];
