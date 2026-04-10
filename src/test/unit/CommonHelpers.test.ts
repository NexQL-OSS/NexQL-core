import { expect } from 'chai';

import {
  CSS_VARIABLES,
  COMMON_STYLES,
  HtmlBuilder,
  MarkdownBuilder,
  NotebookTemplates,
  styleToString,
} from '../../common/htmlStyles';
import {
  createGradient,
  darkenColor,
  formatDate,
  formatValue,
  formatValueForSQL,
  getNumericColumns,
  getTimezoneAbbr,
  hexToRgba,
  isDateColumn,
  rgbaToHex,
} from '../../renderer/utils/formatting';
import { deriveNotebookTitle, parseBreadcrumbFromSql } from '../../renderer/utils/sqlParsing';

function expectContainsAll(text: string, fragments: string[]): void {
  for (const fragment of fragments) {
    expect(text).to.contain(fragment);
  }
}

describe('shared helpers', () => {
  it('formats styles and markdown helpers', () => {
    expect(CSS_VARIABLES.editorBackground).to.contain('vscode-editor-background');
    expect(COMMON_STYLES.buttonDanger.color).to.equal(CSS_VARIABLES.errorForeground);

    expect(styleToString({ fontSize: '12px', lineHeight: 1.5, backgroundColor: '#fff' })).to.equal(
      'font-size: 12px; line-height: 1.5; background-color: #fff'
    );

    expectContainsAll(MarkdownBuilder.infoBox('Use this query', 'Note'), ['<strong>ℹ️ Note:</strong>', 'Use this query']);
    expectContainsAll(MarkdownBuilder.warningBox('Danger ahead'), ['<strong>⚠️ Warning:</strong>', 'Danger ahead']);
    expectContainsAll(MarkdownBuilder.successBox('Looks good', 'Tip'), ['<strong>💡 Tip:</strong>', 'Looks good']);
    expectContainsAll(MarkdownBuilder.dangerBox('Stop now'), ['<strong>🛑 Caution:</strong>', 'Stop now']);
    expect(MarkdownBuilder.heading('Summary', 4, '📊')).to.equal('#### 📊 Summary');
    expect(MarkdownBuilder.divider()).to.equal('\n---\n');
    expect(MarkdownBuilder.codeBlock('SELECT 1;', 'sql')).to.equal('```sql\nSELECT 1;\n```');
    expect(MarkdownBuilder.inlineCode('value')).to.equal('`value`');
    expect(MarkdownBuilder.badge('ready', 'success')).to.contain('ready');
    expect(MarkdownBuilder.button('Run', 'runQuery()')).to.contain('onclick="runQuery()"');
    expect(MarkdownBuilder.dangerButton('Drop', 'dropQuery()')).to.contain('Drop');

    const table = MarkdownBuilder.table(['Name', 'Value'], [['one', '1']]);
    expectContainsAll(table, ['<table', '<th style=', 'Name', '<td style=', 'one']);

    const htmlButton = HtmlBuilder.button('Save', 'save()', 'secondary', 'Save the row');
    expectContainsAll(htmlButton, ['<button', 'onclick="save()"', 'title="Save the row"']);
    expect(HtmlBuilder.button('Delete', 'drop()', 'danger')).to.contain('var(--vscode-errorForeground');
    expect(HtmlBuilder.container('content', { marginBottom: '0' })).to.contain('content');

    const successHeader = HtmlBuilder.collapsibleHeader('Details', '2 rows', true);
    expectContainsAll(successHeader, ['Details', '2 rows', 'border-left']);
    expect(HtmlBuilder.skeletonRow()).to.contain('animation: skeleton-pulse');
    expect(HtmlBuilder.skeletonRow(['25%', '75%'])).to.contain('width: 25%');
    expect(HtmlBuilder.emptyState('Nothing here', 'Reload', 'reload()')).to.contain('Nothing here');

    expect(NotebookTemplates.header('My Title', 'Description', '🗂️')).to.contain('My Title');
    expect(NotebookTemplates.operationsTable([
      { name: 'Refresh', description: 'Reload data', riskLevel: 'Low' },
    ])).to.contain('Refresh');
    expect(NotebookTemplates.safetyChecklist(['Verify the target table', 'Take a backup'])).to.contain('✅');
    expect(NotebookTemplates.sectionHeader('Operations', '⚙️')).to.equal('##### ⚙️ Operations');
  });

  it('parses and derives notebook titles from SQL snippets', () => {
    expect(parseBreadcrumbFromSql('SELECT * FROM public.users;')).to.deep.equal({ schema: 'public', table: 'users' });
    expect(parseBreadcrumbFromSql('SELECT * FROM "Sales"."Monthly Report";')).to.deep.equal({ schema: 'Sales', table: 'Monthly Report' });
    expect(parseBreadcrumbFromSql('SELECT * FROM users;')).to.deep.equal({});

    expect(deriveNotebookTitle(['SELECT * FROM public.users;'])).to.equal('View public.users');
    expect(deriveNotebookTitle(['SELECT id, name, email FROM very_long_table_name_that_should_be_trimmed_to_fit the screen;']))
      .to.match(/^SELECT id, name, email FROM very_long_table_name_/);
    expect(deriveNotebookTitle(['INSERT INTO public.users VALUES (1);'])).to.equal('');
  });

  it('formats values and color helpers', () => {
    expect(getNumericColumns(['amount', 'name', 'empty'], [
      { amount: '1', name: 'alpha', empty: null },
      { amount: 2, name: 'beta', empty: undefined },
      { amount: '3.5', name: 'gamma', empty: '' },
    ])).to.deep.equal(['amount']);

    expect(isDateColumn('created_at')).to.be.true;
    expect(isDateColumn('value')).to.be.false;
    expect(isDateColumn('value', { value: 'timestamp with time zone' })).to.be.true;

    expect(getTimezoneAbbr(new Date('2024-06-15T12:00:00.000Z'))).to.be.a('string').and.not.empty;
    expect(formatDate('2024-06-15T12:00:00.000Z', 'YYYY-MM-DD HH:mm:ss SSS TZ')).to.contain('2024');
    expect(formatDate('not-a-date', 'YYYY')).to.equal('not-a-date');

    expect(formatValueForSQL(null)).to.equal('NULL');
    expect(formatValueForSQL(42, 'integer')).to.equal('42');
    expect(formatValueForSQL(true, 'boolean')).to.equal('true');
    expect(formatValueForSQL("O'Reilly")).to.equal("'O''Reilly'");

    expect(formatValue(null)).to.deep.equal({ text: 'NULL', isNull: true, type: 'null' });
    expect(formatValue(false)).to.deep.equal({ text: 'FALSE', isNull: false, type: 'boolean' });
    expect(formatValue(99)).to.deep.equal({ text: '99', isNull: false, type: 'number' });
    expect(formatValue(new Date('2024-06-15T12:00:00.000Z')).type).to.equal('date');
    expect(formatValue({ key: 'value' }).text).to.equal('{"key":"value"}');
    expect(formatValue('2024-06-15T12:00:00.000Z', 'timestamp').type).to.equal('timestamp');
    expect(formatValue('2024-06-15', 'date').type).to.equal('date');
    expect(formatValue('12:30:00', 'timetz').type).to.equal('time');

    expect(rgbaToHex('rgba(255, 0, 17, 0.6)')).to.equal('#ff0011');
    expect(rgbaToHex('not rgba')).to.equal('not rgba');
    expect(hexToRgba('#112233', 0.5)).to.equal('rgba(17, 34, 51, 0.5)');
    expect(darkenColor('rgba(100, 120, 140, 0.6)')).to.equal('rgba(100, 120, 140, 0.8)');

    let gradientArgs: any[] = [];
    const gradientStops: Array<[number, string]> = [];
    const gradient = {
      addColorStop(position: number, color: string) {
        gradientStops.push([position, color]);
      }
    };
    const ctx = {
      createLinearGradient: (...args: any[]) => {
        gradientArgs = args;
        return gradient;
      }
    } as any;

    expect(createGradient(ctx, 1, undefined, false)).to.equal(gradient);
    expect(gradientArgs).to.deep.equal([0, 0, 400, 0]);
    expect(gradientStops).to.deep.equal([
      [0, 'rgba(255, 99, 132, 0.6)'],
      [1, 'rgba(255, 99, 132, 0.1)'],
    ]);

    const customStops: Array<[number, string]> = [];
    const customCtx = {
      createLinearGradient: (...args: any[]) => ({
        args,
        addColorStop(position: number, color: string) {
          customStops.push([position, color]);
        }
      })
    } as any;
    createGradient(customCtx, 0, 'rgba(10, 20, 30, 0.6)', true);
    expect(customStops).to.deep.equal([
      [0, 'rgba(10, 20, 30, 0.6)'],
      [1, 'rgba(10, 20, 30, 0.1)'],
    ]);
  });
});