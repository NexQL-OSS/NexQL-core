import { Client } from "pg";
import * as vscode from "vscode";
import * as fs from "fs";
import { SSHService } from "./services/SSHService";
import { ConnectionManager } from "./services/ConnectionManager";
import {
  resolvePgPassPasswordAsync,
  pgPassFileDescription,
} from "./utils/pgPassUtils";

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
}

export class ConnectionFormPanel {
  public static currentPanel: ConnectionFormPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly _extensionContext: vscode.ExtensionContext,
    private readonly _connectionToEdit?: ConnectionInfo,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._initialize();

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        // Helper to build client config with SSL
        const buildClientConfig = (
          connection: any,
          dbName: string,
          forceDisableSSL: boolean,
          overridePassword?: string,
        ) => {
          // Use the explicitly-resolved password (from pgpass lookup or the
          // form field) when provided; otherwise fall back to the form value.
          const effectivePassword =
            overridePassword !== undefined
              ? overridePassword
              : connection.password || undefined;
          const config: any = {
            user: connection.username || undefined,
            password: effectivePassword,
            database: dbName,
            connectionTimeoutMillis: (connection.connectTimeout || 15) * 1000,
          };

          if (!forceDisableSSL) {
            const sslMode = connection.sslmode || "prefer"; // Default to prefer
            if (sslMode !== "disable") {
              const sslConfig: any = {
                rejectUnauthorized:
                  sslMode === "verify-ca" || sslMode === "verify-full",
              };
              try {
                if (connection.sslRootCertPath)
                  sslConfig.ca = fs
                    .readFileSync(connection.sslRootCertPath)
                    .toString();
                if (connection.sslCertPath)
                  sslConfig.cert = fs
                    .readFileSync(connection.sslCertPath)
                    .toString();
                if (connection.sslKeyPath)
                  sslConfig.key = fs
                    .readFileSync(connection.sslKeyPath)
                    .toString();
              } catch (e: any) {
                console.warn("Error reading SSL certs:", e);
              }
              config.ssl = sslConfig;
            }
          }
          return config;
        };

