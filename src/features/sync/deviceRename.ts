import * as vscode from 'vscode';
import { LicenseService } from '../../services/LicenseService';
import { SyncController } from './SyncController';
import { setDeviceName } from './deviceId';

export interface SaveDeviceDisplayNameResult {
  cloudOk: boolean;
}

/** Persist friendly device name locally, on the license roster, and NexQL Cloud when configured. */
export async function saveDeviceDisplayName(
  context: vscode.ExtensionContext,
  deviceName: string,
): Promise<SaveDeviceDisplayNameResult> {
  const trimmed = deviceName.trim();
  if (!trimmed) {
    throw new Error('Device name is required');
  }
  await setDeviceName(context, trimmed);
  await LicenseService.getInstance().refreshDeviceName(trimmed);
  const cloudOk = await SyncController.getInstance().pushDeviceNameToCloud(trimmed);
  return { cloudOk };
}
