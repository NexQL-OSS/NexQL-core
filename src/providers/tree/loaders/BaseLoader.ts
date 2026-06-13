import { PoolClient } from 'pg';
import { DatabaseTreeProvider, DatabaseTreeItem } from '../../DatabaseTreeProvider';
import type { PlatformProfile } from '../../../lib/platform/PlatformProfile';

export interface LoaderContext {
  provider: DatabaseTreeProvider;
  client: PoolClient;
  element: DatabaseTreeItem;
  pgVer: number;
  platformProfile?: PlatformProfile;
}

export abstract class BaseLoader {
  abstract getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]>;
}
