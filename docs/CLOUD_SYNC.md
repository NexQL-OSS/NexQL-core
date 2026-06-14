# Cloud Sync

PgStudio Cloud Sync keeps your **connections**, **saved queries**, and **SQL notebooks** consistent across machines and editors (VS Code, Cursor, Windsurf, and other VS Code–compatible forks). Data is **encrypted on your device** before it leaves your machine — storage backends only see opaque blobs.

**Plan matrix:**

| Plan | Backends | Trigger | Devices |
|------|----------|---------|---------|
| **Free** | Shared Postgres (your own DB) | Manual **Sync Now** only | 1 — backup is bound to a single device |
| **Sponsor** | + **NexQL Cloud**, GitHub Gist, OneDrive, Google Drive | Automatic + manual | Multi-device (same user) |
| **Teams (Singularity)** | Same as Sponsor + team sharing | Automatic + manual | Multi-device + team sharing |

On the free plan the backup is bound to the first device that syncs. A different device can **claim** the backup (the old device stops syncing) at most once per week — upgrade to [Sponsor or Teams](https://nexql.astrx.dev/#pricing) for true multi-device sync.

---

## What syncs

| Item | Included | Notes |
|------|----------|-------|
| Connection profiles | Yes (default) | Host, port, user, database, SSL mode, environment tag, SSH host settings |
| Saved queries | Yes (default) | Full query text and metadata |
| Notebooks (`.pgsql`) | Yes (default) | **Cells only** — SQL and markdown content, not execution outputs |
| Passwords | Opt-in only | Encrypted secrets bundle; off by default |

Sync uses a merge model: changes from any signed-in device are combined. Conflicts are surfaced in the status bar.

---

## What does **not** sync

- **Database passwords** — unless you explicitly opt in during setup
- **SSL certificate paths**, **SSH private key paths** — machine-local; each device keeps its own paths via per-device overrides
- **Notebook outputs** — query results, charts, and EXPLAIN visualizations stay local
- **Extension settings** — only the sync-related settings you configure during setup

---

## End-to-end encryption

PgStudio encrypts sync data with a **client-side vault**:

1. **Vault key** — random 256-bit key used to encrypt all sync payloads (AES-256-GCM).
2. **Secret key** — auto-generated (~26 characters) when you create a vault, or a **custom passphrase** if you prefer. Shown **once** at setup.
3. **Key-encryption key (KEK)** — derived via scrypt from your secret + a random salt stored in the vault manifest (v2). Legacy vaults used account email as the salt.
4. **Unlock** — on each device, enter your secret key (and account email only for legacy vaults).

**On the wire:** payloads are optionally Brotli-compressed (for larger items), then encrypted. Storage providers never receive plaintext connection details or query text.

If you lose your **secret key**, encrypted data **cannot be recovered** — not by PgStudio, not by your storage provider. Save the recovery kit when prompted.

---

## NexQL Cloud sign-in

| Method | When |
|--------|------|
| **Enable Cloud Sync** (default) | Extension uses your activated Sponsor/Teams license — no browser step |
| **Authorize in browser** | Optional confirm step at [device-auth.html](https://nexql.astrx.dev/device-auth.html) — license is pre-bound; click once to authorize |

---

## Cross-editor support

Sync is editor-agnostic. Install NexQL/PgStudio in any VS Code–compatible editor, run the same setup wizard, unlock with the same secret key, and point at the same storage backend. GitHub Gist works well when built-in GitHub authentication is available; other backends use OAuth device or loopback flows.

---

## Getting started

### 1. Run the setup wizard

Open the Command Palette and run:

**`NexQL Sync: Set Up Sync`** (`postgres-explorer.sync.setup`)

Or use the walkthrough: **Set up PgStudio Sync** (from the Welcome / Getting Started experience).

### 2. Choose a storage backend

| Backend | Plan | Best for |
|---------|------|----------|
| **Shared Postgres** | Free+ | Your own DB; `pgstudio_sync` schema |
| **GitHub Gist** | Sponsor+ | Quick start; private gist; works in most editors |
| **OneDrive** | Sponsor+ | Microsoft 365 users; files in app folder |
| **Google Drive** | Sponsor+ | Google accounts; `drive.appdata` hidden folder |
| **NexQL Cloud** | Sponsor+ | Hosted sync on [nexql.astrx.dev](https://nexql.astrx.dev) — default for paid plans |

### 3. Create or unlock your vault

- **First device:** choose **Create new vault** — a secret key is generated automatically (or set a custom passphrase). **Save the secret key** (copy or save recovery kit).
- **New device:** choose **Unlock existing vault** and enter the secret key from your recovery kit. Legacy vaults also require the account email used at creation.

### 4. Choose what to sync

Pick connections, saved queries, notebooks, and optionally passwords. A first sync runs automatically when setup completes.

---

## Day-to-day use

| Action | Command |
|--------|---------|
| Sync now | **`NexQL Sync: Sync Now`** (`postgres-explorer.sync.now`) |
| Status / menu | Click the **$(cloud)** item in the status bar, or **`NexQL Sync: Sync Menu`** |
| Pause / resume | **`NexQL Sync: Pause Sync`** |
| Sign out | **`NexQL Sync: Sign Out of Sync`** — local data kept; clears local vault session |

### Settings

Configure in **Settings → PostgreSQL Explorer → Sync**:

| Setting | Purpose |
|---------|---------|
| `postgresExplorer.sync.auto` | Automatic debounced push and periodic pull (default: on) |
| `postgresExplorer.sync.pullIntervalMinutes` | How often to pull remote changes (default: 5) |
| `postgresExplorer.sync.notebookFolder` | Local folder for synced `.pgsql` notebooks (default: `~/PgStudioNotebooks`) |
| `postgresExplorer.sync.postgresConnectionId` | Connection ID for Shared Postgres backend |
| `postgresExplorer.sync.apiEndpoint` | NexQL Cloud API base URL |
| `postgresExplorer.sync.githubClientId` | GitHub OAuth app (device-flow fallback) |
| `postgresExplorer.sync.onedriveClientId` | Entra app ID for OneDrive |
| `postgresExplorer.sync.googleClientId` | Google OAuth client for Drive |

---

## Team sharing (Teams)

Teams-tier users on the **NexQL Cloud** backend can share **notebooks** and **saved queries** with other team members — without sharing connections, credentials, or the secrets bundle.

- **Identity:** each vault holds an X25519 keypair. The private key is encrypted with your vault key; the public key is published to NexQL Cloud, keyed by your account email.
- **Sharing:** run **`NexQL Sync: Share Items with a Team Member`** — pick items, enter the recipient's account email. Items are scrubbed of connection ids, hosts, usernames and the owner's sync id, encrypted with a one-time share key, and that key is sealed to the recipient's public key (X25519 + HKDF + AES-256-GCM). The server never sees plaintext or the share key.
- **Importing:** the recipient runs **`NexQL Sync: Import Shared Items`**, picks items, then chooses **Merge into my library** (re-imports update in place) or **Import as new copies** (detached). They may attach one of **their own** connections — never the owner's.
- **Revoking:** owners can revoke a share; revoked shares disappear from the recipient's list (already-imported copies are local and stay).

Sharing requires the NexQL Cloud backend (the only backend with a broker for public-key exchange) and a Teams subscription.

---

## License

Activate a license with **`NexQL: Activate License`** (`postgres-explorer.license.activate`). Manage status with **`NexQL: Manage License`**.

If your plan does not include the configured backend (e.g. after a downgrade), sync stops with an upgrade prompt. NexQL Cloud data is kept for **30 days** while inactive, then deleted. Choose **View Plans** to open [pricing](https://nexql.astrx.dev/#pricing).

---

## Known limitations

| Limitation | Detail |
|------------|--------|
| **Lost secret key** | Encrypted vault cannot be decrypted. Create a new vault and re-sync from a device that still has access, or restore from an unencrypted export if you made one. |
| **Email change** | The vault KEK is derived from your email + secret key. Changing email requires unlocking with the original email or re-creating the vault. |
| **GitHub Gist size** | Each gist file is limited to **1 MB**. Very large notebooks may be skipped with a warning. |
| **Google Drive** | Production use may require [Google OAuth app verification](https://developers.google.com/identity/protocols/oauth2/production-readiness). |
| **Downgraded license** | If your subscription lapses, backends above your tier stop syncing. NexQL Cloud data is kept for **30 days** while inactive, then deleted. Renew or switch to a free Postgres backup. |
| **Free single-device** | Free-tier backups are device-bound; claiming a backup on a new device is limited to once per week. |

---

## Security summary

- Zero-knowledge style: backends store encrypted blobs only.
- Passwords are opt-in and padded to fixed bucket sizes when synced to reduce metadata leakage.
- Machine-local file paths (certs, keys) never leave the device in connection profiles.
- Team sharing uses per-vault X25519 keypairs and sealed-box encryption; the server brokers public keys and stores sealed blobs only. Connections and the secrets bundle are never shareable.

For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
