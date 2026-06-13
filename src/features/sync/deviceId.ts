import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SYNC_DEVICE_ID_KEY, SYNC_DEVICE_NAME_KEY } from './constants';

export function getOrCreateDeviceId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(SYNC_DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  void context.globalState.update(SYNC_DEVICE_ID_KEY, id);
  return id;
}

export function getDeviceName(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(SYNC_DEVICE_NAME_KEY);
}

export async function ensureDeviceName(context: vscode.ExtensionContext): Promise<string> {
  const existing = getDeviceName(context);
  if (existing) {
    return existing;
  }
  const defaultName = vscode.env.machineId.slice(0, 8) || 'This device';
  const name = await vscode.window.showInputBox({
    title: 'Name this device',
    prompt: 'Shown in sync history and device list',
    value: defaultName,
    ignoreFocusOut: true,
  });
  const resolved = (name || defaultName).trim();
  await context.globalState.update(SYNC_DEVICE_NAME_KEY, resolved);
  return resolved;
}
