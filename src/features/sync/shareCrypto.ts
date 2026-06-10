import * as crypto from 'crypto';

/**
 * Asymmetric sharing primitives for team sync. Each vault owns an X25519
 * identity keypair. To share items, the owner encrypts them with a random
 * symmetric "share key" and seals that share key to each grantee's public key
 * (libsodium-style sealed box: ephemeral X25519 + HKDF + AES-256-GCM).
 *
 * Pure module — no vscode/fs imports — so it is unit-testable in isolation.
 */

const HKDF_INFO = Buffer.from('pgstudio-sync-share-v1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const X25519_RAW_LEN = 32;

export interface IdentityKeyPair {
  /** Raw 32-byte X25519 public key, base64. */
  publicKey: string;
  /** Raw 32-byte X25519 private key, base64. */
  privateKey: string;
}

function exportRawPublic(key: crypto.KeyObject): Buffer {
  // SPKI DER for X25519 ends with the 32-byte raw key.
  const der = key.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - X25519_RAW_LEN);
}

function exportRawPrivate(key: crypto.KeyObject): Buffer {
  // PKCS8 DER for X25519 ends with the 32-byte raw key.
  const der = key.export({ type: 'pkcs8', format: 'der' });
  return der.subarray(der.length - X25519_RAW_LEN);
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: 'der',
    type: 'spki',
  });
}

function privateKeyFromRaw(raw: Buffer): crypto.KeyObject {
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: exportRawPublic(publicKey).toString('base64'),
    privateKey: exportRawPrivate(privateKey).toString('base64'),
  };
}

function deriveSharedKey(shared: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  // Bind the derived key to both public keys to prevent key-reuse attacks.
  const salt = Buffer.concat([ephemeralPub, recipientPub]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

/**
 * Seal `plaintext` to a recipient's raw X25519 public key (base64).
 * Output: [32B ephemeral pub][12B IV][16B tag][ciphertext], base64.
 */
export function sealTo(recipientPublicKeyB64: string, plaintext: Buffer): string {
  const recipientPub = Buffer.from(recipientPublicKeyB64, 'base64');
  if (recipientPub.length !== X25519_RAW_LEN) {
    throw new Error('Invalid recipient public key');
  }
  const recipientKey = publicKeyFromRaw(recipientPub);

  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPubRaw = exportRawPublic(ephemeral.publicKey);
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const key = deriveSharedKey(shared, ephemeralPubRaw, recipientPub);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([ephemeralPubRaw, iv, tag, ct]).toString('base64');
}

/** Open a sealed blob with the recipient's raw X25519 private key (base64). */
export function openSealed(recipientPrivateKeyB64: string, sealedB64: string): Buffer {
  const recipientPrivRaw = Buffer.from(recipientPrivateKeyB64, 'base64');
  if (recipientPrivRaw.length !== X25519_RAW_LEN) {
    throw new Error('Invalid recipient private key');
  }
  const blob = Buffer.from(sealedB64, 'base64');
  if (blob.length < X25519_RAW_LEN + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Sealed blob too short');
  }

  const ephemeralPubRaw = blob.subarray(0, X25519_RAW_LEN);
  const iv = blob.subarray(X25519_RAW_LEN, X25519_RAW_LEN + IV_LENGTH);
  const tag = blob.subarray(X25519_RAW_LEN + IV_LENGTH, X25519_RAW_LEN + IV_LENGTH + TAG_LENGTH);
  const ct = blob.subarray(X25519_RAW_LEN + IV_LENGTH + TAG_LENGTH);

  const recipientPriv = privateKeyFromRaw(recipientPrivRaw);
  const recipientPubRaw = exportRawPublic(crypto.createPublicKey(recipientPriv));
  const shared = crypto.diffieHellman({
    privateKey: recipientPriv,
    publicKey: publicKeyFromRaw(ephemeralPubRaw),
  });
  const key = deriveSharedKey(shared, ephemeralPubRaw, recipientPubRaw);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Random symmetric share key (AES-256), base64. */
export function generateShareKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

/** Encrypt item plaintext with a share key. Output base64: [12B IV][16B tag][ct]. */
export function encryptWithShareKey(shareKeyB64: string, plaintext: Buffer): string {
  const key = Buffer.from(shareKeyB64, 'base64');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptWithShareKey(shareKeyB64: string, blobB64: string): Buffer {
  const key = Buffer.from(shareKeyB64, 'base64');
  const blob = Buffer.from(blobB64, 'base64');
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
