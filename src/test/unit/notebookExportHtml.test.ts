import { expect } from 'chai';
import { escapeHtml, simpleMarkdownToHtml } from '../../features/notebook/notebookExportHtml';

describe('notebookExportHtml', () => {
  it('escapeHtml escapes special characters', () => {
    expect(escapeHtml(`<&>"'`)).to.equal('&amp;&lt;&gt;&quot;&#39;');
  });

  it('simpleMarkdownToHtml handles headers and paragraphs', () => {
    const html = simpleMarkdownToHtml('# Title\n\nHello');
    expect(html).to.contain('<h1>Title</h1>');
    expect(html).to.contain('<p>Hello</p>');
  });
});
