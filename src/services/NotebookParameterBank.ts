import * as vscode from 'vscode';

export interface NotebookParameterBankState {
  [notebookUri: string]: Record<string, string[]>;
}

const STORAGE_KEY = 'nexql.notebookParameterBank.v1';
const MAX_VALUES_PER_PARAMETER = 20;

function readState(workspaceState?: vscode.Memento): NotebookParameterBankState {
  return workspaceState?.get<NotebookParameterBankState>(STORAGE_KEY, {}) ?? {};
}

function writeState(workspaceState: vscode.Memento | undefined, state: NotebookParameterBankState): Promise<void> {
  if (!workspaceState) {
    return Promise.resolve();
  }

  return Promise.resolve(workspaceState.update(STORAGE_KEY, state)) as Promise<void>;
}

function normalizeValues(values: string[]): string[] {
  const next: string[] = [];

  for (const value of values) {
    if (!next.includes(value)) {
      next.push(value);
    }
  }

  return next.slice(0, MAX_VALUES_PER_PARAMETER);
}

export function getNotebookParameterValues(
  workspaceState: vscode.Memento | undefined,
  notebookUri: string,
  parameterKey: string
): string[] {
  const state = readState(workspaceState);
  const notebookState = state[notebookUri] ?? {};
  return [...(notebookState[parameterKey] ?? [])];
}

export async function rememberNotebookParameterValue(
  workspaceState: vscode.Memento | undefined,
  notebookUri: string,
  parameterKey: string,
  value: string
): Promise<void> {
  if (!workspaceState) {
    return;
  }

  const state = readState(workspaceState);
  const notebookState = { ...(state[notebookUri] ?? {}) };
  const currentValues = notebookState[parameterKey] ?? [];
  notebookState[parameterKey] = normalizeValues([value, ...currentValues.filter((existing) => existing !== value)]);
  state[notebookUri] = notebookState;

  await writeState(workspaceState, state);
}

export async function clearNotebookParameterValues(
  workspaceState: vscode.Memento | undefined,
  notebookUri: string,
  parameterKey?: string
): Promise<void> {
  if (!workspaceState) {
    return;
  }

  const state = readState(workspaceState);
  const notebookState = { ...(state[notebookUri] ?? {}) };

  if (parameterKey) {
    delete notebookState[parameterKey];
    if (Object.keys(notebookState).length > 0) {
      state[notebookUri] = notebookState;
    } else {
      delete state[notebookUri];
    }
  } else {
    delete state[notebookUri];
  }

  await writeState(workspaceState, state);
}