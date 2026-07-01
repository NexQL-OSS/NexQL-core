import * as vscode from 'vscode';


/** Centralized tree icon + color palette for database and notebook trees. */
export type DatabaseTreeIconType =
  | 'connection'
  | 'database'
  | 'databases-group'
  | 'system-databases-group'
  | 'favorites-group'
  | 'recent-group'
  | 'schema'
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'column'
  | 'category'
  | 'materialized-view'
  | 'type'
  | 'foreign-table'
  | 'extension'
  | 'role'
  | 'constraint'
  | 'index'
  | 'foreign-data-wrapper'
  | 'foreign-server'
  | 'user-mapping'
  | 'connection-group'
  | 'trigger'
  | 'sequence'
  | 'partition'
  | 'domain'
  | 'aggregate'
  | 'event-trigger'
  | 'rule'
  | 'tablespace'
  | 'publication'
  | 'subscription'
  | 'cron-job'
  | 'policy'
  | 'sponsor-badge'
  | 'team-badge'
  | 'connection-notebooks-folder'
  | 'connection-notebooks-db'
  | 'connection-notebook-file'
  | 'connection-saved-queries-folder'
  | 'connection-saved-queries-db'
  | 'connection-saved-query-item'
  | 'connection-query-history-folder'
  | 'connection-query-history-db'
  | 'connection-query-history-item';

export type NotebookTreeIconType =
  | 'folder'
  | 'notebook-file'
  | 'shared-team-root'
  | 'workspace-folder'
  | 'shared-notebook-file';

const ACCENT = new vscode.ThemeColor('postgres.accent');
const ENV_PROD = new vscode.ThemeColor('postgres.envProd');
const ENV_STAGING = new vscode.ThemeColor('postgres.envStaging');
const ENV_DEV = new vscode.ThemeColor('postgres.envDev');

const CHART = {
  blue: new vscode.ThemeColor('charts.blue'),
  purple: new vscode.ThemeColor('charts.purple'),
  green: new vscode.ThemeColor('charts.green'),
  yellow: new vscode.ThemeColor('charts.yellow'),
  orange: new vscode.ThemeColor('charts.orange'),
  red: new vscode.ThemeColor('charts.red'),
  gray: new vscode.ThemeColor('charts.gray'),
} as const;

export interface DatabaseTreeIconOptions {
  isDisconnected?: boolean;
  isInstalled?: boolean;
  color?: 'red' | 'orange' | 'blue' | 'green' | 'gray';
  label?: string;
}

