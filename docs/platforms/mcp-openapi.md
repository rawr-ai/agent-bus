# Owned direct-tool MCP host

What the checksum-pinned direct-tool host did in the private evidence fixture. The Bus's trust and disclosure rules are in [connections](../architecture/connections.md#private-evidence-facade); the disposable procedure is in [qualify private evidence](../runbooks/qualify-private-evidence.md).

## Direct host and HTTP admission

- **Verified in development, 2026-11-09:** the owned `mcp-openapi` 1.0.0 tarball identified below ran `serveTools` on Bun 1.4.4+38afee6c8. With the official MCP SDK 1.32.2 as client, closed input and output schemas and read-only annotations appeared on all four tools. Both text and structured carriers preserved the complete result. The escaped synthetic page measured 23,369 logical UTF-8 JSON bytes and 58,385 HTTP response-body bytes, not counting HTTP headers. This is not a ChatGPT wire or model-context limit.
- **Verified in development, 2026-11-09:** with `maxConcurrentWork: 1`, the direct host refused a five-request reconnect burst with HTTP 503 after a downstream disconnect, while the facade still owned one unanswered Bus exchange. Reads resumed when it settled. Native HTTP request close is not relied on to cancel upstream work.
- **Unverified:** a ChatGPT web client, secure tunnel, browser OAuth, real provider authorization and grant revocation timing. The fixture uses a synthetic provider proof and an API key at the loopback transport only; it does not demonstrate OAuth.

The owned artifact is `mcp-openapi-cdb182c1695db3bb.tgz`, SHA-256 `cdb182c1695db3bba023f6b85dadb2d3dbe63a9f15713e69bce9e512e311d428`, from the Breeze archive's owned vendor package. It is staged privately, not included in this repository. The [frame](../frames/private-chatgpt-web-mcp.md) gives the precedent and approval boundary.
