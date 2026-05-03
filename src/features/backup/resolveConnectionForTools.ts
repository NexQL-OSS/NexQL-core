import { Client } from 'ssh2';
import * as fs from 'fs';
import * as net from 'net';
import type { ConnectionConfig } from '../../common/types';

export interface ResolvedToolConnection {
  host: string;
  port: number;
  env: NodeJS.ProcessEnv;
  username: string;
  dispose: () => void;
}

/** Libpq-compatible env for pg_dump / pg_restore / pg_dumpall child processes. */
export function buildLibpqEnv(config: ConnectionConfig, password?: string): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (password) {
    env.PGPASSWORD = password;
  }
  const mode = config.sslmode || 'prefer';
  env.PGSSLMODE = mode;
  if (config.sslCertPath) {
    env.PGSSLCERT = config.sslCertPath;
  }
  if (config.sslKeyPath) {
    env.PGSSLKEY = config.sslKeyPath;
  }
  if (config.sslRootCertPath) {
    env.PGSSLROOTCERT = config.sslRootCertPath;
  }
  return env;
}

function connectSshClient(ssh: NonNullable<ConnectionConfig['ssh']>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.once('ready', () => resolve(conn));
    conn.once('error', err => reject(err));
    const connectConfig: import('ssh2').ConnectConfig = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username
    };
    if (ssh.privateKeyPath) {
      try {
        connectConfig.privateKey = fs.readFileSync(ssh.privateKeyPath);
      } catch (e) {
        reject(new Error(`Failed to read SSH private key at ${ssh.privateKeyPath}: ${e}`));
        return;
      }
    }
    conn.connect(connectConfig);
  });
}

/**
 * Resolves host/port for CLI tools. Non-SSH: config host/port. SSH: local TCP forward to DB via ssh2 forwardOut.
 */
export async function resolveConnectionForTools(
  config: ConnectionConfig,
  dbPassword: string | undefined
): Promise<ResolvedToolConnection> {
  const env = buildLibpqEnv(config, dbPassword);
  const username = config.username || process.env.PGUSER || process.env.USER || 'postgres';

  if (!config.ssh?.enabled) {
    return {
      host: config.host,
      port: config.port,
      env,
      username,
      dispose: () => {}
    };
  }

  const conn = await connectSshClient(config.ssh);
  const dbHost = config.host;
  const dbPort = config.port;

  const server = net.createServer(socket => {
    conn.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      dbHost,
      dbPort,
      (err, stream) => {
        if (err || !stream) {
          socket.destroy();
          return;
        }
        socket.pipe(stream as NodeJS.ReadWriteStream).pipe(socket);
        stream.on('close', () => socket.destroy());
        socket.on('close', () => stream.destroy());
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const localPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  if (!localPort) {
    server.close();
    conn.end();
    throw new Error('Failed to bind local forward port');
  }

  return {
    host: '127.0.0.1',
    port: localPort,
    env,
    username,
    dispose: () => {
      server.close();
      conn.end();
    }
  };
}

/** Prepends -h -p -U after command name for pg_* tools. */
export function prependConnectionArgs(argv: string[], resolved: ResolvedToolConnection): string[] {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    throw new Error('Invalid argv');
  }
  return [cmd, '-h', resolved.host, '-p', String(resolved.port), '-U', resolved.username, ...rest];
}