function generateThemedDatabaseSvg(
  type: string,
  capStart: string,
  capEnd: string,
  wallStart: string,
  wallEnd: string
): string {
  const capGradId = `capGrad_${type}`;
  const wallGradId = `wallGrad_${type}`;
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${capGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${capStart}" />
      <stop offset="100%" stop-color="${capEnd}" />
    </linearGradient>
    <linearGradient id="${wallGradId}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${wallStart}" />
      <stop offset="100%" stop-color="${wallEnd}" />
    </linearGradient>
  </defs>
  <path d="M 4,15.7 C 4,16.804 8.418,17.7 12,17.7 15.582,17.7 20,16.804 20,15.7 V 18.7 C 20,19.804 15.582,20.7 12,20.7 8.418,20.7 4,19.804 4,18.7 Z" fill="url(#${wallGradId})" />
  <ellipse cx="12" cy="15.7" rx="8" ry="2" fill="url(#${capGradId})" />
  <path d="M 4,10.5 C 4,11.604 8.418,12.5 12,12.5 15.582,12.5 20,11.604 20,10.5 V 13.5 C 20,14.604 15.582,15.5 12,15.5 8.418,15.5 4,14.604 4,13.5 Z" fill="url(#${wallGradId})" />
  <ellipse cx="12" cy="10.5" rx="8" ry="2" fill="url(#${capGradId})" />
  <path d="M 4,5.3 C 4,6.404 8.418,7.3 12,7.3 15.582,7.3 20,6.404 20,5.3 V 8.3 C 20,9.404 15.582,10.3 12,10.3 8.418,10.3 4,9.404 4,8.3 Z" fill="url(#${wallGradId})" />
  <ellipse cx="12" cy="5.3" rx="8" ry="2" fill="url(#${capGradId})" />
</svg>`;
}

function generateConnectionGroupSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="folderBack_group" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4f46e5" />
      <stop offset="100%" stop-color="#312e81" />
    </linearGradient>
    <linearGradient id="folderFront_group" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#4f46e5" />
    </linearGradient>
    <linearGradient id="emblemGrad_group" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a5f3fc" />
      <stop offset="100%" stop-color="#22d3ee" />
    </linearGradient>
  </defs>
  <path d="M 2,5 A 2,2 0 0 1 4,3 H 8.5 L 10.5,5.5 H 20 A 2,2 0 0 1 22,7.5 V 9.5 H 2 Z" fill="url(#folderBack_group)" />
  <path d="M 2,9 A 1.5,1.5 0 0 1 3.5,7.5 H 20.5 A 1.5,1.5 0 0 1 22,9 V 18.5 A 2,2 0 0 1 20,20.5 H 4 A 2,2 0 0 1 2,18.5 Z" fill="url(#folderFront_group)" />
  <rect x="10.5" y="11" width="3" height="4" rx="0.75" fill="url(#emblemGrad_group)" />
  <line x1="11" y1="9" x2="11" y2="11" stroke="url(#emblemGrad_group)" stroke-width="0.8" stroke-linecap="round" />
  <line x1="13" y1="9" x2="13" y2="11" stroke="url(#emblemGrad_group)" stroke-width="0.8" stroke-linecap="round" />
  <path d="M 12,15 V 17 C 12,18 11.5,18.5 11,19" stroke="url(#emblemGrad_group)" stroke-width="0.8" stroke-linecap="round" fill="none" />
</svg>`;
}

function generateThemedPlugSvg(
  state: 'connected' | 'disconnected' | 'red' | 'orange' | 'blue' | 'green' | 'gray'
): string {
  let bodyStart = '#60a5fa';
  let bodyEnd = '#1d4ed8';
  let prongStart = '#93c5fd';
  let prongEnd = '#60a5fa';
  let indicator = '#38bdf8';
  
  if (state === 'disconnected') {
    bodyStart = '#9ca3af';
    bodyEnd = '#4b5563';
    prongStart = '#d1d5db';
    prongEnd = '#9ca3af';
    indicator = '#6b7280';
  } else if (state === 'red') {
    bodyStart = '#f87171';
    bodyEnd = '#b91c1c';
    prongStart = '#fca5a5';
    prongEnd = '#f87171';
    indicator = '#fee2e2';
  } else if (state === 'orange') {
    bodyStart = '#fb923c';
    bodyEnd = '#c2410c';
    prongStart = '#fdba74';
    prongEnd = '#fb923c';
    indicator = '#ffedd5';
  } else if (state === 'green') {
    bodyStart = '#4ade80';
    bodyEnd = '#15803d';
    prongStart = '#86efac';
    prongEnd = '#4ade80';
    indicator = '#dcfce7';
  } else if (state === 'blue') {
    bodyStart = '#60a5fa';
    bodyEnd = '#1d4ed8';
    prongStart = '#93c5fd';
    prongEnd = '#60a5fa';
    indicator = '#eff6ff';
  } else if (state === 'gray') {
    bodyStart = '#9ca3af';
    bodyEnd = '#4b5563';
    prongStart = '#d1d5db';
    prongEnd = '#9ca3af';
    indicator = '#f3f4f6';
  }

  const id = `plug_${state}`;
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bodyGrad_${id}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${bodyStart}" />
      <stop offset="100%" stop-color="${bodyEnd}" />
    </linearGradient>
    <linearGradient id="prongGrad_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${prongStart}" />
      <stop offset="100%" stop-color="${prongEnd}" />
    </linearGradient>
  </defs>
  <rect x="9.5" y="4" width="1.5" height="5" rx="0.75" fill="url(#prongGrad_${id})" />
  <rect x="13" y="4" width="1.5" height="5" rx="0.75" fill="url(#prongGrad_${id})" />
  <path d="M 7.5,11 C 7.5,9.5 8.5,9 10,9 H 14 C 15.5,9 16.5,9.5 16.5,11 V 15 C 16.5,17 15,18 13.5,18 H 10.5 C 9,18 7.5,17 7.5,15 Z" fill="url(#bodyGrad_${id})" />
  <path d="M 12,18 V 21.5 C 12,22.5 11,23 10,23" fill="none" stroke="url(#bodyGrad_${id})" stroke-width="1.5" stroke-linecap="round" />
  <circle cx="12" cy="13.5" r="1.5" fill="${indicator}" />
</svg>`;
}

function generateRecentSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="clockBackGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#047857" />
      <stop offset="100%" stop-color="#064e3b" />
    </linearGradient>
    <linearGradient id="clockRimGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#a7f3d0" />
      <stop offset="100%" stop-color="#34d399" />
    </linearGradient>
    <linearGradient id="clockHandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#a7f3d0" />
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="8" fill="url(#clockBackGrad)" stroke="url(#clockRimGrad)" stroke-width="1.8" />
  <line x1="12" y1="12" x2="15.5" y2="12" stroke="url(#clockHandGrad)" stroke-width="1.8" stroke-linecap="round" />
  <line x1="12" y1="12" x2="12" y2="7.5" stroke="url(#clockHandGrad)" stroke-width="1.8" stroke-linecap="round" />
  <circle cx="12" cy="12" r="1.2" fill="#ffffff" />
</svg>`;
}

function generateNotebooksFolderSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="notebookCover" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#4f46e5" />
    </linearGradient>
    <linearGradient id="notebookRing" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
  </defs>
  <rect x="6" y="3" width="14" height="18" rx="1.5" fill="url(#notebookCover)" />
  <path d="M 3.5,6 H 7 M 3.5,10 H 7 M 3.5,14 H 7 M 3.5,18 H 7" stroke="url(#notebookRing)" stroke-width="1.8" stroke-linecap="round" />
  <rect x="9" y="7" width="8" height="1.8" rx="0.4" fill="#ffffff" opacity="0.8" />
  <rect x="9" y="11" width="8" height="1.2" rx="0.3" fill="#ffffff" opacity="0.6" />
  <rect x="9" y="14" width="5" height="1.2" rx="0.3" fill="#ffffff" opacity="0.6" />
</svg>`;
}

function generateSavedQueriesFolderSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sqFolderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2dd4bf" />
      <stop offset="100%" stop-color="#0d9488" />
    </linearGradient>
  </defs>
  <path d="M 5,5 H 17 L 19,7 V 18.5 A 1.5,1.5 0 0 1 17.5,20 H 6.5 A 1.5,1.5 0 0 1 5,18.5 Z" fill="url(#sqFolderGrad)" />
  <path d="M 8,5 H 15 V 9 H 8 Z" fill="#ffffff" opacity="0.85" />
  <rect x="13" y="6" width="1.4" height="2" rx="0.3" fill="#0d9488" />
  <rect x="8.5" y="12" width="7" height="1.2" rx="0.3" fill="#ffffff" opacity="0.7" />
  <rect x="8.5" y="15" width="4.5" height="1.2" rx="0.3" fill="#ffffff" opacity="0.55" />
</svg>`;
}

function generateQueryHistoryFolderSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="qhBackGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7c3aed" />
      <stop offset="100%" stop-color="#4c1d95" />
    </linearGradient>
    <linearGradient id="qhRimGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ddd6fe" />
      <stop offset="100%" stop-color="#a78bfa" />
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="8" fill="url(#qhBackGrad)" stroke="url(#qhRimGrad)" stroke-width="1.8" />
  <line x1="12" y1="12" x2="15.5" y2="12" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" />
  <line x1="12" y1="12" x2="12" y2="7.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" />
  <circle cx="12" cy="12" r="1.2" fill="#ffffff" />
  <path d="M 4.2,9 A 8,8 0 0 1 6,6" fill="none" stroke="#ddd6fe" stroke-width="1.4" stroke-linecap="round" />
</svg>`;
}

function generateSavedQueryItemSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sqItemGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5eead4" />
      <stop offset="100%" stop-color="#14b8a6" />
    </linearGradient>
  </defs>
  <path d="M 6,3 H 14 L 19,8 V 20 A 1.5,1.5 0 0 1 17.5,21.5 H 6.5 A 1.5,1.5 0 0 1 5,20 V 4.5 A 1.5,1.5 0 0 1 6,3 Z" fill="url(#sqItemGrad)" />
  <path d="M 14,3 V 8 H 19 Z" fill="#0f766e" opacity="0.6" />
  <path d="M 8.5,12.5 L 10.5,14.5 L 8.5,16.5" fill="none" stroke="#0f766e" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  <line x1="12" y1="16.5" x2="15.5" y2="16.5" stroke="#0f766e" stroke-width="1.3" stroke-linecap="round" />
</svg>`;
}

function generateQueryHistoryItemSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="qhItemGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c4b5fd" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="8" fill="none" stroke="url(#qhItemGrad)" stroke-width="1.8" />
  <line x1="12" y1="12" x2="15" y2="12" stroke="url(#qhItemGrad)" stroke-width="1.8" stroke-linecap="round" />
  <line x1="12" y1="12" x2="12" y2="8" stroke="url(#qhItemGrad)" stroke-width="1.8" stroke-linecap="round" />
</svg>`;
}

function generateUsersRolesSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="backUserGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#475569" />
    </linearGradient>
    <linearGradient id="frontUserGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
  </defs>
  <circle cx="15.5" cy="8.5" r="2.8" fill="url(#backUserGrad)" />
  <path d="M 11,16 C 11,14.2 12.8,13 15.5,13 C 18.2,13 20,14.2 20,16 V 17.5 H 11 Z" fill="url(#backUserGrad)" />
  <circle cx="9.5" cy="9.5" r="3.5" fill="url(#frontUserGrad)" />
  <path d="M 3.5,19 C 3.5,16 6,14.2 9.5,14.2 C 13,14.2 15.5,16 15.5,19 V 20.5 H 3.5 Z" fill="url(#frontUserGrad)" />
</svg>`;
}

function generateTablespaceSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="rackGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#334155" />
    </linearGradient>
  </defs>
  <rect x="3" y="4" width="18" height="4.5" rx="1.2" fill="url(#rackGrad)" />
  <rect x="3" y="10" width="18" height="4.5" rx="1.2" fill="url(#rackGrad)" />
  <rect x="3" y="16" width="18" height="4.5" rx="1.2" fill="url(#rackGrad)" />
  <circle cx="6" cy="6.25" r="0.8" fill="#38bdf8" />
  <circle cx="6" cy="12.25" r="0.8" fill="#38bdf8" />
  <circle cx="6" cy="18.25" r="0.8" fill="#38bdf8" />
  <circle cx="8" cy="6.25" r="0.8" fill="#34d399" />
  <circle cx="8" cy="12.25" r="0.8" fill="#34d399" />
  <circle cx="8" cy="18.25" r="0.8" fill="#34d399" />
  <line x1="11" y1="6.25" x2="18" y2="6.25" stroke="#1e293b" stroke-width="0.8" stroke-linecap="round" />
  <line x1="11" y1="12.25" x2="18" y2="12.25" stroke="#1e293b" stroke-width="0.8" stroke-linecap="round" />
  <line x1="11" y1="18.25" x2="18" y2="18.25" stroke="#1e293b" stroke-width="0.8" stroke-linecap="round" />
