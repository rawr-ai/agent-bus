import { createHmac } from "node:crypto";
import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
export const Provider = Schema.Struct({
  issuer: Text,
  userInfo: Text,
  authorizationEndpoint: Text,
  tokenEndpoint: Text,
});
const Discovery = Schema.Struct({
  issuer: Text,
  userinfo_endpoint: Text,
  authorization_endpoint: Text,
  token_endpoint: Text,
});
const UserInfo = Schema.Struct({ sub: Text });
export const PEER_PERMISSION = "agent-bus:peer";
export const PeerGrant = Schema.Struct({
  subject: Text,
  resource: Text,
  permissions: Schema.Array(Schema.Literal(PEER_PERMISSION)),
});
export interface PeerInvocation {
  readonly auth?: { readonly authType: string; readonly accessToken?: string } | undefined;
  readonly signal: AbortSignal;
  readonly requestMeta?: Readonly<Record<string, unknown>> | undefined;
}
export interface PeerActor {
  readonly session?: string | undefined;
}

const validCorrelation = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 1024 &&
  value.trim().length > 0 &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Correlation is not authorization. The keyed tuple keeps raw identifiers off the Bus. */
export const peerSession = (key: Uint8Array, issuer: string, subject: string, chat: string) => {
  if (key.byteLength < 32 || !issuer || !subject || !validCorrelation(chat))
    throw new Error("Invalid peer identity.");
  return `hosted-${createHmac("sha256", key)
    .update(JSON.stringify(["agent-bus/hosted-peer/session/v1", issuer, subject, chat]))
    .digest("hex")}`;
};

export const clerkPeerResolver =
  (options: {
    readonly issuer: string;
    readonly principals: ReadonlyArray<{ readonly subject: string; readonly grantFile: string }>;
    readonly resource: string;
    readonly key: Uint8Array;
    readonly identify: (accessToken: string, signal: AbortSignal) => Promise<string>;
    readonly readGrant: (grantFile: string) => Promise<unknown>;
  }) =>
  async ({ auth, signal, requestMeta }: PeerInvocation): Promise<PeerActor> => {
    try {
      if (signal.aborted || auth?.authType !== "oauth" || !auth.accessToken) throw denied();
      const subject = await options.identify(auth.accessToken, signal);
      const principal = options.principals.find((entry) => entry.subject === subject);
      if (signal.aborted || principal === undefined) throw denied();
      const grant = Schema.decodeUnknownSync(PeerGrant, { onExcessProperty: "error" })(
        await options.readGrant(principal.grantFile)
      );
      if (
        signal.aborted ||
        grant.subject !== subject ||
        grant.resource !== options.resource ||
        !grant.permissions.includes(PEER_PERMISSION)
      )
        throw denied();
      const chat = requestMeta?.["openai/session"];
      return validCorrelation(chat)
        ? { session: peerSession(options.key, options.issuer, subject, chat) }
        : {};
    } catch {
      throw denied();
    }
  };
const denied = () => new Error("Peer access denied.");
const MAX_IDENTITY_BYTES = 16_384;
const IDENTITY_TIMEOUT = "5 seconds";

const canonicalHttps = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.href !== value && url.origin !== value)
  )
    throw denied();
  return url;
};

/** No redirects, retries, identity cache or raw provider error text. The scope owns the response body. */
const json = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.withScope(client).execute(request);
    if (response.status !== 200) return yield* Effect.fail(denied());
    const body = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
        (state, chunk) => {
          state.size += chunk.length;
          if (state.size > MAX_IDENTITY_BYTES) return Effect.fail(denied());
          state.chunks.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    return yield* Effect.try({
      try: (): unknown =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(body.chunks))),
      catch: denied,
    });
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", cache: "no-store" }),
    Effect.timeout(IDENTITY_TIMEOUT),
    Effect.mapError(denied)
  );

/** Pin discovery to the approved issuer and endpoints before the host binds. */
export const discoverProvider = (provider: typeof Provider.Type) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        const issuer = canonicalHttps(provider.issuer);
        if (issuer.origin !== provider.issuer) throw denied();
        for (const value of [
          provider.userInfo,
          provider.authorizationEndpoint,
          provider.tokenEndpoint,
        ]) {
          if (canonicalHttps(value).origin !== issuer.origin) throw denied();
        }
      },
      catch: denied,
    });
    const document = yield* json(
      HttpClientRequest.get(`${provider.issuer}/.well-known/openid-configuration`)
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Discovery)), Effect.mapError(denied));
    if (
      document.issuer !== provider.issuer ||
      document.userinfo_endpoint !== provider.userInfo ||
      document.authorization_endpoint !== provider.authorizationEndpoint ||
      document.token_endpoint !== provider.tokenEndpoint
    )
      return yield* Effect.fail(denied());
    return provider;
  });

/** UserInfo attests the accepted provider token and subject, not MCP audience or application scope. */
export const identifyOwner = (provider: typeof Provider.Type, accessToken: string) =>
  json(
    HttpClientRequest.get(provider.userInfo).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`)
    )
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UserInfo)),
    Effect.map((identity) => identity.sub),
    Effect.mapError(denied)
  );
