import crypto from "crypto";

const CURRENT_ALGORITHM = "aes-256-gcm";
const CURRENT_FORMAT_VERSION = "v2";
const CURRENT_IV_LENGTH = 12;
const CURRENT_AUTH_TAG_LENGTH = 16;

const LEGACY_ALGORITHM = "aes-256-cbc";
const LEGACY_IV_LENGTH = 16;

const HEX_PATTERN = /^[0-9a-f]+$/i;

const getEncryptionKey = (): Buffer | null => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) return null;
  const keyBuffer = Buffer.from(key, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be a 32-byte hex string (64 characters)",
    );
  }
  return keyBuffer;
};

function parseHex(value: string, label: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !HEX_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }

  return Buffer.from(value, "hex");
}

function decryptCurrentFormat(
  encryptedText: string,
  encryptionKey: Buffer,
): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 4 || parts[0] !== CURRENT_FORMAT_VERSION) {
    throw new Error("Invalid encrypted text format");
  }

  const [, ivHex, authTagHex, encryptedHex] = parts;
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid encrypted text format");
  }

  const iv = parseHex(ivHex, "IV");
  const authTag = parseHex(authTagHex, "auth tag");
  const encrypted = parseHex(encryptedHex, "ciphertext");

  if (iv.length !== CURRENT_IV_LENGTH) {
    throw new Error("Invalid encrypted text format");
  }

  if (authTag.length !== CURRENT_AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted text format");
  }

  const decipher = crypto.createDecipheriv(
    CURRENT_ALGORITHM,
    encryptionKey,
    iv,
  );
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function decryptLegacyFormat(
  encryptedText: string,
  encryptionKey: Buffer,
): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted text format");
  }

  const [ivHex, encryptedHex] = parts;
  if (!ivHex || !encryptedHex) {
    throw new Error("Invalid encrypted text format");
  }

  const iv = parseHex(ivHex, "IV");
  const encrypted = parseHex(encryptedHex, "ciphertext");

  if (iv.length !== LEGACY_IV_LENGTH) {
    throw new Error("Invalid encrypted text format");
  }

  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, encryptionKey, iv);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export const encrypt = (text: string): string => {
  if (!text) return text;
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  const iv = crypto.randomBytes(CURRENT_IV_LENGTH);
  const cipher = crypto.createCipheriv(CURRENT_ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${CURRENT_FORMAT_VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decrypt = (encryptedText: string): string => {
  if (!encryptedText) return encryptedText;
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  if (encryptedText.startsWith(`${CURRENT_FORMAT_VERSION}:`)) {
    return decryptCurrentFormat(encryptedText, encryptionKey);
  }

  return decryptLegacyFormat(encryptedText, encryptionKey);
};