</svg>`;
}

function generateCustomIconSvg(
  type: DatabaseTreeIconType,
  options: DatabaseTreeIconOptions = {}
): string {
  const { isDisconnected, isInstalled, color, label } = options;

  switch (type) {
    case 'database':
      return generateThemedDatabaseSvg('db', '#fef9c3', '#fbbf24', '#d97706', '#78350f'); // Golden amber
    case 'databases-group':
      return generateThemedDatabaseSvg('group', '#ffedd5', '#f97316', '#ea580c', '#7c2d12'); // Deep amber & orange
    case 'system-databases-group':
      return generateThemedDatabaseSvg('system', '#f3f4f6', '#9ca3af', '#6b7280', '#374151'); // Metallic grey/silver

    case 'connection-group':
      return generateConnectionGroupSvg();

    case 'connection': {
      let state: 'connected' | 'disconnected' | 'red' | 'orange' | 'blue' | 'green' | 'gray' = 'connected';
      if (isDisconnected) {
        state = 'disconnected';
      } else if (color) {
        state = color;
      }
      return generateThemedPlugSvg(state);
    }

    case 'recent-group':
      return generateRecentSvg();

    case 'connection-notebooks-folder':
      return generateNotebooksFolderSvg();

    case 'connection-saved-queries-folder':
      return generateSavedQueriesFolderSvg();

    case 'connection-query-history-folder':
      return generateQueryHistoryFolderSvg();

    case 'connection-notebooks-db':
    case 'connection-saved-queries-db':
    case 'connection-query-history-db':
      return generateThemedDatabaseSvg('db', '#fef9c3', '#fbbf24', '#d97706', '#78350f'); // Golden amber (matches database)

    case 'connection-saved-query-item':
      return generateSavedQueryItemSvg();

    case 'connection-query-history-item':
      return generateQueryHistoryItemSvg();

    case 'connection-notebook-file':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="nbFileGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a" />
      <stop offset="100%" stop-color="#eab308" />
    </linearGradient>
  </defs>
  <path d="M 6,3 H 14 L 19,8 V 20 A 1.5,1.5 0 0 1 17.5,21.5 H 6.5 A 1.5,1.5 0 0 1 5,20 V 4.5 A 1.5,1.5 0 0 1 6,3 Z" fill="url(#nbFileGrad)" />
  <path d="M 14,3 V 8 H 19 Z" fill="#ca8a04" opacity="0.6" />
  <rect x="8" y="11" width="8" height="1.2" rx="0.3" fill="#854d0e" opacity="0.8" />
  <rect x="8" y="14" width="8" height="1.2" rx="0.3" fill="#854d0e" opacity="0.8" />
  <rect x="8" y="17" width="5" height="1.2" rx="0.3" fill="#854d0e" opacity="0.8" />
</svg>`;

    case 'schema':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cubeTop" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>
    <linearGradient id="cubeLeft" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6" />
      <stop offset="100%" stop-color="#6d28d9" />
    </linearGradient>
    <linearGradient id="cubeRight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#7c3aed" />
      <stop offset="100%" stop-color="#4c1d95" />
    </linearGradient>
  </defs>
  <polygon points="12,3 20,7 12,11 4,7" fill="url(#cubeTop)" />
  <polygon points="4,7 12,11 12,21 4,17" fill="url(#cubeLeft)" />
  <polygon points="12,11 20,7 20,17 12,21" fill="url(#cubeRight)" />
</svg>`;

    case 'table':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6" />
      <stop offset="100%" stop-color="#1d4ed8" />
    </linearGradient>
    <linearGradient id="cellGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa" />
      <stop offset="100%" stop-color="#3b82f6" />
    </linearGradient>
  </defs>
  <rect x="3" y="4" width="18" height="4" rx="1.5" fill="url(#headerGrad)" />
  <rect x="3" y="10" width="8" height="3" rx="1" fill="url(#cellGrad)" opacity="0.8" />
  <rect x="3" y="15" width="8" height="3" rx="1" fill="url(#cellGrad)" opacity="0.8" />
  <rect x="13" y="10" width="8" height="3" rx="1" fill="url(#cellGrad)" opacity="0.5" />
  <rect x="13" y="15" width="5" height="3" rx="1" fill="url(#cellGrad)" opacity="0.5" />
</svg>`;

    case 'view':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="eyeStrokeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
    <linearGradient id="irisGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a7f3d0" />
      <stop offset="100%" stop-color="#34d399" />
    </linearGradient>
  </defs>
  <path d="M 3,12 C 6,6 18,6 21,12 C 18,18 6,18 3,12 Z" fill="none" stroke="url(#eyeStrokeGrad)" stroke-width="2" stroke-linecap="round" />
  <circle cx="12" cy="12" r="4.5" fill="url(#irisGrad)" />
  <circle cx="12" cy="12" r="2" fill="#ffffff" />
