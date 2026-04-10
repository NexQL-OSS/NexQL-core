import { expect } from 'chai';
import * as vscode from 'vscode';

import { deriveNotebookTitle, updateNotebookTitle } from '../../utils/notebookTitle';

function createCodeCell(text: string, index = 0): vscode.NotebookCell {
  return new vscode.NotebookCell(new vscode.TextDocument(text), index, vscode.NotebookCellKind.Code);
}

function createNotebook(path: string, metadata: any, ...cells: string[]): vscode.NotebookDocument {
  const notebook = new vscode.NotebookDocument(vscode.Uri.file(path), metadata);
  notebook.getCells = () => cells.map((text, index) => createCodeCell(text, index));
  return notebook;
}

describe('notebook title helpers', () => {
  it('derives a title from notebook SQL content', () => {
    expect(deriveNotebookTitle(['SELECT * FROM public.users;'])).to.equal('View public.users');
    expect(deriveNotebookTitle(['SELECT id, name, email FROM a_table_with_a_very_long_select_statement_that_needs_truncation;']))
      .to.match(/^SELECT id, name, email FROM a_table_with_a_very_/);
    expect(deriveNotebookTitle(['INSERT INTO public.users VALUES (1);'])).to.equal('');
  });

  it('updates notebook metadata when the derived title changes', async () => {
    const notebook = createNotebook('/workspace/customer-report.pgsql', {}, 'SELECT * FROM public.customers;');
    const previousApplyEdit = (vscode.workspace as any).applyEdit;
    const calls: any[] = [];
    (vscode.workspace as any).applyEdit = async (edit: any) => {
      calls.push(edit);
      return true;
    };

    try {
      await updateNotebookTitle(notebook);

      expect(calls).to.have.lengthOf(1);
      const edit = calls[0] as any;
      const edits = Array.from(edit.map.values()) as any[];
      expect(edits).to.have.lengthOf(1);
      expect(edits[0][0].metadata.title).to.equal('View public.customers');
    } finally {
      (vscode.workspace as any).applyEdit = previousApplyEdit;
    }
  });

  it('falls back to the notebook file name when there is no SELECT statement', async () => {
    const notebook = createNotebook('/workspace/monthly-report.pgsql', {}, 'INSERT INTO public.customers VALUES (1);');
    const previousApplyEdit = (vscode.workspace as any).applyEdit;
    const calls: any[] = [];
    (vscode.workspace as any).applyEdit = async (edit: any) => {
      calls.push(edit);
      return true;
    };

    try {
      await updateNotebookTitle(notebook);

      expect(calls).to.have.lengthOf(1);
      const edit = calls[0] as any;
      const edits = Array.from(edit.map.values()) as any[];
      expect(edits[0][0].metadata.title).to.equal('monthly-report');
    } finally {
      (vscode.workspace as any).applyEdit = previousApplyEdit;
    }
  });

  it('skips the edit when the current title already matches', async () => {
    const notebook = createNotebook('/workspace/customer-report.pgsql', { title: 'View public.customers' }, 'SELECT * FROM public.customers;');
    const previousApplyEdit = (vscode.workspace as any).applyEdit;
    const calls: any[] = [];
    (vscode.workspace as any).applyEdit = async (edit: any) => {
      calls.push(edit);
      return true;
    };

    try {
      await updateNotebookTitle(notebook);

      expect(calls).to.be.empty;
    } finally {
      (vscode.workspace as any).applyEdit = previousApplyEdit;
    }
  });
});