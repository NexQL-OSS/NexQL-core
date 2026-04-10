/**
 * Common HTML/CSS styles and utilities for consistent UI across the extension
 * This module provides reusable style definitions and HTML template builders
 *
 * Design system:
 *   - 4px base unit: 8px internal padding, 16px between sections, 24px between groups
 *   - Typography: section headers 12px/500, body 12–13px/400, meta/labels 11px/400 muted
 *   - Destructive actions: always text-danger colored, never primary button
 *   - Hover affordance: contextual actions visible only on row hover
 *   - Loading: pulsing skeleton shimmer, no spinner-in-blank-space
 *   - Empty states: 1-line prompt + single CTA button
 *   - Tooltips: title attribute on all icon-only buttons
 */

/**
 * Shared CSS block injected into every webview <style> tag.
 * Provides skeleton shimmer, empty-state, destructive button, and hover-action utilities.
 */
export const SHARED_WEBVIEW_CSS = `
/* ── 4px spacing tokens ── */
:root {
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-6: 24px;
  --sp-8: 32px;
}

/* ── Typography scale ── */
.text-section-header { font-size: 12px; font-weight: 500; }
.text-body           { font-size: 13px; font-weight: 400; }
.text-body-sm        { font-size: 12px; font-weight: 400; }
.text-meta           { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); }

/* ── Skeleton loading shimmer ── */
@keyframes skeleton-pulse {
  0%   { opacity: 0.45; }
  50%  { opacity: 0.9; }
  100% { opacity: 0.45; }
}
.skeleton {
  background: var(--vscode-widget-border);
  border-radius: 3px;
  animation: skeleton-pulse 1.6s ease-in-out infinite;
  pointer-events: none;
  user-select: none;
}
.skeleton-row {
  height: 20px;
  margin: 6px 0;
  border-radius: 3px;
}
.skeleton-text {
  height: 12px;
  border-radius: 2px;
  display: inline-block;
}

/* ── Empty state ── */
.empty-state-simple {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6) var(--sp-4);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  text-align: center;
}
.empty-state-simple .empty-cta {
  margin-top: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  font-size: 12px;
  font-weight: 500;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.empty-state-simple .empty-cta:hover { background: var(--vscode-button-hoverBackground); }

/* ── Destructive button ── */
.btn-danger {
  background: transparent !important;
  color: var(--vscode-errorForeground) !important;
  border: 1px solid var(--vscode-errorForeground) !important;
  border-radius: 3px;
  padding: var(--sp-1) var(--sp-3);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent) !important;
}

/* ── Hover-reveal row actions ── */
.hover-row { position: relative; }
.hover-row .row-actions {
  position: absolute;
  right: var(--sp-2);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: var(--sp-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.hover-row:hover .row-actions {
  opacity: 1;
  pointer-events: auto;
}
.row-action-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 3px;
  padding: 2px var(--sp-1);
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.row-action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.row-action-btn.danger { color: var(--vscode-errorForeground); }
.row-action-btn.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
`;

/**
 * CSS Variables and Theme-aware styles
 */
export const CSS_VARIABLES = {
    // Colors
    editorBackground: 'var(--vscode-editor-background)',
    editorForeground: 'var(--vscode-editor-foreground)',
    buttonBackground: 'var(--vscode-button-background)',
    buttonForeground: 'var(--vscode-button-foreground)',
    buttonSecondaryBackground: 'var(--vscode-button-secondaryBackground)',
    buttonSecondaryForeground: 'var(--vscode-button-secondaryForeground)',
    widgetBorder: 'var(--vscode-widget-border)',
    panelBorder: 'var(--vscode-panel-border)',
    textBlockQuoteBackground: 'var(--vscode-textBlockQuote-background)',
    textBlockQuoteBorder: 'var(--vscode-textBlockQuote-border)',
    listHoverBackground: 'var(--vscode-list-hoverBackground)',
    errorForeground: 'var(--vscode-errorForeground)',
    testingIconPassed: 'var(--vscode-testing-iconPassed)',
    debugIconStartForeground: 'var(--vscode-debugIcon-startForeground)',
    menuBackground: 'var(--vscode-menu-background)',
    menuBorder: 'var(--vscode-menu-border)',
    menuForeground: 'var(--vscode-menu-foreground)',
    menuSelectionBackground: 'var(--vscode-menu-selectionBackground)',
    descriptionForeground: 'var(--vscode-descriptionForeground)',
    textLinkForeground: 'var(--vscode-textLink-foreground)',
    focusBorder: 'var(--vscode-focusBorder)',
    
    // Fonts
    fontFamily: 'var(--vscode-font-family)',
    editorFontFamily: 'var(--vscode-editor-font-family)',
} as const;

