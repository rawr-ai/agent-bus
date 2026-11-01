import { MAX_PARTICIPANT_LENGTH } from "../../../shared/limits";
import type { PeersObservation } from "../../../shared/public";
import { Audience, safeText, Text } from "../../Text";

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
          </div>
          {peer.topics.length > 0 && (
            <div className="peer-topics">
              <span>Topics</span>
              <Audience values={peer.topics} />
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
