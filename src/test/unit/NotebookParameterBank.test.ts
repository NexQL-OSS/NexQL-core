import { expect } from 'chai';
import * as sinon from 'sinon';
import {
  clearNotebookParameterValues,
  getNotebookParameterValues,
  rememberNotebookParameterValue,
} from '../../services/NotebookParameterBank';

function createWorkspaceState(initialState: Record<string, any> = {}) {
  const state = { ...initialState };
  return {
    get: <T>(key: string, defaultValue?: T) => (key in state ? state[key] : defaultValue),
    update: sinon.stub().callsFake(async (key: string, value: any) => {
      state[key] = value;
    }),
    state,
  };
}

describe('NotebookParameterBank', () => {
  it('keeps parameter values notebook-local and most-recent first', async () => {
    const workspaceState = createWorkspaceState();

    await rememberNotebookParameterValue(workspaceState as any, 'notebook-a', 'named:customer_id', '10');
    await rememberNotebookParameterValue(workspaceState as any, 'notebook-a', 'named:customer_id', '12');
    await rememberNotebookParameterValue(workspaceState as any, 'notebook-b', 'named:customer_id', '99');

    expect(getNotebookParameterValues(workspaceState as any, 'notebook-a', 'named:customer_id')).to.deep.equal(['12', '10']);
    expect(getNotebookParameterValues(workspaceState as any, 'notebook-b', 'named:customer_id')).to.deep.equal(['99']);
  });

  it('clears one parameter bucket without affecting the rest of the notebook', async () => {
    const workspaceState = createWorkspaceState({
      'pgstudio.notebookParameterBank.v1': {
        'notebook-a': {
          'named:customer_id': ['10'],
          'named:status': ['active'],
        },
      },
    });

    await clearNotebookParameterValues(workspaceState as any, 'notebook-a', 'named:customer_id');

    expect(getNotebookParameterValues(workspaceState as any, 'notebook-a', 'named:customer_id')).to.deep.equal([]);
    expect(getNotebookParameterValues(workspaceState as any, 'notebook-a', 'named:status')).to.deep.equal(['active']);
  });
});