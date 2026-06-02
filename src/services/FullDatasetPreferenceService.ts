import { extensionContext } from '../extension';

const STORAGE_KEY = 'pgstudio.fullDatasetByCell.v1';

type FullDatasetByCell = Record<string, boolean>;

function readMap(): FullDatasetByCell {
  return extensionContext?.workspaceState.get<FullDatasetByCell>(STORAGE_KEY, {}) ?? {};
}

async function writeMap(map: FullDatasetByCell): Promise<void> {
  if (!extensionContext) {
    return;
  }
  await extensionContext.workspaceState.update(STORAGE_KEY, map);
}

/** Per-cell sticky preference to run SELECT results without streaming window or auto-LIMIT. */
export class FullDatasetPreferenceService {
  public static hasCommentDirective(sql: string): boolean {
    return /\bpgstudio:(?:full-dataset|no-stream)\b/i.test(sql);
  }

  public static isEnabled(cellUri: string, sql?: string): boolean {
    if (sql && FullDatasetPreferenceService.hasCommentDirective(sql)) {
      return true;
    }
    return readMap()[cellUri] === true;
  }

  public static async toggle(cellUri: string): Promise<boolean> {
    const map = readMap();
    const next = !map[cellUri];
    if (next) {
      map[cellUri] = true;
    } else {
      delete map[cellUri];
    }
    await writeMap(map);
    return next;
  }

  public static async clear(cellUri: string): Promise<void> {
    const map = readMap();
    if (!(cellUri in map)) {
      return;
    }
    delete map[cellUri];
    await writeMap(map);
  }
}
