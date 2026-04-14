import crypto from "crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "./crypto";

const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const encryptionKeyHex =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterAll(() => {
  process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

beforeEach(() => {
  process.env.ENCRYPTION_KEY = encryptionKeyHex;
});

function encryptLegacy(text: string): string {
  const key = Buffer.from(encryptionKeyHex, "hex");
  const iv = Buffer.alloc(16, 7);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

describe("crypto helpers", () => {
  test("encrypts with authenticated v2 format and decrypts successfully", () => {
    const encrypted = encrypt("hello world");

    expect(encrypted.startsWith("v2:")).toBe(true);
    expect(decrypt(encrypted)).toBe("hello world");
  });

  test("decrypts legacy AES-256-CBC payloads", () => {
    const legacyEncrypted = encryptLegacy("legacy secret");

    expect(decrypt(legacyEncrypted)).toBe("legacy secret");
  });

  test("rejects tampered v2 ciphertext", () => {
    const encrypted = encrypt("protected secret");
    const [version, ivHex, authTagHex, encryptedHex] = encrypted.split(":");
    const tampered = `${version}:${ivHex}:${authTagHex}:${encryptedHex.slice(0, -2)}00`;

    expect(() => decrypt(tampered)).toThrow();
  });
});
