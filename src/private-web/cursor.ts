import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1.";
const PURPOSE = "agent-bus/private-web/cursor/v1";

/**
 * A native cursor can contain a withheld entry ID as its keyset position.
 * Keep it confidential as well as tamper-evident; the Bus still owns continuation validation.
 */
export const cursorCodec = (keyBytes: Uint8Array) => {
  if (keyBytes.length !== 32) throw new Error("Evidence cursor key must be 32 bytes.");
  const key = Buffer.from(keyBytes);
  return {
    seal(native: string): string {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(PURPOSE));
      const body = Buffer.concat([cipher.update(native, "utf8"), cipher.final()]);
      return VERSION + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    },
    open(token: string): string | undefined {
      if (!token.startsWith(VERSION) || token.length > 1500) return undefined;
      const data = Buffer.from(token.slice(VERSION.length), "base64url");
      if (
        VERSION + data.toString("base64url") !== token ||
        data.length <= NONCE_BYTES + TAG_BYTES
      ) {
        return undefined;
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(PURPOSE));
        decipher.setAuthTag(data.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(data.subarray(NONCE_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
};
