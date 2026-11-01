import type { RouterClient } from "@orpc/server";
import type { ViewerRouter } from "../server/router.ts";

/** Type-only projection: browser bundles must never import the server router value. */
export type ViewerClient = RouterClient<ViewerRouter>;
