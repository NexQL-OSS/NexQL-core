import * as vscode from 'vscode';

export class PostgresNotebookSerializer implements vscode.NotebookSerializer {
    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        const contents = new TextDecoder().decode(content);

        // Create a single cell with the entire content
        const cells = [
            new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                contents,
                'sql'
            )
        ];

        return new vscode.NotebookData(cells);
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        // Join all code cells with newlines
        const contents = data.cells
            .map(cell => cell.value)
            .join('\n\n');

        return new TextEncoder().encode(contents);
    }
}
