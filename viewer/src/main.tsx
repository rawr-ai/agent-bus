import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ViewerClient } from "../shared/client-types";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary";
import { ViewerRoute } from "./ViewerRoute";

const client: ViewerClient = createORPCClient(
  new RPCLink({ url: new URL("/rpc", location.origin) })
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ViewerErrorBoundary>
      <ViewerRoute client={client} />
    </ViewerErrorBoundary>
  </StrictMode>
);
