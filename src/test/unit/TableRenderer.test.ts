import { expect } from 'chai';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';
import { TableRenderer } from '../../renderer/components/table/TableRenderer';

describe('TableRenderer', () => {
  let sandbox: sinon.SinonSandbox;
  let dom: JSDOM;
  let container: HTMLElement;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
    (global as any).MouseEvent = dom.window.MouseEvent;
    (global as any).Event = dom.window.Event;
    (global as any).IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    };
    container = dom.window.document.getElementById('root') as HTMLElement;
  });

  afterEach(() => {
    sandbox.restore();
    dom.window.close();
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).MouseEvent;
    delete (global as any).Event;
    delete (global as any).IntersectionObserver;
  });

  it('keeps edits tied to the underlying source row after sorting', async () => {
    const rows = [
      { id: 2, name: 'Bravo' },
      { id: 1, name: 'Alpha' },
    ];
    const originalRows = JSON.parse(JSON.stringify(rows));
    const modifiedCells = new Map<string, { originalValue: any; newValue: any }>();
    const onDataChange = sandbox.spy();

    const renderer = new TableRenderer(container, {
      onDataChange,
    });

    renderer.render({
      columns: ['id', 'name'],
      rows,
      originalRows,
      columnTypes: {
        id: 'int4',
        name: 'text',
      },
      tableInfo: {
        schema: 'public',
        table: 'users',
        primaryKeys: ['id'],
      } as any,
      modifiedCells,
      sortState: {
        column: 'id',
        direction: 'asc',
      },
      foreignKeys: [],
    });

    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows).to.have.length(2);

    const firstDataRow = bodyRows[0] as HTMLTableRowElement;
    const editableCell = firstDataRow.querySelectorAll('td')[2] as HTMLElement;
    expect(editableCell.textContent).to.equal('Alpha');

    editableCell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));

    const editor = editableCell.querySelector('input') as HTMLInputElement;
    expect(editor).to.exist;
    editor.value = 'Changed';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    editor.dispatchEvent(new dom.window.Event('blur'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDataChange.calledOnce).to.be.true;
    expect(onDataChange.firstCall.args).to.deep.equal([1, 'name', 'Changed', 'Alpha']);
    expect(rows[1].name).to.equal('Changed');
    expect(rows[0].name).to.equal('Bravo');
    expect(modifiedCells.has('1-name')).to.be.true;
    expect(modifiedCells.has('0-name')).to.be.false;
  });

  it('virtualizes large result sets so most rows are not in the DOM', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, v: `row-${i}` }));
    const originalRows = JSON.parse(JSON.stringify(rows));

    const renderer = new TableRenderer(container, {});
    renderer.render({
      columns: ['id', 'v'],
      rows,
      originalRows,
      columnTypes: { id: 'int4', v: 'text' },
      tableInfo: { schema: 'public', table: 't', primaryKeys: ['id'] } as any,
      foreignKeys: [],
    });

    const dataRows = container.querySelectorAll('tbody tr[data-source-index]');
    expect(dataRows.length).to.be.lessThan(rows.length);
    expect(dataRows.length).to.be.at.least(1);

    renderer.dispose();
  });

  it('sets aria-sort on the active sort column header', () => {
    const rows = [{ id: 1, n: 'a' }];
    const renderer = new TableRenderer(container, {});
    renderer.render({
      columns: ['id', 'n'],
      rows,
      originalRows: JSON.parse(JSON.stringify(rows)),
      columnTypes: { id: 'int4', n: 'text' },
      sortState: { column: 'n', direction: 'asc' },
      foreignKeys: [],
    });

    const sortedHeader = container.querySelector('thead th[aria-sort="ascending"]');
    expect(sortedHeader?.textContent).to.include('n');

    renderer.dispose();
  });
});
