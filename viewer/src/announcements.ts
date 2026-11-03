import type { ObservationFailure, ObservationSnapshot } from "./observation-resource";

export interface AnnouncerOptions<T> {
  /** Spoken name of the resource, such as "History". */
  readonly name: string;
  readonly noun: readonly [singular: string, plural: string];
  /** Identities of the displayed records, used to count arrivals and departures. */
  readonly identities: (value: T) => ReadonlyArray<string>;
  /** Records the observation withheld from display, such as duplicates or unsupported kinds. */
  readonly omitted: (value: T) => number;
  /** Also report records that are no longer listed (current peers, not a bounded history window). */
  readonly reportDepartures?: boolean;
}

/**
 * Turns settled observation snapshots into the few changes a screen-reader user needs to hear:
 * the first observation, applied criteria, records that arrived (or left, when asked), a change in
 * how many records are omitted, a failure and a recovery. Loading, cancellation, a repeated failure
 * of the same kind and a refresh that observes the same records and omissions stay silent, so
 * periodic refresh does not repeat itself.
 */
export const createAnnouncer = <I, T>(options: AnnouncerOptions<T>) => {
  let observed: {
    readonly ref: object;
    readonly key: string;
    readonly ids: ReadonlySet<string>;
    readonly omitted: number;
  } | null = null;
  let failed: ObservationFailure | null = null;
  const count = (n: number, adjective = "") =>
    `${n} ${adjective}${n === 1 ? options.noun[0] : options.noun[1]}`;
  const omission = (n: number) =>
    n === 0 ? "no records omitted" : `${n} ${n === 1 ? "record" : "records"} omitted`;
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
    const omitted = options.omitted(observation.value);
    const previous = observed;
    const recovered = failed !== null;
    observed = { ref: observation, key: observation.key, ids, omitted };
    failed = null;
    const selection = `${count(ids.size)}${omitted > 0 ? `, ${omission(omitted)}` : ""}`;
    if (previous === null) return `${options.name} observed: ${selection}.`;
    if (previous.key !== observation.key)
      return `${options.name} observed for the applied criteria: ${selection}.`;
    const changes: string[] = [];
    const arrived = [...ids].filter((id) => !previous.ids.has(id)).length;
    if (arrived > 0) changes.push(count(arrived, "new "));
    const departed = [...previous.ids].filter((id) => !ids.has(id)).length;
    if (options.reportDepartures && departed > 0)
      changes.push(`${count(departed)} no longer listed`);
    if (omitted !== previous.omitted) changes.push(omission(omitted));
    if (changes.length > 0)
      return `${options.name}${recovered ? " observed again" : ""}: ${changes.join(", ")}.`;
    return recovered ? `${options.name} observed again.` : null;
  };
};
