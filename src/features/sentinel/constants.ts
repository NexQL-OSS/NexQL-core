import type { SentinelEnvironment } from './types';

/** Notebook cell metadata role for the optional Sentinel context strip cell. */
export const SENTINEL_HEADER_CELL_ROLE = 'pgstudio.sentinelHeader';

/** Per-notebook opt-out for the in-editor context strip. */
export const SENTINEL_STRIP_HIDDEN_METADATA_KEY = 'pgstudio.sentinelStripHidden';

export const SENTINEL_PROD_TOUR_KEY = 'pgstudio.sentinel.prodTourShown.v1';

export const NEXQL_THEMES_MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=ric-v.nexql-themes';

/** Keys Sentinel may write under workbench.colorCustomizations — restored on gate close. */
export const SENTINEL_OWNED_COLOR_KEYS = [
  'statusBar.background',
  'statusBar.foreground',
  'statusBar.border',
  'titleBar.activeBackground',
  'titleBar.activeForeground',
  'activityBar.background',
  'activityBar.foreground',
  'activityBar.border',
] as const;

export type SentinelOwnedColorKey = (typeof SENTINEL_OWNED_COLOR_KEYS)[number];

const ENV_CHROME_COLORS: Record<SentinelEnvironment, Record<SentinelOwnedColorKey, string>> = {
  production: {
    'statusBar.background': '#5c1f1f',
    'statusBar.foreground': '#ffe8e8',
    'statusBar.border': '#8b2f2f',
    'titleBar.activeBackground': '#4a1818',
    'titleBar.activeForeground': '#ffe8e8',
    'activityBar.background': '#3d1414',
    'activityBar.foreground': '#ffd0d0',
    'activityBar.border': '#6b2222',
  },
  staging: {
    'statusBar.background': '#5c4518',
    'statusBar.foreground': '#fff4e0',
    'statusBar.border': '#8b6628',
    'titleBar.activeBackground': '#4a3812',
    'titleBar.activeForeground': '#fff4e0',
    'activityBar.background': '#3d3010',
    'activityBar.foreground': '#ffe8c0',
    'activityBar.border': '#6b5220',
  },
  development: {
    'statusBar.background': '#1a3050',
    'statusBar.foreground': '#e8f0ff',
    'statusBar.border': '#2a5080',
    'titleBar.activeBackground': '#142840',
    'titleBar.activeForeground': '#e8f0ff',
    'activityBar.background': '#102035',
    'activityBar.foreground': '#d0e4ff',
    'activityBar.border': '#1e4068',
  },
};

const ENV_STATUS_BAR_BACKGROUNDS: Record<SentinelEnvironment, string> = {
  production: '#5c1f1fAA',
  staging: '#5c4518AA',
  development: '#1a3050AA',
};

export function getChromeAccentColors(environment: SentinelEnvironment): Record<SentinelOwnedColorKey, string> {
  return ENV_CHROME_COLORS[environment];
}

export function getStatusBarAccentBackground(environment: SentinelEnvironment): string {
  return ENV_STATUS_BAR_BACKGROUNDS[environment];
}

export function environmentLabel(environment: SentinelEnvironment): string {
  switch (environment) {
    case 'production':
      return 'PROD';
    case 'staging':
      return 'STAGING';
    case 'development':
      return 'DEV';
  }
}

export function environmentIcon(environment: SentinelEnvironment): string {
  switch (environment) {
    case 'production':
      return '🔴';
    case 'staging':
      return '🟡';
    case 'development':
      return '🟢';
  }
}

export const SENTINEL_ACCENT_SNAPSHOT_KEY = 'pgstudio.sentinel.accentSnapshot.v1';
