import { Client } from "pg";
import * as fs from "fs";
import { SSHService } from "../../services/SSHService";
import {
  resolvePgPassPasswordAsync,
  pgPassFileDescription,
} from "../../utils/pgPassUtils";

/**
 * Connection testing extracted from the legacy ConnectionFormPanel so the
 * Settings Hub (and any other host-side caller) can validate connections with
 * identical semantics: TCP preflight, explicit pgpass resolution, SSL
 * downgrade retry (blocked on production), and a `postgres` database fallback
 * when the configured database does not exist yet (3D000).
 */

const DEFAULT_PORT = 5432;
const DEFAULT_CONNECT_TIMEOUT_S = 15;
const PREFLIGHT_TIMEOUT_BUFFER_S = 2;

/** Loosely-typed form payload — values arrive from the webview. */
export interface ConnectionTestInput {
  host: string;
  port: number | string;
  username?: string;
  password?: string;
  database?: string;
  environment?: string;
  sslmode?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  sslRootCertPath?: string;
  connectTimeout?: number | string;
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
  };
}

function buildClientConfig(
  connection: ConnectionTestInput,
  dbName: string,
  forceDisableSSL: boolean,
  overridePassword?: string,
): Record<string, unknown> {
  const effectivePassword =
    overridePassword !== undefined
      ? overridePassword
      : connection.password || undefined;
  const config: Record<string, unknown> = {
    user: connection.username || undefined,
    password: effectivePassword,
    database: dbName,
    connectionTimeoutMillis:
      (Number(connection.connectTimeout) || DEFAULT_CONNECT_TIMEOUT_S) * 1000,
  };

  if (!forceDisableSSL) {
    const sslMode = connection.sslmode || "prefer";
    if (sslMode !== "disable") {
      const sslConfig: Record<string, unknown> = {
        rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full",
      };
      try {
        if (connection.sslRootCertPath)
          sslConfig.ca = fs.readFileSync(connection.sslRootCertPath).toString();
        if (connection.sslCertPath)
          sslConfig.cert = fs.readFileSync(connection.sslCertPath).toString();
        if (connection.sslKeyPath)
          sslConfig.key = fs.readFileSync(connection.sslKeyPath).toString();
      } catch (e: unknown) {
        console.warn("Error reading SSL certs:", e);
      }
      config.ssl = sslConfig;
    }
  }
  return config;
}

async function preflightConnection(connection: ConnectionTestInput): Promise<void> {
  const host = String(connection.host || "").trim();
  if (!host) {
    throw new Error("Host is required.");
  }
  const port = Number.parseInt(String(connection.port), 10) || DEFAULT_PORT;
  const timeoutMs = Math.max(
    1000,
    ((Number.parseInt(String(connection.connectTimeout), 10) ||
      DEFAULT_CONNECT_TIMEOUT_S) +
      PREFLIGHT_TIMEOUT_BUFFER_S) *
      1000,
  );

  const sslMode = connection.sslmode || "prefer";
  if (sslMode === "verify-ca" || sslMode === "verify-full") {
    const requiredFiles: Array<{ key: keyof ConnectionTestInput; label: string }> = [
      { key: "sslRootCertPath", label: "CA certificate" },
    ];
    if (sslMode === "verify-full") {
      requiredFiles.push(
        { key: "sslCertPath", label: "Client certificate" },
        { key: "sslKeyPath", label: "Client key" },
      );
    }
    for (const file of requiredFiles) {
      const filePath = String(connection[file.key] || "").trim();
      if (!filePath) {
        throw new Error(
          `${file.label} path is required for SSL mode "${sslMode}".`,
        );
      }
      if (!fs.existsSync(filePath)) {
        throw new Error(`${file.label} file does not exist: ${filePath}.`);
      }
    }
  }

  if (!connection.ssh?.enabled) {
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done());
      socket.once("timeout", () =>
        done(
          new Error(
            `Connection timeout after ${Math.ceil(timeoutMs / 1000)}s reaching ${host}:${port}.`,
          ),
        ),
      );
      socket.once("error", (err: Error) =>
        done(
          new Error(
            `Cannot reach ${host}:${port}. ${err.message || "Network error."}`,
          ),
        ),
      );
      socket.connect(port, host);
    });
  }
}

async function attachTransport(
  connection: ConnectionTestInput,
  config: Record<string, unknown>,
): Promise<void> {
  if (connection.ssh && connection.ssh.enabled) {
    const stream = await SSHService.getInstance().createStream(
      connection.ssh,
      connection.host,
      Number(connection.port),
    );
    config.stream = stream;
  } else {
    config.host = connection.host;
    config.port = Number(connection.port);
  }
}

export interface ConnectionTestSuccess {
  version: string;
  serverVersionNum: number;
}

