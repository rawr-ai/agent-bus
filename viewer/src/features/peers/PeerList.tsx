import type { PeersObservation } from "../../../shared/public";
import { Audience, Text } from "../../Text";

export function PeerList({ data, error }: { data: PeersObservation | null; error: boolean }) {
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
