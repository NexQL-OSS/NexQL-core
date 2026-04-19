/** Snapshot of a single schema for comparison (tables, columns, constraints, indexes). */

export interface SchemaSnapshot {
  tables: TableSnapshot[];
}

export interface TableSnapshot {
  name: string;
  schema: string;
  columns: ColumnSnapshot[];
  constraints: ConstraintSnapshot[];
  indexes: IndexSnapshot[];
}

export interface ColumnSnapshot {
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_value: string | null;
  ordinal: number;
}

export interface ConstraintSnapshot {
  name: string;
  type: string;
  definition: string;
}

export interface IndexSnapshot {
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}

export type DiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface TableDiff {
  name: string;
  status: DiffStatus;
  columnDiffs: ColumnDiff[];
  constraintDiffs: ConstraintDiff[];
  indexDiffs: IndexDiff[];
}

export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  before?: ColumnSnapshot;
  after?: ColumnSnapshot;
}

export interface ConstraintDiff {
  name: string;
  status: DiffStatus;
  before?: ConstraintSnapshot;
  after?: ConstraintSnapshot;
}

export interface IndexDiff {
  name: string;
  status: DiffStatus;
  before?: IndexSnapshot;
  after?: IndexSnapshot;
}
