import { busReader } from "./reader.ts";
import { evidenceTools, ownerResolver } from "./tools.ts";

type ReaderOptions = Parameters<typeof busReader>[0];
type AuthorizationOptions = Parameters<typeof ownerResolver>[0];
type HostProgram = (
  tools: ReturnType<typeof evidenceTools>,
  options: {
    readonly resolveContext: ReturnType<typeof ownerResolver>;
    readonly signal?: AbortSignal;
  }
) => Promise<void>;

/**
 * A dedicated application's entry boundary. The caller binds the approved direct host config
 * and supplies an active provider verifier; neither is discovered from the environment here.
 */
export const serveEvidence = async (
  options: ReaderOptions &
    AuthorizationOptions & {
      readonly runHost: HostProgram;
      readonly signal?: AbortSignal;
    }
) => {
  if (
    ![options.owner.issuer, options.owner.subject, options.owner.audience].every(
      (v) => v.length > 0
    )
  ) {
    throw new Error("Evidence authorization requires an explicit issuer, owner and resource.");
  }
  const reader = await busReader(options);
  try {
    await options.runHost(evidenceTools(reader.read), {
      resolveContext: ownerResolver(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    // Direct host settlement joins admitted callbacks before the reader scope can end.
    await reader.dispose();
  }
};