async function runOnce(
  config: Record<string, unknown>,
  isSave: boolean,
): Promise<ConnectionTestSuccess | true> {
  const client = new Client(config as any);
  await client.connect();
  try {
    if (isSave) {
      await client.query("SELECT 1");
      return true;
    }
    const result = await client.query<{
      version: string;
      server_version_num: string;
    }>(`
      SELECT
        version() AS version,
        current_setting('server_version_num') AS server_version_num
    `);
    const row = result.rows[0];
    return {
      version: row.version as string,
      serverVersionNum: Number(row.server_version_num) || 0,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Validate a connection. For `isSave` runs a lightweight `SELECT 1`; otherwise
 * returns the server `version()` string. Throws with user-facing messages on
 * failure (SSL downgrade block, pgpass guidance, unreachable host, …).
 */
export async function runConnectionTest(
  connection: ConnectionTestInput,
  isSave: boolean,
): Promise<ConnectionTestSuccess | true> {
  await preflightConnection(connection);

  // Always validate against the user's configured database so .pgpass
  // (host, port, database, user) matching keeps working; the 3D000 fallback
  // below handles a database that does not exist yet.
  const targetDb = connection.database || "postgres";
  const port = Number.parseInt(String(connection.port), 10) || DEFAULT_PORT;

  // Explicit pgpass resolution — bypasses pg's internal lookup, which can
  // silently fail (notably on Windows where %APPDATA%\postgresql\pgpass.conf
  // is expected instead of ~/.pgpass).
  let resolvedPassword: string | undefined = connection.password || undefined;
  if (!resolvedPassword && connection.username) {
    resolvedPassword = await resolvePgPassPasswordAsync(
      connection.host,
      port,
      targetDb,
      connection.username,
    );
    if (!resolvedPassword && targetDb !== "postgres") {
      resolvedPassword = await resolvePgPassPasswordAsync(
        connection.host,
        port,
        "postgres",
        connection.username,
      );
    }
  }

  let config = buildClientConfig(connection, targetDb, false, resolvedPassword);
  await attachTransport(connection, config);

  try {
    return await runOnce(config, isSave);
  } catch (initialErr: unknown) {
    let err = initialErr as Error & { code?: string };
    const sslMode = connection.sslmode || "prefer";
    const isSSLFailure =
      (err.message || "")
        .toString()
        .toLowerCase()
        .includes("server does not support ssl") ||
      err.code === "ECONNRESET" ||
      err.code === "EPROTO";

    if (
      connection.environment !== "production" &&
      (sslMode === "prefer" || sslMode === "allow") &&
      isSSLFailure
    ) {
      // Retry without SSL — keep using targetDb so .pgpass still matches
      config = buildClientConfig(connection, targetDb, true, resolvedPassword);
      await attachTransport(connection, config);
      try {
        return await runOnce(config, isSave);
      } catch (sslErr: unknown) {
        err = sslErr as Error & { code?: string };
      }
    } else if (connection.environment === "production" && isSSLFailure) {
      const enrichedError = new Error(
        `Production connection failed: ${err.message || "SSL connection failed"}.\n\n` +
          `Security Alert: NexQL blocked automatic SSL downgrade on a Production environment to protect your credentials. ` +
          `If your database does not support SSL or you are using a secure SSH tunnel, please expand Advanced Options and explicitly set SSL Mode to "Disable — No SSL".`,
      );
      (enrichedError as Error & { code?: string }).code = err.code;
      err = enrichedError as Error & { code?: string };
    }

    // Database fallback: if the configured database doesn't exist yet, retry
    // against 'postgres' so credentials can still be validated.
    if (err.code === "3D000" && targetDb !== "postgres") {
      let fallbackPassword = resolvedPassword;
      if (!fallbackPassword && connection.username) {
        fallbackPassword = await resolvePgPassPasswordAsync(
          connection.host,
          port,
          "postgres",
          connection.username,
        );
      }
      config = buildClientConfig(connection, "postgres", false, fallbackPassword);
      await attachTransport(connection, config);
      try {
        const result = await runOnce(config, isSave);
        if (isSave) {
          return true;
        }
        if (typeof result === 'object') {
          return {
            ...result,
            version: `${result.version} (connected to postgres database)`,
          };
        }
        return result;
      } catch {
        // Surface the original 3D000 error so the user knows their database
        // doesn't exist, rather than a confusing pgpass error for 'postgres'.
        throw err;
      }
    }

    // Friendly pgpass error: SCRAM fired with no password string — neither an
    // explicit password nor a pgpass match was found.
    if (
      err.message &&
      err.message.includes("client password must be a string")
    ) {
      const location = pgPassFileDescription();
      throw new Error(
        `No password found for this connection.\n\n` +
          `Either enter a password in the form, or add a matching entry to your pgpass file:\n` +
          `  ${location}\n\n` +
          `The entry format is:\n` +
          `  hostname:port:database:username:password\n\n` +
          `Example:\n` +
          `  ${connection.host}:${connection.port}:${targetDb}:${connection.username || "*"}:yourpassword`,
      );
    }
    throw err;
  }
}
