import type { ConnectionConfig } from '../../common/types';

export type SentinelEnvironment = NonNullable<ConnectionConfig['environment']>;

export interface SentinelContext {
  environment: SentinelEnvironment;
  connectionId: string;
  connectionName: string;
  database: string;
  username: string;
  host: string;
  port: number;
  readOnlyMode: boolean;
}

export interface SentinelSettings {
  enabled: boolean;
  statusBarAccent: boolean;
  notebookContextStrip: boolean;
  chromeAccent: boolean;
  tabBadges: boolean;
  chatEnvChip: boolean;
  notifyOnTransition: boolean;
  themeSwapEnabled: boolean;
  themeSwapMode: 'suggest' | 'auto';
  themeSwapThemes: Record<string, string>;
}

export interface SentinelNotebookHeaderPayload {
  enabled: boolean;
  connectionName: string;
  host: string;
  port: number;
  database: string;
  username: string;
  environment?: SentinelEnvironment;
  readOnlyMode: boolean;
  isConnected: boolean;
}
