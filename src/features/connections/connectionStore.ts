import * as vscode from "vscode";
import type { CloudAuthContext } from "../../core/connection/cloudAuth/types";
import type { ConnectionPlatformPreset } from "../../lib/platform/connectionPresets";

export interface ConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  group?: string;
  // Safety & confidence features
  environment?: "production" | "staging" | "development";
  readOnlyMode?: boolean;
  // Advanced connection options
  sslmode?:
    | "disable"
    | "allow"
    | "prefer"
    | "require"
    | "verify-ca"
    | "verify-full";
  sslCertPath?: string;
  sslKeyPath?: string;
  sslRootCertPath?: string;
  statementTimeout?: number;
  connectTimeout?: number;
  applicationName?: string;
  options?: string;
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
  };
  /** Planned IAM flows; connections still use password or pgpass today. */
  cloudAuth?: CloudAuthContext;
  /** User-selected platform preset (connection form); used for hints and future detection. */
  platformPreset?: ConnectionPlatformPreset;
  /** Hide Supabase-managed schemas in the explorer. */
  hidePlatformSchemas?: boolean;
}

const CONNECTIONS_CONFIG_KEY = "postgresExplorer.connections";

export function getStoredConnections(): ConnectionInfo[] {
  return (
    vscode.workspace
      .getConfiguration()
      .get<ConnectionInfo[]>(CONNECTIONS_CONFIG_KEY) || []
  );
}

/**
 * Persist the connection list to Global settings (passwords stripped) and
 * store each provided password in SecretStorage.
 */
export async function writeConnectionsToWorkspace(
  extensionContext: vscode.ExtensionContext,
  connections: ConnectionInfo[],
): Promise<void> {
  try {
    const connectionsForSettings = connections.map(
      ({ password, ...connWithoutPassword }) => connWithoutPassword,
    );
    await vscode.workspace
      .getConfiguration()
      .update(
        CONNECTIONS_CONFIG_KEY,
        connectionsForSettings,
        vscode.ConfigurationTarget.Global,
      );

    const secretsStorage = extensionContext.secrets;
    for (const conn of connections) {
      if (conn.password) {
        await secretsStorage.store(
          `postgres-password-${conn.id}`,
          conn.password,
        );
      }
    }
  } catch (error) {
    console.error("Failed to store connections:", error);
    const existingConnections =
      vscode.workspace
        .getConfiguration()
        .get<ConnectionInfo[]>(CONNECTIONS_CONFIG_KEY) || [];
    const sanitizedConnections = existingConnections.map(
      ({ password, ...connWithoutPassword }) => connWithoutPassword,
    );
    await vscode.workspace
      .getConfiguration()
      .update(
        CONNECTIONS_CONFIG_KEY,
        sanitizedConnections,
        vscode.ConfigurationTarget.Global,
      );
    throw error;
  }
}

/** Append or replace a connection by id (password stored in SecretStorage). */
export async function appendWorkspaceConnection(
  extensionContext: vscode.ExtensionContext,
  connection: ConnectionInfo,
): Promise<void> {
  const existing = getStoredConnections();
  const merged = [
    ...existing.filter((c) => c.id !== connection.id),
    connection,
  ];
  await writeConnectionsToWorkspace(extensionContext, merged);
}
