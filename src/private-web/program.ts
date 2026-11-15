import type { DirectTool, EventsProgram, StaticSkill } from "mcp-openapi";
import { busSkill } from "../skill.ts";
import type { PeerActor, PeerInvocation } from "./identity.ts";
import { busPeer, peerTools, type wakePort } from "./peer.ts";
export type ResolvePeer = (identity: PeerInvocation) => Promise<PeerActor>;
type PeerHost = (
  tools: ReadonlyArray<DirectTool<PeerActor>>,
  options: {
    readonly resolveContext: ResolvePeer;
    readonly skills: ReadonlyArray<StaticSkill>;
    readonly events?: EventsProgram;
    readonly signal?: AbortSignal;
  }
) => Promise<void>;

export const servePeer = async (options: {
  readonly busPort: number;
  readonly expectedBusVersion: string;
  readonly cwd: string;
  readonly resolveContext: ResolvePeer;
  readonly events?: (wake: ReturnType<typeof wakePort>) => EventsProgram;
  readonly prepareWatch?: (wake: ReturnType<typeof wakePort>) => DirectTool<PeerActor>;
  readonly runHost: PeerHost;
  readonly signal?: AbortSignal;
}) => {
  const peer = await busPeer(options);
  try {
    const tools: DirectTool<PeerActor>[] = [...peerTools(peer.exchange, options.cwd)];
    if (options.prepareWatch !== undefined) tools.push(options.prepareWatch(peer.wake));
    await options.runHost(tools, {
      resolveContext: options.resolveContext,
      skills: [busSkill],
      ...(options.events === undefined ? {} : { events: options.events(peer.wake) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    await peer.dispose();
  }
};
