import { expect } from 'chai';
import * as vscode from 'vscode';

import { QueryCodeLensProvider } from '../../providers/QueryCodeLensProvider';

function createNotebookCellDocument(
  text: string,
  languageId: 'sql' | 'postgres' = 'sql',
  uriSuffix = 'cell-1'
) {
  return new vscode.TextDocument(
    text,
    vscode.Uri.parse(`vscode-notebook-cell:/query-code-lens/${uriSuffix}`),
    languageId
  );
}

function attachNotebookForDocument(document: vscode.TextDocument, metadata: any = { connectionId: 'conn-1', databaseName: 'appdb' }) {
  const notebook = new vscode.NotebookDocument(vscode.Uri.file('/workspace/query-notebook.pgsql'), metadata);
  const cell = new vscode.NotebookCell(document, 0, vscode.NotebookCellKind.Code);
  notebook.getCells = () => [cell];
  vscode.workspace.notebookDocuments = [notebook];
  return notebook;
}

describe('QueryCodeLensProvider', () => {
  afterEach(() => {
    (QueryCodeLensProvider as any)._instance = undefined;
    vscode.workspace.notebookDocuments = [];
  });

  it('tracks singleton state and fires change events', () => {
    const provider = new QueryCodeLensProvider();
    QueryCodeLensProvider.setInstance(provider);

    expect(QueryCodeLensProvider.getInstance()).to.equal(provider);

    let changeCount = 0;
    const listener = provider.onDidChangeCodeLenses(() => {
      changeCount += 1;
    });

    const cellUri = 'vscode-notebook-cell:/query-code-lens/cell-1';
    provider.setAiWorking(cellUri, true);
    expect(provider.isAiWorking(cellUri)).to.be.true;

    provider.updatePill(cellUri, { success: true, elapsedSeconds: 1.4, rowCount: 3 });
    provider.refresh();
    provider.setAiWorking(cellUri, false);

    expect(provider.isAiWorking(cellUri)).to.be.false;
    expect(changeCount).to.equal(4);

    listener.dispose();
  });

  it('returns no lenses for unsupported documents', () => {
    const provider = new QueryCodeLensProvider();

    expect(provider.provideCodeLenses(createNotebookCellDocument('', 'sql') as any, {} as any)).to.deep.equal([]);
    expect(
      provider.provideCodeLenses(
        new vscode.TextDocument('SELECT 1', vscode.Uri.file('/tmp/query.sql'), 'sql') as any,
        {} as any
      )
    ).to.deep.equal([]);
    expect(
      provider.provideCodeLenses(
        createNotebookCellDocument('SELECT 1', 'postgres'),
        {} as any
      )
    ).to.have.lengthOf(4);
  });

  it('builds lenses for runnable queries and hides explain for explain statements', () => {
    const provider = new QueryCodeLensProvider();

    const queryDocument = createNotebookCellDocument('SELECT u.user_id, o.order_total FROM public.users u JOIN sales.orders o ON o.user_id = u.user_id;');
    attachNotebookForDocument(queryDocument);

    provider.setAiWorking(queryDocument.uri.toString(), true);
    provider.updatePill(queryDocument.uri.toString(), { success: true, elapsedSeconds: 12, rowCount: 99 });

    const queryLenses = provider.provideCodeLenses(queryDocument, {} as any);
    expect(queryLenses).to.have.lengthOf(5);
    expect(queryLenses[0].command?.title).to.equal('$(loading~spin) Working...');
    expect(queryLenses[0].command?.command).to.equal('');
    expect(queryLenses[1].command?.title).to.equal('◻ Chat');
    expect(queryLenses[2].command?.title).to.equal('⊞ Save Query');
    expect(queryLenses[3].command?.title).to.equal('⟐ Explain Analyze');
    expect(queryLenses[3].command?.arguments).to.deep.equal([queryDocument.uri, true]);
    expect(queryLenses[4].command?.title).to.equal('12s · 99 rows');
    expect(queryLenses[4].command?.command).to.equal('');

    const explainDocument = createNotebookCellDocument('EXPLAIN SELECT 1;', 'sql', 'cell-2');
    attachNotebookForDocument(explainDocument);

    const explainLenses = provider.provideCodeLenses(explainDocument, {} as any);
    expect(explainLenses).to.have.lengthOf(3);
    expect(explainLenses.map(lens => lens.command?.title)).to.deep.equal(['✦ Ask AI', '◻ Chat', '⊞ Save Query']);
  });
});