import { createButton } from '../components/ui';

export const createImportButton = (
  columns: string[],
  tableInfo: any | undefined,
  context?: { postMessage?: (msg: any) => void }
) => {
  const importBtn = createButton('Import', true);
  importBtn.style.position = 'relative';

  if (!tableInfo) {
    importBtn.style.display = 'none';
    return importBtn;
  }

  importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Delegate entirely to the extension host — it will open a native file picker
    // and handle parsing + inserting. No in-iframe modal needed.
    context?.postMessage?.({
      type: 'import_pick_file',
      table: tableInfo.table,
      schema: tableInfo.schema,
      columns,
    });
  });

  return importBtn;
};

// Keep showImportModal exported for any legacy callers, but it now just triggers the host flow.
export function showImportModal(
  tableColumns: string[],
  tableInfo: any,
  context?: { postMessage?: (msg: any) => void }
) {
  context?.postMessage?.({
    type: 'import_pick_file',
    table: tableInfo.table,
    schema: tableInfo.schema,
    columns: tableColumns,
  });
}
