import { MAX_PARTICIPANT_LENGTH } from "../../../shared/limits";
import type { PeersObservation, PublicMute, PublicPeer } from "../../../shared/public";
import { Audience, safeText, Text } from "../../Text";

// Active is the ordinary state and shows nothing; an older serve's peer has no activity at all.
const ACTIVITY_LABEL: Partial<Record<NonNullable<PublicPeer["activity"]>, string>> = {
  inactive: "Inactive",
  unknown: "Activity unknown",
};

const muteText = (mute: PublicMute): string => {
  switch (mute.scope) {
    case "programme":
      return "*";
    case "topic":
      return `#${mute.topic}`;
    case "directory":
      return `directory ${mute.directory}`;
    case "concern":
      return `concern ${mute.directory}/${mute.concern}`;
  }
};

export function PeerList({
  data,
  error,
  onInvestigate,
}: {
  data: PeersObservation | null;
  error: boolean;
  onInvestigate?: (address: string) => void;
}) {
  return (
    <div className="thread-scroll">
      {!data && <p className="empty">{error ? "Peers unavailable." : "Loading peers…"}</p>}
      {data && data.peers.length === 0 && (
        <p className="empty">
          {data.omitted
            ? "No displayable peers in this observation."
            : "No currently joined peers in this observation."}
        </p>
      )}
      {data?.peers.map((peer, i) => (
        <div className="peer-row" key={`${peer.address}-${i}`}>
          <div className="peer-address">
            <Text value={peer.address} />
          </div>
          {onInvestigate &&
            peer.address !== "" &&
            peer.address.length <= MAX_PARTICIPANT_LENGTH && (
              <button
                type="button"
                className="text-action"
                aria-label={`Investigate exact address ${safeText(peer.address)}`}
                onClick={() => onInvestigate(peer.address)}
              >
                Investigate exact address
              </button>
            )}
          <div className="peer-meta">
            <Text value={peer.runtime} />
            {peer.host && (
              <>
                {" "}
                · <Text value={peer.host} />
              </>
            )}
            {peer.activity && ACTIVITY_LABEL[peer.activity] && (
              <> · {ACTIVITY_LABEL[peer.activity]}</>
            )}
          </div>
          {peer.topics.length > 0 && (
            <div className="peer-topics">
              <span>Topics</span>
              <Audience values={peer.topics} />
            </div>
          )}
          {peer.mutes && peer.mutes.length > 0 && (
            <div className="peer-topics">
              <span>Muted</span>
              <Audience values={peer.mutes.map(muteText)} />
            </div>
          )}
          {peer.note && (
            <p className="peer-note">
              <Text value={peer.note} />
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