</svg>`;

    case 'materialized-view':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="matDiskGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#059669" />
      <stop offset="100%" stop-color="#047857" />
    </linearGradient>
    <linearGradient id="matEyeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <path d="M 4,15.5 C 4,16.5 8.4,17.5 12,17.5 C 15.6,17.5 20,16.5 20,15.5 V 18 C 20,19 15.6,19.8 12,19.8 C 8.4,19.8 4,19 4,18 Z" fill="url(#matDiskGrad)" />
  <path d="M 4,9 C 6.5,4.5 17.5,4.5 20,9 C 17.5,13.5 6.5,13.5 4,9 Z" fill="none" stroke="url(#matEyeGrad)" stroke-width="1.8" />
  <circle cx="12" cy="9" r="3.2" fill="url(#matEyeGrad)" />
  <circle cx="12" cy="9" r="1.2" fill="#ffffff" />
</svg>`;

    case 'column':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="colGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
  </defs>
  <rect x="8" y="3" width="8" height="18" rx="2" fill="url(#colGrad)" />
  <line x1="8" y1="7.5" x2="16" y2="7.5" stroke="#ffffff" stroke-width="1.2" opacity="0.3" />
  <line x1="8" y1="12" x2="16" y2="12" stroke="#ffffff" stroke-width="1.2" opacity="0.3" />
  <line x1="8" y1="16.5" x2="16" y2="16.5" stroke="#ffffff" stroke-width="1.2" opacity="0.3" />
  <circle cx="12" cy="5.25" r="1.2" fill="#ffffff" />
</svg>`;

    case 'function':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="funcBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f97316" />
      <stop offset="100%" stop-color="#ea580c" />
    </linearGradient>
  </defs>
  <polygon points="12,3 20,7 20,17 12,21 4,17 4,7" fill="url(#funcBg)" />
  <path d="M 14,7.5 C 13,7.5 12.2,8 12.2,9.2 V 10.8 H 14.5 V 12.5 H 12.2 V 17.5 H 10.2 V 12.5 H 8.8 V 10.8 H 10.2 V 9.2 C 10.2,7.2 11.5,6.2 13.5,6.2 C 14,6.2 14.5,6.3 14.5,6.3 Z" fill="#ffffff" />
</svg>`;

    case 'procedure':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="procBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ef4444" />
      <stop offset="100%" stop-color="#b91c1c" />
    </linearGradient>
  </defs>
  <polygon points="12,3 20,7 20,17 12,21 4,17 4,7" fill="url(#procBg)" />
  <path d="M 9.5,7.5 H 13.5 C 15,7.5 16,8.5 16,10 C 16,11.5 15,12.5 13.5,12.5 H 11.5 V 17.5 H 9.5 Z M 11.5,9.5 V 10.8 H 13.2 C 13.8,10.8 14.2,10.5 14.2,10 C 14.2,9.5 13.8,9.5 13.2,9.5 Z" fill="#ffffff" />
</svg>`;

    case 'sequence':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="seqGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
  </defs>
  <rect x="5" y="14" width="3.2" height="6" rx="0.6" fill="url(#seqGrad)" />
  <rect x="10.4" y="9" width="3.2" height="11" rx="0.6" fill="url(#seqGrad)" />
  <rect x="15.8" y="4" width="3.2" height="16" rx="0.6" fill="url(#seqGrad)" />
  <path d="M 5,11 C 9,5.5 14,4.5 18,3.2 M 15,3.2 H 18 V 6.2" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

    case 'index':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="indexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc" />
      <stop offset="100%" stop-color="#7c3aed" />
    </linearGradient>
  </defs>
  <rect x="5" y="4" width="9" height="11" rx="1" stroke="#a78bfa" stroke-width="1.2" fill="none" opacity="0.6" />
  <line x1="7" y1="7" x2="12" y2="7" stroke="#a78bfa" stroke-width="1" opacity="0.6" />
  <line x1="7" y1="10" x2="10" y2="10" stroke="#a78bfa" stroke-width="1" opacity="0.6" />
  <circle cx="14" cy="13.5" r="4" stroke="url(#indexGrad)" stroke-width="1.8" fill="none" />
  <line x1="17" y1="16.5" x2="20" y2="19.5" stroke="url(#indexGrad)" stroke-width="1.8" stroke-linecap="round" />
</svg>`;

    case 'constraint':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lockBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fb923c" />
      <stop offset="100%" stop-color="#ea580c" />
    </linearGradient>
    <linearGradient id="lockShackle" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fed7aa" />
      <stop offset="100%" stop-color="#fb923c" />
    </linearGradient>
  </defs>
  <rect x="6" y="10" width="12" height="9.5" rx="1.5" fill="url(#lockBody)" />
  <path d="M 9,10 V 7 C 9,5 10.5,3 12,3 C 13.5,3 15,5 15,7 V 10" fill="none" stroke="url(#lockShackle)" stroke-width="1.8" stroke-linecap="round" />
  <circle cx="12" cy="13.8" r="1.2" fill="#3f1a04" />
  <line x1="12" y1="15" x2="12" y2="17.2" stroke="#3f1a04" stroke-width="1" stroke-linecap="round" />
