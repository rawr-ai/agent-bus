import type { Message } from "../src/domain.ts";

// The sealed predecessor (69e4382677ee) counted this full public row, not the
// candidate's default inbox projection. Do not import production renderers here.
export const incumbentRow = ({
  id,
  ts,
  from,
  to,
  kind,
  body,
  subject,
  replyTo,
  origin,
}: Message) => ({
  id,
  ts,
  from,
  to,
  kind,
  body,
  ...(subject === undefined ? {} : { subject }),
  ...(replyTo === undefined ? {} : { replyTo }),
  ...(origin === undefined
    ? {}
    : {
        origin: {
          host: origin.host,
          ...(origin.cwd === undefined ? {} : { cwd: origin.cwd }),
          ...(origin.repo === undefined ? {} : { repo: origin.repo }),
          ...(origin.branch === undefined ? {} : { branch: origin.branch }),
        },
      }),
});

export const compactRow = (message: Message) => {
  const { origin: _origin, ...row } = incumbentRow(message);
  return row;
};

export const readFixtureId = "01a20000-0000-7000-8000-000000000000";

/** Count both success encodings; JSON-RPC framing is not part of the Bus allowance. */
export const carrierWidth = (structuredContent: object) =>
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    }),
    "utf8"
  );

export const incumbentWidth = (
  messages: ReadonlyArray<Message>,
  receipt: object | undefined,
  nextReadId = readFixtureId
) =>
  carrierWidth({
    messages: messages.map(incumbentRow),
    ...(receipt === undefined ? {} : { receipt }),
    nextReadId,
  });
