import { StandardRPCJsonSerializer, StandardRPCSerializer } from "@orpc/client/standard";
import { MAX_CONTINUATION_LENGTH, MAX_REQUEST_BYTES } from "./limits.ts";
import type { InvestigationPageInput, InvestigationReference } from "./public.ts";

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
const encoder = new TextEncoder();

/**
 * The UTF-8 size of the body RPCLink posts for `input`: oRPC's own serializer, framed and
 * stringified as RPCLink sends it, so escaped and multibyte characters count as sent.
 */
export const requestBytes = (input: InvestigationPageInput) =>
  encoder.encode(JSON.stringify(serializer.serialize(input))).byteLength;

/** The longest continuation an investigation sends, in the bus's one-byte cursor alphabet. */
const LONGEST_CONTINUATION = "A".repeat(MAX_CONTINUATION_LENGTH);

/** Whether every page of `reference`, with any continuation it can send, fits the host. */
export const referenceFits = (reference: InvestigationReference) =>
  requestBytes({ reference, cursor: LONGEST_CONTINUATION }) <= MAX_REQUEST_BYTES;

/** Whether this one page request fits the host as it will actually be sent. */
export const pageFits = (input: InvestigationPageInput) => requestBytes(input) <= MAX_REQUEST_BYTES;
