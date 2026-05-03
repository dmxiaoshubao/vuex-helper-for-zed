import { TextDocument } from 'vscode-languageserver-textdocument';
import * as vscode from './vscode-shim';

export class LspTextDocumentAdapter {
    public readonly uri: vscode.Uri;
    public readonly fileName: string;
    public readonly languageId: string;
    public readonly version: number;

    constructor(private readonly document: TextDocument) {
        this.uri = vscode.Uri.parse(document.uri);
        this.fileName = this.uri.fsPath;
        this.languageId = document.languageId;
        this.version = document.version;
    }

    getText(range?: vscode.Range): string {
        if (!range) return this.document.getText();
        return this.document.getText({
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
        });
    }

    positionAt(offset: number): vscode.Position {
        const position = this.document.positionAt(offset);
        return new vscode.Position(position.line, position.character);
    }

    offsetAt(position: vscode.Position): number {
        return this.document.offsetAt({ line: position.line, character: position.character });
    }

    lineAt(line: number): { text: string } {
        const text = this.document.getText();
        const lines = text.split(/\r?\n/);
        return { text: lines[line] || '' };
    }

    getWordRangeAtPosition(position: vscode.Position): vscode.Range | undefined {
        const line = this.lineAt(position.line).text;
        const pattern = /[A-Za-z0-9_$]+/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (position.character >= start && position.character <= end) {
                return new vscode.Range(position.line, start, position.line, end);
            }
        }
        return undefined;
    }
}
