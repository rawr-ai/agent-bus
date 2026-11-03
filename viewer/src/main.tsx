import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ViewerClient } from "../shared/client-types";
import { App } from "./App";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary";

const client: ViewerClient = createORPCClient(
  new RPCLink({ url: new URL("/rpc", location.origin) })
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewerErrorBoundary>
      <App client={client} />
    </ViewerErrorBoundary>
  </StrictMode>
);
