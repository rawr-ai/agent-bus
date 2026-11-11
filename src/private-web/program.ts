import type { PeerActor, PeerInvocation } from "./identity.ts";
import { busPeer, peerTools } from "./peer.ts";
export type ResolvePeer = (identity: PeerInvocation) => Promise<PeerActor>;
type PeerHost = (
  tools: ReturnType<typeof peerTools>,
  options: { readonly resolveContext: ResolvePeer; readonly signal?: AbortSignal }
) => Promise<void>;

export const servePeer = async (options: {
  readonly busPort: number;
  readonly expectedBusVersion: string;
  readonly cwd: string;
  readonly resolveContext: ResolvePeer;
  readonly runHost: PeerHost;
  readonly signal?: AbortSignal;
}) => {
  const peer = await busPeer(options);
  try {
    await options.runHost(peerTools(peer.exchange, options.cwd), {
      resolveContext: options.resolveContext,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    await peer.dispose();
  }
};