</svg>`;

    case 'trigger':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="zapGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#facc15" />
      <stop offset="100%" stop-color="#ea580c" />
    </linearGradient>
  </defs>
  <path d="M 14.5,3 L 7,12.5 H 12 L 9.5,21 L 17,11.5 H 12 Z" fill="url(#zapGrad)" />
</svg>`;

    case 'domain':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="domainGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f87171" />
      <stop offset="100%" stop-color="#b91c1c" />
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="8" stroke="url(#domainGrad)" stroke-width="1.8" fill="none" />
  <path d="M 9.5,8 H 12.8 C 14.2,8 15,8.8 15,12 C 15,15.2 14.2,16 12.8,16 H 9.5 Z M 11.2,9.6 V 14.4 H 12.4 C 13.2,14.4 13.4,14 13.4,12 C 13.4,10 M 13.4,10 C 13.4,10 13.2,9.6 12.4,9.6 Z" fill="url(#domainGrad)" />
</svg>`;

    case 'type':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="typeBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f87171" />
      <stop offset="100%" stop-color="#dc2626" />
    </linearGradient>
  </defs>
  <polygon points="12,3 20,7 20,17 12,21 4,17 4,7" fill="url(#typeBg)" />
  <path d="M 8.5,7.5 H 15.5 V 9.5 H 13 V 16.5 H 11 V 9.5 H 8.5 Z" fill="#ffffff" />
</svg>`;

    case 'extension': {
      const grad = isInstalled ? 'url(#extInstGrad)' : 'url(#extAvailGrad)';
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="extInstGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
    <linearGradient id="extAvailGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#475569" />
    </linearGradient>
  </defs>
  <rect x="5" y="8" width="14" height="10.5" rx="1.5" fill="${grad}" />
  <rect x="8" y="5" width="3" height="3" rx="0.5" fill="${grad}" />
  <rect x="13" y="5" width="3" height="3" rx="0.5" fill="${grad}" />
</svg>`;
    }

    case 'role':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="roleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
  </defs>
  <circle cx="12" cy="8.5" r="3.5" fill="url(#roleGrad)" />
  <path d="M 5,19 C 5,16 8,14 12,14 C 16,14 19,16 19,19 V 20.5 H 5 Z" fill="url(#roleGrad)" />
</svg>`;

    case 'user-mapping':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mapUser" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
    <linearGradient id="mapDb" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f3f4f6" />
      <stop offset="100%" stop-color="#9ca3af" />
    </linearGradient>
  </defs>
  <circle cx="7" cy="8.5" r="2.5" fill="url(#mapUser)" />
  <path d="M 3,16 C 3,14 5,13 7,13 C 9,13 11,14 11,16 V 17 H 3 Z" fill="url(#mapUser)" />
  <line x1="11" y1="12" x2="15" y2="12" stroke="#eab308" stroke-dasharray="1.5,1.5" stroke-width="1.2" />
  <rect x="15" y="8" width="6" height="8" rx="1" fill="url(#mapDb)" />
  <ellipse cx="18" cy="8" rx="3" ry="1" fill="#cbd5e1" />
</svg>`;

    case 'foreign-data-wrapper':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fdwGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa" />
      <stop offset="100%" stop-color="#2563eb" />
    </linearGradient>
  </defs>
  <rect x="5" y="7" width="14" height="10" rx="1.5" fill="url(#fdwGrad)" />
  <circle cx="12" cy="12" r="2" fill="#ffffff" />
  <line x1="12" y1="4" x2="12" y2="7" stroke="url(#fdwGrad)" stroke-width="1.8" stroke-linecap="round" />
  <line x1="12" y1="17" x2="12" y2="20" stroke="url(#fdwGrad)" stroke-width="1.8" stroke-linecap="round" />
  <line x1="4" y1="12" x2="5" y2="12" stroke="url(#fdwGrad)" stroke-width="1.8" stroke-linecap="round" />
  <line x1="19" y1="12" x2="20" y2="12" stroke="url(#fdwGrad)" stroke-width="1.8" stroke-linecap="round" />
</svg>`;

    case 'foreign-server':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fsvGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <rect x="3" y="6" width="18" height="6" rx="1" fill="url(#fsvGrad)" />
  <rect x="3" y="14" width="18" height="6" rx="1" fill="url(#fsvGrad)" />
  <path d="M 12,8 C 11.5,8 11.2,8.2 11,8.5 C 10.7,8.2 10.3,8.2 10,8.5 C 9.5,8.5 9,9 9,9.5 C 9,10 9.5,10.5 10,10.5 H 14 C 14.5,10.5 15,10 15,9.5 C 15,9 14.5,8.5 14,8.5 C 13.8,8.2 13.5,8 13,8 Z" fill="#ffffff" opacity="0.9" />
  <circle cx="6" cy="9" r="0.8" fill="#38bdf8" />
  <circle cx="6" cy="17" r="0.8" fill="#38bdf8" />
</svg>`;

    case 'foreign-table':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ftHeader" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa" />
      <stop offset="100%" stop-color="#2563eb" />
    </linearGradient>
  </defs>
  <rect x="3" y="4" width="18" height="16" rx="2" stroke="#60a5fa" stroke-width="1.2" stroke-dasharray="2,2" fill="none" />
  <rect x="4.5" y="5.5" width="15" height="3.5" rx="1" fill="url(#ftHeader)" />
  <line x1="12" y1="5.5" x2="12" y2="18.5" stroke="#60a5fa" stroke-width="0.8" opacity="0.4" />
</svg>`;

    case 'cron-job':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cronGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fb923c" />
      <stop offset="100%" stop-color="#ea580c" />
    </linearGradient>
  </defs>
  <circle cx="11" cy="11" r="7" stroke="url(#cronGrad)" stroke-width="1.8" fill="none" />
  <path d="M 11,7 V 11 H 14" stroke="url(#cronGrad)" stroke-width="1.5" stroke-linecap="round" fill="none" />
  <polygon points="17,14 17,21 22,17.5" fill="#f97316" />
</svg>`;

    case 'policy':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="policyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <path d="M 12,3 L 19,6 V 11.5 C 19,16 16.5,19 12,20.5 C 7.5,19 5,16 5,11.5 V 6 Z" fill="url(#policyGrad)" />
  <path d="M 9.5,11.5 L 11.2,13.2 L 14.5,9.5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

    case 'favorites-group':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="starGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
  </defs>
  <path d="M 12,3 L 14.8,9.2 L 21.5,9.8 L 16.4,14.2 L 17.9,20.8 L 12,17.3 L 6.1,20.8 L 7.6,14.2 L 2.5,9.8 L 9.2,9.2 Z" fill="url(#starGrad)" />
</svg>`;

    case 'sponsor-badge':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="heartGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e" />
      <stop offset="100%" stop-color="#be123c" />
    </linearGradient>
  </defs>
  <path d="M 12,21.35 L 10.55,20.03 C 5.4,15.36 2,12.28 2,8.5 C 2,5.42 4.42,3 7.5,3 C 9.24,3 10.91,3.81 12,5.09 C 13.09,3.81 14.76,3 16.5,3 C 19.58,3 22,5.42 22,8.5 C 22,12.28 18.6,15.36 13.45,20.04 L 12,21.35 Z" fill="url(#heartGrad)" />
</svg>`;

    case 'team-badge':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="teamGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a78bfa" />
      <stop offset="100%" stop-color="#6d28d9" />
    </linearGradient>
  </defs>
  <path d="M 12,2 L 4,5 V 11 C 4,16.5 8,21 12,22.5 C 16,21 20,16.5 20,11 V 5 L 12,2 Z" fill="url(#teamGrad)" />
  <path d="M 9,11 L 11,13 L 15,9" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

    case 'aggregate':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="aggGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <path d="M 7,6 H 17 V 8.5 H 11.2 L 14.2,12 L 11.2,15.5 H 17 V 18 H 7 V 16 L 11.2,12 L 7,8 Z" fill="url(#aggGrad)" stroke="url(#aggGrad)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

    case 'tablespace':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tbSpaceGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
  </defs>
  <path d="M 3,6 A 2,2 0 0 1 5,4 H 9 L 11,6 H 19 A 2,2 0 0 1 21,8 V 18 A 2,2 0 0 1 19,20 H 5 A 2,2 0 0 1 3,18 Z" fill="url(#tbSpaceGrad)" />
  <rect x="7" y="11" width="10" height="4" rx="0.5" fill="#0c4a6e" />
  <circle cx="10" cy="13" r="0.8" fill="#38bdf8" />
</svg>`;

    case 'partition':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="partGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc" />
      <stop offset="100%" stop-color="#7c3aed" />
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="16" height="4" rx="1" fill="url(#partGrad)" />
  <rect x="4" y="10" width="16" height="4" rx="1" fill="url(#partGrad)" />
  <rect x="4" y="16" width="16" height="4" rx="1" fill="url(#partGrad)" opacity="0.7" />
</svg>`;

    case 'category':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="folderBack_cat" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#475569" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <linearGradient id="folderFront_cat" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#64748b" />
      <stop offset="100%" stop-color="#475569" />
    </linearGradient>
  </defs>
  <path d="M 2,5 A 2,2 0 0 1 4,3 H 8.5 L 10.5,5.5 H 20 A 2,2 0 0 1 22,7.5 V 9.5 H 2 Z" fill="url(#folderBack_cat)" />
  <path d="M 2,9 A 1.5,1.5 0 0 1 3.5,7.5 H 20.5 A 1.5,1.5 0 0 1 22,9 V 18.5 A 2,2 0 0 1 20,20.5 H 4 A 2,2 0 0 1 2,18.5 Z" fill="url(#folderFront_cat)" />
  <line x1="8" y1="11" x2="16" y2="11" stroke="#cbd5e1" stroke-width="1.2" stroke-linecap="round" />
  <line x1="8" y1="14" x2="14" y2="14" stroke="#cbd5e1" stroke-width="1.2" stroke-linecap="round" />
  <line x1="8" y1="17" x2="11" y2="17" stroke="#cbd5e1" stroke-width="1.2" stroke-linecap="round" />
</svg>`;

    case 'event-trigger':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="evtTrig" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fb923c" />
      <stop offset="100%" stop-color="#ea580c" />
    </linearGradient>
  </defs>
  <path d="M 12.5,3 L 7,11 H 11 L 9.5,18 L 15,10 H 11 Z" fill="url(#evtTrig)" />
  <path d="M 16,6 C 18,8 18,12 16,14 M 18,4 C 21,7 21,13 18,16" stroke="#fb923c" stroke-width="1.5" stroke-linecap="round" fill="none" />
</svg>`;

    case 'rule':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ruleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a" />
      <stop offset="100%" stop-color="#ca8a04" />
    </linearGradient>
  </defs>
  <rect x="5" y="4" width="14" height="16" rx="1.5" fill="none" stroke="url(#ruleGrad)" stroke-width="1.8" />
  <path d="M 8.5,9 H 15.5 M 8.5,13 H 13 M 9,17 L 11,19 L 15,15" stroke="url(#ruleGrad)" stroke-width="1.8" stroke-linecap="round" fill="none" />
</svg>`;

    case 'publication':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="pubGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <circle cx="6" cy="18" r="2.5" fill="url(#pubGrad)" />
  <path d="M 4,11 C 9,11 13,15 13,20 M 4,5 C 13,5 19,11 19,20" stroke="url(#pubGrad)" stroke-width="2" stroke-linecap="round" fill="none" />
</svg>`;

    case 'subscription':
      return `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="subGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc" />
      <stop offset="100%" stop-color="#7c3aed" />
    </linearGradient>
  </defs>
  <rect x="4" y="8" width="16" height="12" rx="1.5" fill="none" stroke="url(#subGrad)" stroke-width="1.8" />
  <path d="M 4,12 H 8.5 A 1.5,1.5 0 0 0 10,13.5 A 1.5,1.5 0 0 0 11.5,12 H 20" stroke="url(#subGrad)" stroke-width="1.8" fill="none" />
  <path d="M 12,4 V 11 M 9,8 L 12,11 L 15,8" stroke="url(#subGrad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" />
</svg>`;

    default:
      return '';
  }
}

const iconCache = new Map<string, vscode.Uri>();

export function clearIconCache(): void {
  iconCache.clear();
}

export function getDatabaseTreeIcon(
  type: DatabaseTreeIconType,
  options: DatabaseTreeIconOptions = {},
): vscode.ThemeIcon | vscode.Uri | undefined {
  const cacheKey = `${type}:${options.isDisconnected ?? ''}:${options.isInstalled ?? ''}:${options.color ?? ''}:${options.label ?? ''}`;
  const cached = iconCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const svgStr = generateCustomIconSvg(type, options);
  if (svgStr) {
    const base64 = Buffer.from(svgStr).toString('base64');
    const uri = vscode.Uri.parse(`data:image/svg+xml;base64,${base64}`);
    iconCache.set(cacheKey, uri);
    return uri;
  }
  return undefined;
}

export function getNotebookTreeIcon(
  itemType: NotebookTreeIconType,
  folderDepth = 0,
): vscode.ThemeIcon {
  switch (itemType) {
    case 'folder':
      if (folderDepth === 1) {
        return new vscode.ThemeIcon('server', ACCENT);
      }
      if (folderDepth === 2) {
        return new vscode.ThemeIcon('database', CHART.purple);
      }
      return new vscode.ThemeIcon('folder');
    case 'notebook-file':
      return new vscode.ThemeIcon('notebook', CHART.yellow);
    case 'shared-team-root':
      return new vscode.ThemeIcon('organization', ACCENT);
    case 'workspace-folder':
      return new vscode.ThemeIcon('folder-library');
    case 'shared-notebook-file':
      return new vscode.ThemeIcon('notebook', CHART.orange);
    default:
      return new vscode.ThemeIcon('file');
  }
}

/** Environment badge text for connection tree descriptions. */
export function formatConnectionEnvBadge(
  environment?: 'production' | 'staging' | 'development',
  readOnlyMode?: boolean,
): string | undefined {
  const badges: string[] = [];
  if (environment === 'production') {
    badges.push('🔴 PROD');
  } else if (environment === 'staging') {
    badges.push('🟡 STAGING');
  } else if (environment === 'development') {
    badges.push('🟢 DEV');
  }
  if (readOnlyMode) {
    badges.push('🔒');
  }
  return badges.length > 0 ? badges.join(' ') : undefined;
}

/** ThemeColor ids for environment (for future programmatic use). */
export const TREE_ENV_COLORS = {
  production: ENV_PROD,
  staging: ENV_STAGING,
  development: ENV_DEV,
} as const;
