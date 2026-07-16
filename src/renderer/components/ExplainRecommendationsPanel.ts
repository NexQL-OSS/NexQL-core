import { PerformanceRecommendation } from '../../services/queryPerformance/QueryPerformanceAnalyzer';

/**
 * UI panel for displaying performance recommendations
 * Renders in VS Code notebook webview context
 */
export class ExplainRecommendationsPanel {
  private recommendations: PerformanceRecommendation[] = [];

  constructor(private container: HTMLElement) {}

  /**
   * Render recommendations panel
   */
  public render(
    recommendations: PerformanceRecommendation[],
    query?: string,
    options?: { onSendToAssistant?: () => void },
  ): void {
    this.recommendations = recommendations;
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'recommendations-panel';
    wrapper.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      gap: 10px;
    `;

    // Header
    wrapper.appendChild(this.renderHeader(recommendations.length, options));

    // Query info (optional)
    if (query) {
      wrapper.appendChild(this.renderQueryInfo(query));
    }

    // Recommendations list
    if (recommendations.length > 0) {
      wrapper.appendChild(this.renderRecommendationsList());
    } else {
      wrapper.appendChild(this.renderEmptyState());
    }

    this.container.appendChild(wrapper);
  }

  /**
   * Render header
   */
  private renderHeader(count: number, options?: { onSendToAssistant?: () => void }): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 12px 16px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    `;

    const left = document.createElement('div');

    const title = document.createElement('h2');
    title.textContent = `🔧 Performance Recommendations (${count})`;
    title.style.cssText = `
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
    `;
    left.appendChild(title);
    header.appendChild(left);

    if (options?.onSendToAssistant) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Send to SQL Assistant';
      button.style.cssText = `
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 35%, var(--vscode-widget-border));
        background: color-mix(in srgb, var(--vscode-button-background) 30%, transparent);
        color: var(--vscode-button-foreground);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      `;
      button.onmouseover = () => {
        button.style.background = 'color-mix(in srgb, var(--vscode-button-hoverBackground) 55%, transparent)';
      };
      button.onmouseout = () => {
        button.style.background = 'color-mix(in srgb, var(--vscode-button-background) 30%, transparent)';
      };
      button.onclick = options.onSendToAssistant;
      header.appendChild(button);
    }

    return header;
  }

  /**
   * Render query info box
   */
  private renderQueryInfo(query: string): HTMLElement {
    const infoBox = document.createElement('div');
    infoBox.style.cssText = `
      padding: 12px 16px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 96%, transparent);
      font-size: 12px;
    `;

    const label = document.createElement('div');
    label.textContent = 'Query:';
    label.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    infoBox.appendChild(label);

    const code = document.createElement('code');
    code.textContent = query.substring(0, 200) + (query.length > 200 ? '...' : '');
    code.style.cssText = `
      display: block;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border);
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
    `;
    infoBox.appendChild(code);

    return infoBox;
  }

  /**
   * Render recommendations list
   */
  private renderRecommendationsList(): HTMLElement {
    const list = document.createElement('div');
    list.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 0 4px 8px 4px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;

    // Group by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const grouped = this.recommendations.reduce((acc, rec) => {
      const severity = rec.severity;
      if (!acc[severity]) acc[severity] = [];
      acc[severity].push(rec);
      return acc;
    }, {} as Record<string, PerformanceRecommendation[]>);

    for (const severity of Object.keys(severityOrder)) {
      if (grouped[severity]) {
        for (const rec of grouped[severity]) {
          list.appendChild(this.renderRecommendationCard(rec));
        }
      }
    }

    return list;
  }

  /**
   * Render single recommendation card
   */
  private renderRecommendationCard(rec: PerformanceRecommendation): HTMLElement {
    const card = document.createElement('div');
    
    const severityColors: Record<string, string> = {
      critical: '#ff6b6b',
      high: '#ff9f40',
      medium: '#ffd700',
      low: '#64c8ff'
    };

    const severityIcons: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵'
    };

    const borderColor = severityColors[rec.severity] || '#999';
    const icon = severityIcons[rec.severity] || '•';

    card.style.cssText = `
      padding: 12px 14px;
      border: 1px solid var(--vscode-widget-border);
      border-left: 4px solid ${borderColor};
      background: color-mix(in srgb, var(--vscode-editor-background) 96%, transparent);
      border-radius: 10px;
    `;

    // Title
    const title = document.createElement('div');
    title.style.cssText = `
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    title.innerHTML = `${icon} ${this.escapeHtml(rec.title)}`;
    card.appendChild(title);

    // Category badge
    const categoryBadge = document.createElement('span');
    categoryBadge.textContent = rec.category.toUpperCase();
    categoryBadge.style.cssText = `
      display: inline-block;
      background: color-mix(in srgb, ${borderColor} 22%, transparent);
      color: ${borderColor};
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      margin-right: 8px;
    `;
    card.appendChild(categoryBadge);

    // Improvement badge
    const improvementBadge = document.createElement('span');
    improvementBadge.textContent = `📈 ${rec.estimatedImprovement}`;
    improvementBadge.style.cssText = `
      display: inline-block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    `;
    card.appendChild(improvementBadge);

    // Description
    const description = document.createElement('div');
    description.style.cssText = `
      margin-top: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    `;
    description.textContent = rec.description;
    card.appendChild(description);

    // Suggestion code block
    const suggestionContainer = document.createElement('div');
    suggestionContainer.style.cssText = 'margin-top: 8px;';
    
    const suggestionLabel = document.createElement('div');
    suggestionLabel.textContent = 'Suggestion:';
    suggestionLabel.style.cssText = `
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
    `;
    suggestionContainer.appendChild(suggestionLabel);

    const suggestionCode = document.createElement('code');
    suggestionCode.textContent = rec.suggestion;
    suggestionCode.style.cssText = `
      display: block;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      padding: 8px;
      border-radius: 8px;
      border: 1px solid var(--vscode-widget-border);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      overflow-x: auto;
      word-break: break-word;
    `;
    suggestionContainer.appendChild(suggestionCode);

    // Copy button
    const copyButton = document.createElement('button');
    copyButton.textContent = '📋 Copy';
    copyButton.style.cssText = `
      margin-top: 4px;
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      transition: background 0.2s;
    `;
    copyButton.onmouseover = () => {
      copyButton.style.background = 'color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent)';
    };
    copyButton.onmouseout = () => {
      copyButton.style.background = 'transparent';
    };
    copyButton.onclick = () => {
      navigator.clipboard.writeText(rec.suggestion).then(() => {
        const originalText = copyButton.textContent;
        copyButton.textContent = '✓ Copied!';
        setTimeout(() => {
          copyButton.textContent = originalText;
        }, 2000);
      });
    };
    suggestionContainer.appendChild(copyButton);
    
    card.appendChild(suggestionContainer);

    return card;
  }

  /**
   * Render empty state
   */
  private renderEmptyState(): HTMLElement {
    const empty = document.createElement('div');
    empty.style.cssText = `
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      color: #999;
    `;
    empty.innerHTML = `
      <div style="font-size: 48px; margin-bottom: 12px;">✨</div>
      <div style="font-size: 14px; font-weight: 600;">No recommendations</div>
      <div style="font-size: 12px; margin-top: 4px;">Your query plan looks optimal!</div>
    `;
    return empty;
  }

  /**
   * Export recommendations as JSON
   */
  public export(): PerformanceRecommendation[] {
    return [...this.recommendations];
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
