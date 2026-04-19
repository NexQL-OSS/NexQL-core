export type { CloudAuthKind, CloudAuthContext } from './types';
import type { CloudAuthContext, CloudAuthKind } from './types';

/**
 * Normalise persisted or form JSON into a {@link CloudAuthContext}.
 * Unknown values default to `none` (password / standard auth).
 */
export function parseCloudAuth(raw: unknown): CloudAuthContext {
  if (raw && typeof raw === 'object' && 'kind' in raw) {
    const k = (raw as { kind?: string }).kind;
    if (k === 'aws-iam' || k === 'azure-ad' || k === 'gcp-iam') {
      return { kind: k as CloudAuthKind };
    }
  }
  return { kind: 'none' };
}
