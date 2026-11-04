import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewerClient } from "../shared/client-types";
import type { InvestigationReference } from "../shared/public";
import { App } from "./App";
import {
  PinnedInvestigation,
  type ReadPage,
  RefusedReference,
} from "./features/pinned/PinnedInvestigation";
import { investigationHash, parseInvestigationFragment } from "./features/pinned/reference";

/**
 * The live viewer, or the pinned investigation its fragment names. Only one is mounted, so
 * live observations and their automatic refresh stop while an investigation is shown.
 */
export function ViewerRoute({ client }: { client: ViewerClient }) {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const change = () => setHash(location.hash);
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("popstate", change);
    };
  }, []);
  const fragment = useMemo(() => parseInvestigationFragment(hash), [hash]);
  const readPage = useCallback<ReadPage>(
    (input, signal) => client.investigationPage(input, { signal }),
    [client]
  );
  // Setting the fragment adds a history entry and fires hashchange, so Back returns here.
  const open = useCallback((reference: InvestigationReference) => {
    location.hash = investigationHash(reference);
  }, []);
  if (fragment.kind === "none") return <App client={client} />;
  if (fragment.kind === "refused") return <RefusedReference reason={fragment.reason} />;
  return (
    <PinnedInvestigation
      key={hash}
      reference={fragment.reference}
      readPage={readPage}
      onOpen={open}
    />
  );
}
