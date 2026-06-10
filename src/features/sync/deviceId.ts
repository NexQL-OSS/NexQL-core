import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SYNC_DEVICE_ID_KEY } from './constants';

export function getOrCreateDeviceId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(SYNC_DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  void context.globalState.update(SYNC_DEVICE_ID_KEY, id);
  return id;
}
