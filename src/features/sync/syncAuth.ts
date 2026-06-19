import * as vscode from 'vscode';
import { AccountService } from './AccountService';
import { getDeviceName, getOrCreateDeviceId } from './deviceId';
import type { HttpResponse } from './providers/httpUtils';

/** Bearer + device headers for NexQL Cloud sync API calls. */
export async function buildSyncAuthHeaders(
  context: vscode.ExtensionContext,
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await AccountService.getInstance(context).ensureSession();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-Device-Id': getOrCreateDeviceId(context),
    ...extra,
  };
  const deviceName = getDeviceName(context);
  if (deviceName) {
    headers['X-Device-Name'] = deviceName;
  }
  return headers;
}

/**
 * Execute a sync HTTP call with one silent re-auth retry on 401 or pre-request auth failure.
 */
export async function withAuthRetry<T>(
  context: vscode.ExtensionContext,
  request: (headers: Record<string, string>) => Promise<HttpResponse>,
  mapResponse: (res: HttpResponse) => T,
  errorLabel: string,
): Promise<T> {
  const attempt = async (invalidate: boolean): Promise<T> => {
    let headers: Record<string, string>;
    try {
      if (invalidate) {
        await AccountService.getInstance(context).ensureSession({ invalidateAccess: true });
      }
      headers = await buildSyncAuthHeaders(context);
    } catch (e) {
      if (!invalidate) {
        return attempt(true);
      }
      throw e;
    }

    const res = await request(headers);
    if (res.statusCode === 401) {
      if (invalidate) {
        throw new Error(`${errorLabel}: API ${res.statusCode}`);
      }
      return attempt(true);
    }
    if (res.statusCode >= 400) {
      throw new Error(`${errorLabel}: API ${res.statusCode}`);
    }
    return mapResponse(res);
  };

  return attempt(false);
}
