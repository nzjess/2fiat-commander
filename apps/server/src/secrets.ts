import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for 2fiat tokens and sids, and the HMAC that detects a token added twice. Both keys are
 * derived from one app secret (32+ random bytes, base64) with HKDF.
 */
export class Secrets {
  readonly #encryptionKey: Buffer;
  readonly #hmacKey: Buffer;

  constructor(appSecret: string) {
    const master = Buffer.from(appSecret, "base64");
    if (master.length < 32) throw new Error("the app secret must be at least 32 bytes, base64-encoded");
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, "", info, 32));
    this.#encryptionKey = derive("2fiat-commander/aes-256-gcm");
    this.#hmacKey = derive("2fiat-commander/hmac-sha256");
  }

  /** AES-256-GCM with a random IV, as `v1:<iv>:<ciphertext>:<tag>` in base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, ciphertext, cipher.getAuthTag()]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(":");
  }

  decrypt(encrypted: string): string {
    const [version, iv, ciphertext, tag] = encrypted.split(":");
    if (version !== "v1" || iv === undefined || ciphertext === undefined || tag === undefined) {
      throw new Error("not a v1 encrypted value");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  }

  /** A deterministic keyed hash, for finding equal secrets without decrypting them. */
  hash(value: string): string {
    return createHmac("sha256", this.#hmacKey).update(value).digest("base64url");
  }
}