/**
 * Common inline styles as JavaScript objects for programmatic use.
 * Spacing follows the 4px base unit: 8px internal, 16px between sections, 24px between groups.
 * Typography: section headers 12px/500, body 12–13px/400, meta/labels 11px/400 muted.
 */
export const COMMON_STYLES = {
    container: {
        fontFamily: CSS_VARIABLES.fontFamily,
        fontSize: '13px',
        color: CSS_VARIABLES.editorForeground,
        border: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        borderTop: `2px solid ${CSS_VARIABLES.textLinkForeground}`,
        borderRadius: '4px',
        overflow: 'hidden',
        marginBottom: '8px',
    },
    
    header: {
        padding: '8px 12px',
        background: CSS_VARIABLES.editorBackground,
        borderBottom: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        userSelect: 'none',
        fontSize: '12px',
        fontWeight: '500',
    },
    
    successHeader: {
        background: 'rgba(115, 191, 105, 0.25)',
        borderLeft: `4px solid ${CSS_VARIABLES.testingIconPassed}`,
    },
    
    /** Primary action button — never use for destructive actions */
    button: {
        background: CSS_VARIABLES.buttonBackground,
        color: CSS_VARIABLES.buttonForeground,
        border: 'none',
        padding: '4px 12px',
        cursor: 'pointer',
        borderRadius: '3px',
        fontSize: '12px',
        fontWeight: '500',
    },
    
    buttonSecondary: {
        background: CSS_VARIABLES.buttonSecondaryBackground,
        color: CSS_VARIABLES.buttonSecondaryForeground,
    },

    /** Destructive action button — always text-danger, never primary */
    buttonDanger: {
        background: 'transparent',
        color: CSS_VARIABLES.errorForeground,
        border: `1px solid ${CSS_VARIABLES.errorForeground}`,
        padding: '4px 12px',
        cursor: 'pointer',
        borderRadius: '3px',
        fontSize: '12px',
        fontWeight: '500',
    },
    
    table: {
        width: '100%',
        borderCollapse: 'separate' as const,
        borderSpacing: '0',
        fontSize: '13px',
        whiteSpace: 'nowrap' as const,
        lineHeight: '1.5',
    },
    
    tableHeader: {
        textAlign: 'left' as const,
        padding: '8px 12px',
        borderBottom: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        borderRight: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        fontWeight: '500',
        fontSize: '12px',
        color: CSS_VARIABLES.descriptionForeground,
        position: 'sticky' as const,
        top: '0',
        background: CSS_VARIABLES.editorBackground,
        zIndex: '10',
        userSelect: 'none' as const,
    },
    
    tableCell: {
        padding: '8px 12px',
        borderBottom: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        borderRight: `1px solid ${CSS_VARIABLES.widgetBorder}`,
        color: CSS_VARIABLES.editorForeground,
        fontSize: '13px',
    },
} as const;

/**
 * Convert style object to inline CSS string
 */
export function styleToString(styleObj: Record<string, string | number>): string {
    return Object.entries(styleObj)
        .map(([key, value]) => {
            // Convert camelCase to kebab-case
            const cssKey = key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
            return `${cssKey}: ${value}`;
        })
        .join('; ');
}

/**
 * Markdown template builders for notebook cells.
 * All callout boxes use consistent padding (8px 12px), border-radius (3px),
 * font-size (12px), and the shared VS Code theme variables.
 */
export class MarkdownBuilder {
    /**
     * Create an info box with icon and message
     */
    static infoBox(message: string, title: string = 'Note'): string {
        return `<div style="font-size: 12px; background-color: color-mix(in srgb, ${CSS_VARIABLES.textLinkForeground} 12%, transparent); border-left: 3px solid ${CSS_VARIABLES.textLinkForeground}; padding: 8px 12px; margin-bottom: 16px; border-radius: 3px; color: var(--vscode-editor-foreground); line-height: 1.5;">
    <strong>ℹ️ ${title}:</strong> ${message}
</div>`;
    }

    /**
     * Create a warning box with icon and message
     */
    static warningBox(message: string, title: string = 'Warning'): string {
        return `<div style="font-size: 12px; background-color: rgba(231, 152, 60, 0.1); border-left: 3px solid var(--vscode-editorWarning-foreground, #e7983c); padding: 8px 12px; margin-bottom: 16px; border-radius: 3px; color: var(--vscode-editor-foreground); line-height: 1.5;">
    <strong>⚠️ ${title}:</strong> ${message}
</div>`;
    }

