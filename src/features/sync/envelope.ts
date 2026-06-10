import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  ENVELOPE_FLAG_BROTLI,
  ENVELOPE_FLAG_NONE,
  ENVELOPE_VERSION,
  MIN_COMPRESSION_BYTES,
  SECRETS_PAD_BUCKET_BYTES,
} from './constants';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 2;

/**
 * Compress (optional) then AES-256-GCM encrypt.
 * Format: [1B version][1B flags][12B IV][16B tag][ciphertext]
 */
export function encodeEnvelope(plaintext: Buffer, vaultKey: Buffer): Buffer {
  let flags = ENVELOPE_FLAG_NONE;
  let payload = plaintext;

  if (plaintext.length >= MIN_COMPRESSION_BYTES) {
    const compressed = zlib.brotliCompressSync(plaintext, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    if (compressed.length < plaintext.length) {
      payload = compressed;
      flags = ENVELOPE_FLAG_BROTLI;
    }
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION, flags]),
    iv,
    tag,
    encrypted,
  ]);
}

/** Decrypt envelope and optionally decompress. Throws on auth failure or corrupt blob. */
export function decodeEnvelope(blob: Buffer, vaultKey: Buffer): Buffer {
  if (blob.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Envelope too short');
  }

  const version = blob[0];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }

  const flags = blob[1];
  const iv = blob.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const tag = blob.subarray(HEADER_LENGTH + IV_LENGTH, HEADER_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH + IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (flags === ENVELOPE_FLAG_BROTLI) {
    return zlib.brotliDecompressSync(decrypted);
  }
  if (flags === ENVELOPE_FLAG_NONE) {
    return decrypted;
  }

  throw new Error(`Unsupported compression flag: ${flags}`);
}

/** Pad secrets bundle to fixed bucket size to avoid length leakage. */
export function padSecretsBucket(plaintext: Buffer): Buffer {
  const bucket = Math.max(SECRETS_PAD_BUCKET_BYTES, Math.ceil(plaintext.length / SECRETS_PAD_BUCKET_BYTES) * SECRETS_PAD_BUCKET_BYTES);
  if (plaintext.length >= bucket) {
    return plaintext;
  }
  const padded = Buffer.alloc(bucket, 0);
  plaintext.copy(padded);
  return padded;
}

export function contentHash(plaintext: Buffer): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
