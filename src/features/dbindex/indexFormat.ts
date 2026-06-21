import { IndexManifest } from './types';

export const CURRENT_FORMAT_VERSION = 1;

/**
 * Migration registry mapping source format versions to their migration logic.
 * The output of migration (v) is fed as the input of migration (v+1).
 */
const MIGRATIONS: Record<number, (json: any) => any> = {
  // Version migrations will be added here as the format version increments.
  // Example:
  // 1: (json) => { ... return migratedJson; }
};

/**
 * Safely parses and migrates a manifest file to the current format version.
 * If the version is too new or unsupported, throws an error (which triggers rebuild).
 */
export function migrateManifest(rawJson: string): IndexManifest {
  const data = JSON.parse(rawJson);
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid manifest file: not an object');
  }

  let version = data.formatVersion;
  if (typeof version !== 'number') {
    throw new Error('Invalid manifest file: missing formatVersion');
  }

  if (version > CURRENT_FORMAT_VERSION) {
    throw new Error(`Manifest format version ${version} is newer than current ${CURRENT_FORMAT_VERSION}`);
  }

  let currentData = data;
  while (version < CURRENT_FORMAT_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(`No migration path found from format version ${version}`);
    }
    currentData = migration(currentData);
    version = currentData.formatVersion;
  }

  return currentData as IndexManifest;
}