    /**
     * Create a success/tip box with icon and message
     */
    static successBox(message: string, title: string = 'Tip'): string {
        return `<div style="font-size: 12px; background-color: rgba(46, 204, 113, 0.1); border-left: 3px solid var(--vscode-testing-iconPassed, #2ecc71); padding: 8px 12px; margin-bottom: 16px; border-radius: 3px; color: var(--vscode-editor-foreground); line-height: 1.5;">
    <strong>💡 ${title}:</strong> ${message}
</div>`;
    }

    /**
     * Create a danger/caution box with icon and message.
     * Used for destructive operations — styled with error foreground.
     */
    static dangerBox(message: string, title: string = 'Caution'): string {
        return `<div style="font-size: 12px; background-color: rgba(231, 76, 60, 0.1); border-left: 3px solid var(--vscode-errorForeground, #e74c3c); padding: 8px 12px; margin-bottom: 16px; border-radius: 3px; color: var(--vscode-errorForeground, #e74c3c); line-height: 1.5;">
    <strong>🛑 ${title}:</strong> ${message}
</div>`;
    }

    /**
     * Create a data table in markdown/HTML format.
     * Headers: 11px/500 muted. Cells: 12px/400.
     */
    static table(headers: string[], rows: string[][]): string {
        const thStyle = 'text-align: left; font-size: 11px; font-weight: 500; color: var(--vscode-descriptionForeground); padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border);';
        const tdStyle = 'font-size: 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border);';
        const headerRow = `    <tr>${headers.map(h => `<th style="${thStyle}">${h}</th>`).join('')}</tr>`;
        const bodyRows = rows.map(row => 
            `    <tr>${row.map(cell => `<td style="${tdStyle}">${cell}</td>`).join('')}</tr>`
        ).join('\n');
        
        return `<table style="font-size: 12px; width: 100%; border-collapse: collapse;">
${headerRow}
${bodyRows}
</table>`;
    }

    /**
     * Create a heading with icon.
     * Levels map to the typography scale: h3=section header (12px/500), h4/h5=body.
     */
    static heading(text: string, level: number = 3, icon?: string): string {
        const hashes = '#'.repeat(level);
        return `${hashes} ${icon ? icon + ' ' : ''}${text}`;
    }

    /**
     * Create a section divider
     */
    static divider(): string {
        return '\n---\n';
    }

    /**
     * Create a code block
     */
    static codeBlock(code: string, language: string = ''): string {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    /**
     * Create an inline code snippet
     */
    static inlineCode(text: string): string {
        return `\`${text}\``;
    }

    /**
     * Create a badge/label
     */
    static badge(text: string, color: 'success' | 'warning' | 'danger' | 'info' = 'info'): string {
        const colors = {
            success: 'var(--vscode-testing-iconPassed, #2ecc71)',
            warning: 'var(--vscode-editorWarning-foreground, #f39c12)',
            danger: 'var(--vscode-errorForeground, #e74c3c)',
            info: 'var(--vscode-textLink-foreground, #3498db)',
        };
        return `<span style="background: ${colors[color]}; color: var(--vscode-button-foreground, #fff); padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500;">${text}</span>`;
    }

    /**
     * Create a secondary (non-destructive) action button for notebook markdown.
     */
    static button(label: string, onClick: string): string {
        return `<button onclick="${onClick}" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 12px; border-radius: 3px; font-size: 12px; font-weight: 500; cursor: pointer;">${label}</button>`;
    }

    /**
     * Create a destructive action button for notebook markdown.
     * Always text-danger colored, never primary.
     */
    static dangerButton(label: string, onClick: string): string {
        return `<button onclick="${onClick}" style="background: transparent; color: var(--vscode-errorForeground, #e74c3c); border: 1px solid var(--vscode-errorForeground, #e74c3c); padding: 4px 12px; border-radius: 3px; font-size: 12px; font-weight: 500; cursor: pointer;">${label}</button>`;
    }
}

/**
 * HTML template builders for webviews and renderers
 */
export class HtmlBuilder {
    /**
     * Create a button element.
     * Use variant='danger' for destructive actions (Delete/Drop/Kill) — never primary.
     */
    static button(
        text: string,
        onClick?: string,
        variant: 'primary' | 'secondary' | 'danger' = 'primary',
        title?: string
    ): string {
        let styles: string;
        if (variant === 'danger') {
            styles = styleToString({...COMMON_STYLES.button, ...COMMON_STYLES.buttonDanger, background: 'transparent'});
        } else if (variant === 'secondary') {
            styles = styleToString({...COMMON_STYLES.button, ...COMMON_STYLES.buttonSecondary});
        } else {
            styles = styleToString(COMMON_STYLES.button);
        }
        const titleAttr = title ? ` title="${title}"` : '';
        return `<button style="${styles}"${onClick ? ` onclick="${onClick}"` : ''}${titleAttr}>${text}</button>`;
    }