        const runTest = async (connection: any, isSave: boolean) => {
          // Always use the user's configured database for both test and save
          // validation. Previously, save validation hardcoded 'postgres', which
          // broke .pgpass: pg reads ~/.pgpass by matching (host, port, database,
          // user). Forcing 'postgres' caused a mismatch when the .pgpass entry
          // specifies the user's actual database, so pgpass returned no password
          // and PostgreSQL rejected the connection with "empty password returned
          // by client". The 3D000 fallback below still handles the case where
          // the configured database does not yet exist.
          const targetDb = connection.database || "postgres";

          // ── Explicit pgpass resolution ───────────────────────────────────
          // When the user leaves the password field empty (relying on a pgpass
          // file), the pg library's *internal* pgpass lookup can silently fail
          // — most commonly on Windows where the expected path is
          //   %APPDATA%\postgresql\pgpass.conf
          // rather than ~/.pgpass.  If that lookup returns undefined, pg keeps
          // the password as null and SCRAM authentication throws:
          //   "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"
          //
          // By resolving the pgpass password ourselves *before* constructing
          // the Client we can:
          //   1. Pass it explicitly, bypassing pg's internal lookup entirely.
          //   2. Emit a clear error that includes the expected file path when
          //      neither an explicit password nor a pgpass match is found.
          let resolvedPassword: string | undefined =
            connection.password || undefined;
          if (!resolvedPassword && connection.username) {
            resolvedPassword = await resolvePgPassPasswordAsync(
              connection.host,
              parseInt(String(connection.port), 10) || 5432,
              targetDb,
              connection.username,
            );

            // If pgpass didn't match for the target db, also try the postgres
            // fallback db (mirrors the 3D000 retry below, but at the pgpass
            // lookup stage so we can detect a credential problem early).
            if (!resolvedPassword && targetDb !== "postgres") {
              resolvedPassword = await resolvePgPassPasswordAsync(
                connection.host,
                parseInt(String(connection.port), 10) || 5432,
                "postgres",
                connection.username,
              );
            }
          }

          let config = buildClientConfig(
            connection,
            targetDb,
            false,
            resolvedPassword,
          );

          if (connection.ssh && connection.ssh.enabled) {
            const stream = await SSHService.getInstance().createStream(
              connection.ssh,
              connection.host,
              connection.port,
            );
            config.stream = stream;
          } else {
            config.host = connection.host;
            config.port = connection.port;
          }

          let client = new Client(config);
          try {
            await client.connect();
            if (isSave) {
              await client.query("SELECT 1");
            } else {
              const result = await client.query("SELECT version()");
              return result.rows[0].version;
            }
            await client.end();
            return true;
          } catch (err: any) {
            // fallbacks
            const sslMode = connection.sslmode || "prefer";
            const isSSLFailure =
              (err.message || "")
                .toString()
                .toLowerCase()
                .includes("server does not support ssl") ||
              err.code === "ECONNRESET" ||
              err.code === "EPROTO";

            if ((sslMode === "prefer" || sslMode === "allow") && isSSLFailure) {
              // Retry without SSL - keep using targetDb so .pgpass still matches
              config = buildClientConfig(
                connection,
                targetDb,
                true,
                resolvedPassword,
              );
              if (connection.ssh && connection.ssh.enabled) {
                const stream = await SSHService.getInstance().createStream(
                  connection.ssh,
                  connection.host,
                  connection.port,
                );
                config.stream = stream;
              } else {
                config.host = connection.host;
                config.port = connection.port;
              }

              client = new Client(config);
              try {
                await client.connect();
                if (isSave) {
                  await client.query("SELECT 1");
                } else {
                  const result = await client.query("SELECT version()");
                  return result.rows[0].version;
                }
                await client.end();
                return true;
              } catch (sslErr: any) {
                err = sslErr;
              }
            }

            // Database fallback: if the configured database doesn't exist yet,
            // retry against 'postgres' so credentials can still be validated.
            // This applies to both test and save — for save the connection is
            // stored with the original database name (it may be created later).
            if (err.code === "3D000" && targetDb !== "postgres") {
              // Re-resolve pgpass for the 'postgres' database specifically,
              // in case the entry was wildcarded or the earlier targetDb lookup
              // returned nothing but a postgres entry exists.
              let fallbackPassword = resolvedPassword;
              if (!fallbackPassword && connection.username) {
                fallbackPassword = await resolvePgPassPasswordAsync(
                  connection.host,
                  parseInt(String(connection.port), 10) || 5432,
                  "postgres",
                  connection.username,
                );
              }
              config = buildClientConfig(
                connection,
                "postgres",
                false,
                fallbackPassword,
              );
              if (connection.ssh && connection.ssh.enabled) {
                const stream = await SSHService.getInstance().createStream(
                  connection.ssh,
                  connection.host,
                  connection.port,
                );
                config.stream = stream;
              } else {
                config.host = connection.host;
                config.port = connection.port;
              }

              client = new Client(config);
              try {
                await client.connect();
                if (isSave) {
                  await client.query("SELECT 1");
                  await client.end();
                  return true;
                }
                const result = await client.query("SELECT version()");
                await client.end();
                return (
                  result.rows[0].version + " (connected to postgres database)"
                );
              } catch (fallbackErr: any) {
                // If the fallback fails, throw the original 3D000 error so the
                // user knows their database doesn't exist, rather than confusing
                // them with a pgpass error for the 'postgres' database.
                throw err;
              }
            }
            // ── Friendly pgpass error ────────────────────────────────────
            // When SCRAM authentication fires and pg has no password string
            // it means: no explicit password was given AND our own pgpass
            // lookup returned nothing.  Surface the expected file path so
            // the user knows exactly where to put the pgpass entry.
            if (
              err.message &&
              (err.message as string).includes(
                "client password must be a string",
              )
            ) {
              const { pgPassFileDescription } =
                await import("./utils/pgPassUtils");
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
        };

        switch (message.command) {
          case "testConnection":
            try {
              const version = await runTest(message.connection, false);
              this._panel.webview.postMessage({
                type: "testSuccess",
                version: version,
              });
            } catch (err: any) {
              this._panel.webview.postMessage({
                type: "testError",
                error: err.message,
              });
            }
            break;

          case "saveConnection":
            try {
              await runTest(message.connection, true);

              const connections = this.getStoredConnections();
              const newConnection: ConnectionInfo = {
                id: this._connectionToEdit
                  ? this._connectionToEdit.id
                  : Date.now().toString(),
                name: message.connection.name,
                host: message.connection.host,
                port: message.connection.port,
                username: message.connection.username || undefined,
                password: message.connection.password || undefined,
                database: message.connection.database,
                group: message.connection.group || undefined,
                // Safety & confidence features
                environment: message.connection.environment || undefined,
                readOnlyMode: message.connection.readOnlyMode || undefined,
                // Advanced options
                sslmode: message.connection.sslmode || undefined,
                sslCertPath: message.connection.sslCertPath || undefined,
                sslKeyPath: message.connection.sslKeyPath || undefined,
                sslRootCertPath:
                  message.connection.sslRootCertPath || undefined,
                statementTimeout:
                  message.connection.statementTimeout || undefined,
                connectTimeout: message.connection.connectTimeout || undefined,
                applicationName:
                  message.connection.applicationName || undefined,
                options: message.connection.options || undefined,
                ssh: message.connection.ssh,
              };

              if (this._connectionToEdit) {
                const index = connections.findIndex(
                  (c) => c.id === this._connectionToEdit!.id,
                );
                if (index !== -1) {
                  connections[index] = newConnection;
                } else {
                  connections.push(newConnection);
                }
              } else {
                connections.push(newConnection);
              }

              await this.storeConnections(connections);

              // Close any active connections for this ID to ensure pool is refreshed with new settings
              try {
                // Use the ID of the connection we just saved
                await ConnectionManager.getInstance().closeAllConnectionsById(
                  newConnection.id,
                );
              } catch (e) {
                console.error("Failed to close stale connections:", e);
              }

              vscode.window.showInformationMessage(
                `Connection ${this._connectionToEdit ? "updated" : "saved"} successfully!`,
              );
              vscode.commands.executeCommand(
                "postgres-explorer.refreshConnections",
              );
              this._panel.dispose();
            } catch (err: any) {
              const errorMessage = err?.message || "Unknown error occurred";
              vscode.window.showErrorMessage(
                `Failed to connect: ${errorMessage}`,
              );
            }
            break;
        }
      },
      undefined,
      this._disposables,
    );
  }

  public static show(
    extensionUri: vscode.Uri,
    extensionContext: vscode.ExtensionContext,
    connectionToEdit?: ConnectionInfo,
  ) {
    if (ConnectionFormPanel.currentPanel) {
      // Check if we are switching contexts (Add <-> Edit) or Edit <-> Edit (different ID)
      const current = ConnectionFormPanel.currentPanel;
      const currentId = current._connectionToEdit?.id;
      const newId = connectionToEdit?.id;

      if (currentId !== newId) {
        // Context switch detected - dispose old panel so we create a fresh one
        current.dispose();
      } else {
        // Same context - just reveal
        current._panel.reveal();
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "connectionForm",
      connectionToEdit ? "Edit Connection" : "Add PostgreSQL Connection",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
      },
    );

    ConnectionFormPanel.currentPanel = new ConnectionFormPanel(
      panel,
      extensionUri,
      extensionContext,
      connectionToEdit,
    );
  }

  private async _initialize() {
    // The message handler is already set up in the constructor
    await this._update();
  }

  private async _update() {
    this._panel.webview.html = await this._getHtmlForWebview(
      this._panel.webview,
    );
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const logoPath = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "resources",
        "postgres-vsc-icon.png",
      ),
    );
    const nonce = this._getNonce();
    const cspSource = webview.cspSource;

    let connectionData: any = null;
    if (this._connectionToEdit) {
      // Get the password from secret storage
      const password = await this._extensionContext.secrets.get(
        `postgres-password-${this._connectionToEdit.id}`,
      );
      connectionData = {
        ...this._connectionToEdit,
        password,
      };
    }

    // Dynamic content for placeholders
    const pageTitle = this._connectionToEdit
      ? "Edit Connection"
      : "Add PostgreSQL Connection";
    const headerTitle = this._connectionToEdit
      ? "Edit Connection"
      : "New Connection";
    const submitButtonText = this._connectionToEdit
      ? "Save Changes"
      : "Add Connection";

    try {
      // Load template files
      const templatesDir = vscode.Uri.joinPath(
        this._extensionUri,
        "templates",
        "connection-form",
      );

      const [htmlBuffer, cssBuffer, jsBuffer] = await Promise.all([
        vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(templatesDir, "index.html"),
        ),
        vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(templatesDir, "styles.css"),
        ),
        vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(templatesDir, "scripts.js"),
        ),
      ]);

      let html = new TextDecoder().decode(htmlBuffer);
      const css = new TextDecoder().decode(cssBuffer);
      let js = new TextDecoder().decode(jsBuffer);

      // Build CSP string
      const csp = `default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

      // Replace JavaScript placeholder for connection data with regex to be safe against spacing issues
      // const connectionDataJs = JSON.stringify(connectionData) || 'null';
      // js = js.replace(/{{\s*CONNECTION_DATA\s*}}/, () => connectionDataJs);
      // Safe replacement using a function to avoid special replacement patterns in the data string
      js = js.replace(
        /{{\s*CONNECTION_DATA\s*}}/,
        () => JSON.stringify(connectionData) || "null",
      );
      console.log("Connection form template loaded and processed");

      // Replace HTML placeholders
      html = html.replace("{{CSP}}", csp);
      html = html.replace("{{INLINE_STYLES}}", () => css);
      html = html.replace("{{INLINE_SCRIPTS}}", () => js);
      html = html.replace(/\{\{NONCE\}\}/g, nonce);
      html = html.replace("{{LOGO_URI}}", logoPath.toString());
      html = html.replace("{{PAGE_TITLE}}", () => pageTitle);
      html = html.replace("{{HEADER_TITLE}}", () => headerTitle);
      html = html.replace("{{SUBMIT_BUTTON_TEXT}}", () => submitButtonText);

      return html;
    } catch (error) {
      console.error("Failed to load connection form templates:", error);
      return `<!DOCTYPE html>
      <html>
      <body>
        <h1>Error loading Connection Form</h1>
        <p>Could not load template files. Please check that the extension is installed correctly.</p>
        <p>Error: ${error instanceof Error ? error.message : String(error)}</p>
      </body>
      </html>`;
    }
  }

  private _getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getStoredConnections(): ConnectionInfo[] {
    const connections =
      vscode.workspace
        .getConfiguration()
        .get<ConnectionInfo[]>("postgresExplorer.connections") || [];
    return connections;
  }

  private async storeConnections(connections: ConnectionInfo[]): Promise<void> {
    try {
      // First store the connections without passwords in settings
      const connectionsForSettings = connections.map(
        ({ password, ...connWithoutPassword }) => connWithoutPassword,
      );
      await vscode.workspace
        .getConfiguration()
        .update(
          "postgresExplorer.connections",
          connectionsForSettings,
          vscode.ConfigurationTarget.Global,
        );

      // Then store passwords in SecretStorage
      const secretsStorage = this._extensionContext.secrets;
      for (const conn of connections) {
        if (conn.password) {
          // Removed logging of sensitive connection information for security.
          await secretsStorage.store(
            `postgres-password-${conn.id}`,
            conn.password,
          );
        }
      }
    } catch (error) {
      console.error("Failed to store connections:", error);
      // If anything fails, make sure we don't leave passwords in settings
      const existingConnections =
        vscode.workspace
          .getConfiguration()
          .get<any[]>("postgresExplorer.connections") || [];
      const sanitizedConnections = existingConnections.map(
        ({ password, ...connWithoutPassword }) => connWithoutPassword,
      );
      await vscode.workspace
        .getConfiguration()
        .update(
          "postgresExplorer.connections",
          sanitizedConnections,
          vscode.ConfigurationTarget.Global,
        );
      throw error;
    }
  }

  private dispose() {
    ConnectionFormPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
