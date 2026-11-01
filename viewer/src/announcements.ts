import type { ObservationFailure, ObservationSnapshot } from "./observation-resource";

export interface AnnouncerOptions<T> {
  /** Spoken name of the resource, such as "History". */
  readonly name: string;
  readonly noun: readonly [singular: string, plural: string];
  /** Identities of the displayed records, used to count arrivals and departures. */
  readonly identities: (value: T) => ReadonlyArray<string>;
  /** Also report records that are no longer listed (current peers, not a bounded history window). */
  readonly reportDepartures?: boolean;
}

/**
 * Turns settled observation snapshots into the few changes a screen-reader user needs to hear:
 * the first observation, applied criteria, records that arrived (or left, when asked), a failure
 * and a recovery. Loading, cancellation, a repeated failure of the same kind and a refresh that
 * observes the same records stay silent, so periodic refresh does not repeat itself.
 */
export const createAnnouncer = <I, T>(options: AnnouncerOptions<T>) => {
  let observed: { readonly ref: object; readonly key: string; ids: ReadonlySet<string> } | null =
    null;
  let failed: ObservationFailure | null = null;
  const count = (n: number, adjective = "") =>
    `${n} ${adjective}${n === 1 ? options.noun[0] : options.noun[1]}`;
  return (snapshot: ObservationSnapshot<I, T>): string | null => {
    if (snapshot.loading) return null;
    if (snapshot.error !== null) {
      if (failed === snapshot.error) return null;
      failed = snapshot.error;
      const verb = snapshot.error === "timeout" ? "timed out" : "failed";
      return snapshot.observation === null
        ? `${options.name} ${snapshot.error === "timeout" ? "timed out" : "unavailable"}.`
        : `${options.name} refresh ${verb}; showing the last observation.`;
    }
    const observation = snapshot.observation;
    if (observation === null || observation === observed?.ref) return null;
    const ids = new Set(options.identities(observation.value));
    const previous = observed;
    const recovered = failed !== null;
    observed = { ref: observation, key: observation.key, ids };
    failed = null;
    if (previous === null) return `${options.name} observed: ${count(ids.size)}.`;
    if (previous.key !== observation.key)
      return `${options.name} observed for the applied criteria: ${count(ids.size)}.`;
    const changes: string[] = [];
    const arrived = [...ids].filter((id) => !previous.ids.has(id)).length;
    if (arrived > 0) changes.push(count(arrived, "new "));
    const departed = [...previous.ids].filter((id) => !ids.has(id)).length;
    if (options.reportDepartures && departed > 0)
      changes.push(`${count(departed)} no longer listed`);
    if (changes.length > 0)
      return `${options.name}${recovered ? " observed again" : ""}: ${changes.join(", ")}.`;
    return recovered ? `${options.name} observed again.` : null;
  };
};
