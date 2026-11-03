// Preloaded into every `bun test` run (bunfig.toml [test] preload). A hook defined here is
// global: it runs once, after the last test file, so the shared Fluree server outlives every
// file that uses it and is stopped, and its exit awaited, before the process ends. That
// assumes the default serial runner: under `bun test --parallel` the preload runs per file
// or per worker, so a later file would find the server already stopped.
import { afterAll } from "bun:test";
import { stopFlureeServer } from "./fluree-server.ts";

afterAll(stopFlureeServer, 30_000);
