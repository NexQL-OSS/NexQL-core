import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { decodeEnvelope, encodeEnvelope } from './envelope';
import { SCRYPT_N, SCRYPT_P, SCRYPT_R } from './constants';
import { generateIdentityKeyPair, type IdentityKeyPair } from './shareCrypto';
import type { VaultManifest } from './types';

const VAULT_KEY_SECRET = 'postgresExplorer.sync.vaultKey';
const WRAPPED_VAULT_SECRET = 'postgresExplorer.sync.wrappedVaultKey';
const VAULT_MANIFEST_SECRET = 'postgresExplorer.sync.vaultManifest';
const IDENTITY_PUBLIC_SECRET = 'postgresExplorer.sync.identityPublicKey';
const IDENTITY_PRIVATE_SECRET = 'postgresExplorer.sync.identityPrivateKey';
const SECRET_KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 1Password-style vault: email + secret key → KEK → wrapped vault key. */
export class VaultService {
  private static instance: VaultService;
  private vaultKey: Buffer | null = null;
  private manifest: VaultManifest | null = null;

  private constructor(private readonly context: vscode.ExtensionContext) {}

  static getInstance(context?: vscode.ExtensionContext): VaultService {
    if (!VaultService.instance) {
      if (!context) {
        throw new Error('VaultService not initialized');
      }
      VaultService.instance = new VaultService(context);
    }
    return VaultService.instance;
  }

  static resetInstanceForTests(): void {
    VaultService.instance = undefined as unknown as VaultService;
  }

  isUnlocked(): boolean {
    return this.vaultKey !== null;
  }

  getGeneration(): string | undefined {
    return this.manifest?.generation;
  }

  getAccountEmail(): string | undefined {
    return this.manifest?.email;
  }

  /** Normalize email for scrypt salt. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Deterministic KEK from secret key + normalized email. */
  static deriveKek(secretKey: string, email: string): Buffer {
    const salt = Buffer.from(VaultService.normalizeEmail(email), 'utf8');
    return crypto.scryptSync(secretKey.trim().toUpperCase(), salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    });
  }

  /** Generate ~26 char base32 secret key for one-time display. */
  static generateSecretKey(length = 26): string {
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += SECRET_KEY_CHARS[bytes[i] % SECRET_KEY_CHARS.length];
    }
    return result;
  }

  /** Create a new vault; returns secret key (shown once) and generation id. */
  async createVault(email: string): Promise<{ secretKey: string; generation: string }> {
    const vaultKey = crypto.randomBytes(32);
    const secretKey = VaultService.generateSecretKey();
    const generation = crypto.randomUUID();
    const kek = VaultService.deriveKek(secretKey, email);
    const salt = crypto.randomBytes(16).toString('hex');

    const wrapped = encodeEnvelope(vaultKey, kek);
    this.manifest = {
      generation,
      wrappedVaultKey: wrapped.toString('base64'),
      salt,
      email: VaultService.normalizeEmail(email),
    };
    this.vaultKey = vaultKey;

    await this.context.secrets.store(VAULT_KEY_SECRET, vaultKey.toString('base64'));
    await this.context.secrets.store(WRAPPED_VAULT_SECRET, this.manifest.wrappedVaultKey);
    await this.context.secrets.store(VAULT_MANIFEST_SECRET, JSON.stringify(this.manifest));

    return { secretKey, generation };
  }

  /** Unlock vault with secret key; throws on GCM auth failure. */
  async unlock(secretKey: string, email?: string): Promise<void> {
    const raw = await this.context.secrets.get(VAULT_MANIFEST_SECRET);
    if (!raw) {
      throw new Error('No vault found. Set up sync first.');
    }
    this.manifest = JSON.parse(raw) as VaultManifest;
    const resolvedEmail = email ?? this.manifest.email;
    const kek = VaultService.deriveKek(secretKey, resolvedEmail);
    const wrapped = Buffer.from(this.manifest.wrappedVaultKey, 'base64');

    try {
      this.vaultKey = decodeEnvelope(wrapped, kek);
    } catch {
      throw new Error('Secret key is incorrect for this account');
    }

    await this.context.secrets.store(VAULT_KEY_SECRET, this.vaultKey.toString('base64'));
  }

  /** Load cached vault key from SecretStorage (post-unlock). */
  async tryLoadCachedKey(): Promise<boolean> {
    const cached = await this.context.secrets.get(VAULT_KEY_SECRET);
    const raw = await this.context.secrets.get(VAULT_MANIFEST_SECRET);
    if (!cached || !raw) {
      return false;
    }
    this.manifest = JSON.parse(raw) as VaultManifest;
    this.vaultKey = Buffer.from(cached, 'base64');
    return true;
  }

  /** Stop if remote vault generation differs from local. */
  async checkGeneration(remoteGeneration: string): Promise<'ok' | 'mismatch'> {
    if (!this.manifest) {
      const raw = await this.context.secrets.get(VAULT_MANIFEST_SECRET);
      if (raw) {
        this.manifest = JSON.parse(raw) as VaultManifest;
      }
    }
    if (!this.manifest?.generation) {
      return 'ok';
    }
    return this.manifest.generation === remoteGeneration ? 'ok' : 'mismatch';
  }

  getVaultKey(): Buffer {
    if (!this.vaultKey) {
      throw new Error('Vault is locked');
    }
    return this.vaultKey;
  }

  encrypt(plaintext: Buffer): Buffer {
    return encodeEnvelope(plaintext, this.getVaultKey());
  }

  decrypt(blob: Buffer): Buffer {
    return decodeEnvelope(blob, this.getVaultKey());
  }

  /**
   * The vault's X25519 identity keypair for team sharing. Lazily generated on
   * first use (so existing vaults gain a keypair on next unlock). The private
   * key is stored encrypted with the vault key; the public key is plaintext.
   */
  async getIdentityKeyPair(): Promise<IdentityKeyPair> {
    const pub = await this.context.secrets.get(IDENTITY_PUBLIC_SECRET);
    const wrappedPriv = await this.context.secrets.get(IDENTITY_PRIVATE_SECRET);
    if (pub && wrappedPriv) {
      const priv = this.decrypt(Buffer.from(wrappedPriv, 'base64')).toString('base64');
      return { publicKey: pub, privateKey: priv };
    }
    const pair = generateIdentityKeyPair();
    await this.context.secrets.store(IDENTITY_PUBLIC_SECRET, pair.publicKey);
    await this.context.secrets.store(
      IDENTITY_PRIVATE_SECRET,
      this.encrypt(Buffer.from(pair.privateKey, 'base64')).toString('base64'),
    );
    return pair;
  }

  async getIdentityPublicKey(): Promise<string> {
    return (await this.getIdentityKeyPair()).publicKey;
  }

  async getWrappedManifestForUpload(): Promise<VaultManifest | null> {
    const raw = await this.context.secrets.get(VAULT_MANIFEST_SECRET);
    return raw ? (JSON.parse(raw) as VaultManifest) : null;
  }

  async signOut(): Promise<void> {
    this.vaultKey = null;
    this.manifest = null;
    await this.context.secrets.delete(VAULT_KEY_SECRET);
    await this.context.secrets.delete(WRAPPED_VAULT_SECRET);
    await this.context.secrets.delete(VAULT_MANIFEST_SECRET);
    await this.context.secrets.delete(IDENTITY_PUBLIC_SECRET);
    await this.context.secrets.delete(IDENTITY_PRIVATE_SECRET);
  }
}
