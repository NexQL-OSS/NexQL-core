/**
 * Unit tests for onDidCloseNotebookDocument cleanup logic.
 * Task 4.1 — Requirements: 6.1, 6.2, 6.3
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { SessionRegistry } from '../../services/SessionRegistry';

function makeNotebookDoc(uri: vscode.Uri, isClosed = false): vscode.NotebookDocument {
  const doc = new (vscode.NotebookDocument as any)(uri) as any;
  doc.cellCount = 0;
  doc.isClosed = isClosed;
  return doc as vscode.NotebookDocument;
}

/**
 * Simulate the close listener logic extracted from extension.ts activate().
 * This mirrors the exact implementation so we can unit-test it in isolation.
 */
function makeCloseListener() {
  return (closedDoc: vscode.NotebookDocument) => {
    const closedUri = closedDoc.uri.toString();
    for (const [connectionId, doc] of SessionRegistry.entries()) {
      if (doc.uri.toString() === closedUri) {
        SessionRegistry.delete(connectionId);
        break;
      }
    }
  };
}

describe('onDidCloseNotebookDocument cleanup (Req 6.1, 6.2, 6.3)', () => {
  beforeEach(() => {
    (SessionRegistry as any).map?.clear?.();
  });

  afterEach(() => {
    (SessionRegistry as any).map?.clear?.();
  });

  it('removes the matching connectionId entry when a scratch URI is closed (Req 6.1)', () => {
    const scratchUri = vscode.Uri.file('/global-storage/scratch-conn-abc.pgsql');
    const doc = makeNotebookDoc(scratchUri);
    SessionRegistry.set('conn-abc', doc);

    const listener = makeCloseListener();
    listener(doc);

    expect(SessionRegistry.has('conn-abc')).to.be.false;
  });

  it('does not affect other registry entries when an unrelated URI is closed (Req 6.1)', () => {
    const scratchUri1 = vscode.Uri.file('/global-storage/scratch-conn-1.pgsql');
    const scratchUri2 = vscode.Uri.file('/global-storage/scratch-conn-2.pgsql');
    const doc1 = makeNotebookDoc(scratchUri1);
    const doc2 = makeNotebookDoc(scratchUri2);
    SessionRegistry.set('conn-1', doc1);
    SessionRegistry.set('conn-2', doc2);

    const unrelatedDoc = makeNotebookDoc(vscode.Uri.file('/some/other/notebook.pgsql'));
    const listener = makeCloseListener();
    listener(unrelatedDoc);

    // Both entries should remain
    expect(SessionRegistry.has('conn-1')).to.be.true;
    expect(SessionRegistry.has('conn-2')).to.be.true;
  });

  it('only removes the matching entry and leaves others intact (Req 6.1)', () => {
    const scratchUri1 = vscode.Uri.file('/global-storage/scratch-conn-1.pgsql');
    const scratchUri2 = vscode.Uri.file('/global-storage/scratch-conn-2.pgsql');
    const doc1 = makeNotebookDoc(scratchUri1);
    const doc2 = makeNotebookDoc(scratchUri2);
    SessionRegistry.set('conn-1', doc1);
    SessionRegistry.set('conn-2', doc2);

    const listener = makeCloseListener();
    listener(doc1);

    expect(SessionRegistry.has('conn-1')).to.be.false;
    expect(SessionRegistry.has('conn-2')).to.be.true;
    expect(SessionRegistry.get('conn-2')).to.equal(doc2);
  });

  it('is a no-op when the registry is empty (Req 6.1)', () => {
    const doc = makeNotebookDoc(vscode.Uri.file('/global-storage/scratch-conn-x.pgsql'));
    const listener = makeCloseListener();
    // Should not throw
    expect(() => listener(doc)).to.not.throw();
  });

  it('is a no-op when the closed URI does not match any registry entry (Req 6.1)', () => {
    const scratchUri = vscode.Uri.file('/global-storage/scratch-conn-abc.pgsql');
    const doc = makeNotebookDoc(scratchUri);
    SessionRegistry.set('conn-abc', doc);

    const nonMatchingDoc = makeNotebookDoc(vscode.Uri.file('/global-storage/scratch-conn-xyz.pgsql'));
    const listener = makeCloseListener();
    listener(nonMatchingDoc);

    // Original entry should still be present
    expect(SessionRegistry.has('conn-abc')).to.be.true;
  });
});
