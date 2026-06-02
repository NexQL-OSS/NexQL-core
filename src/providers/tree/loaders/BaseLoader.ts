import { PoolClient } from 'pg';
import { DatabaseTreeProvider, DatabaseTreeItem } from '../../DatabaseTreeProvider';

export interface LoaderContext {
  provider: DatabaseTreeProvider;
  client: PoolClient;
  element: DatabaseTreeItem;
  pgVer: number;
}

export abstract class BaseLoader {
  abstract getChildren(ctx: LoaderContext): Promise<DatabaseTreeItem[]>;
}