    /**
     * Create a styled container/card
     */
    static container(content: string, styles?: Partial<typeof COMMON_STYLES.container>): string {
        const finalStyles = styleToString({...COMMON_STYLES.container, ...styles});
        return `<div style="${finalStyles}">${content}</div>`;
    }

    /**
     * Create a collapsible header.
     * Section header typography: 12px/500.
     */
    static collapsibleHeader(
        title: string,
        summary: string,
        isSuccess: boolean = false
    ): string {
        const headerStyle = isSuccess
            ? {...COMMON_STYLES.header, ...COMMON_STYLES.successHeader}
            : COMMON_STYLES.header;
        
        return `<div style="${styleToString(headerStyle)}">
    <span style="font-size: 10px; transition: transform 0.2s; display: inline-block;">▼</span>
    <span style="font-weight: 500; font-size: 12px;">${title}</span>
    <span style="margin-left: auto; opacity: 0.7; font-size: 11px;">${summary}</span>
</div>`;
    }

    /**
     * Create a simple table.
     * Headers: 12px/500 muted. Cells: 13px/400.
     */
    static table(headers: string[], rows: string[][]): string {
        const headerCells = headers.map(h => 
            `<th style="${styleToString(COMMON_STYLES.tableHeader)}">${h}</th>`
        ).join('');
        
        const bodyRows = rows.map(row => 
            `<tr>${row.map(cell => 
                `<td style="${styleToString(COMMON_STYLES.tableCell)}">${cell}</td>`
            ).join('')}</tr>`
        ).join('\n');

        return `<table style="${styleToString(COMMON_STYLES.table)}">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
</table>`;
    }

    /**
     * Create a skeleton loading row (pulsing shimmer).
     * Use instead of spinner-in-blank-space during data load.
     */
    static skeletonRow(widths: string[] = ['60%', '30%', '20%']): string {
        const cells = widths.map(w =>
            `<td style="padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border);">` +
            `<div style="height: 12px; width: ${w}; background: var(--vscode-widget-border); border-radius: 2px; animation: skeleton-pulse 1.6s ease-in-out infinite;"></div></td>`
        ).join('');
        return `<tr>${cells}</tr>`;
    }

    /**
     * Create an empty-state block with a 1-line prompt and single CTA button.
     */
    static emptyState(message: string, ctaLabel: string, ctaOnClick: string): string {
        return `<div style="display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px 16px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center;">
    <span>${message}</span>
    <button onclick="${ctaOnClick}" style="${styleToString(COMMON_STYLES.button)}">${ctaLabel}</button>
</div>`;
    }
}

/**
 * Pre-built notebook templates
 */
export class NotebookTemplates {
    /**
     * Standard notebook header with database/table info
     */
    static header(
        title: string,
        description: string,
        icon: string = '📊'
    ): string {
        return `${MarkdownBuilder.heading(title, 3, icon)}

${MarkdownBuilder.infoBox(description)}`;
    }

    /**
     * Operations overview table
     */
    static operationsTable(operations: Array<{
        name: string;
        description: string;
        riskLevel: string;
    }>): string {
        return `${MarkdownBuilder.heading('Available Operations', 4, '🎯')}

${MarkdownBuilder.table(
    ['Operation', 'Description', 'Risk Level'],
    operations.map(op => [op.name, op.description, op.riskLevel])
)}`;
    }

    /**
     * Safety checklist
     */
    static safetyChecklist(items: string[]): string {
        return `${MarkdownBuilder.heading('Safety Checklist', 4, '🔍')}

${MarkdownBuilder.table(
    ['Check', 'Description'],
    items.map(item => ['✅', item])
)}`;
    }

    /**
     * Standard section header for notebooks
     */
    static sectionHeader(title: string, icon?: string): string {
        return MarkdownBuilder.heading(title, 5, icon);
    }
}
