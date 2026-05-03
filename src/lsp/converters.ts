import {
    CompletionItem,
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    Hover,
    InsertTextFormat,
    Location,
    MarkupKind,
    Range,
} from 'vscode-languageserver/node';
import * as vscode from './vscode-shim';

export function toLspRange(range: vscode.Range): Range {
    return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
    };
}

export function toLspLocation(location: vscode.Location): Location {
    const rangeOrPosition = location.range || location.rangeOrPosition || location.position || new vscode.Position(0, 0);
    const range = 'start' in rangeOrPosition && 'end' in rangeOrPosition
        ? rangeOrPosition
        : new vscode.Range(rangeOrPosition.line, rangeOrPosition.character, rangeOrPosition.line, rangeOrPosition.character);
    return Location.create(location.uri.toString(), toLspRange(range));
}

export function toLspCompletionItems(result: vscode.CompletionItem[] | vscode.CompletionList | undefined): CompletionItem[] | undefined {
    if (!result) return undefined;
    const items = Array.isArray(result) ? result : result.items;
    return items.map((item) => {
        const isSnippet = item.insertText instanceof vscode.SnippetString;
        const insertText = typeof item.insertText === 'string' ? item.insertText : item.insertText?.value;
        return {
            label: item.label,
            kind: toLspCompletionKind(item.kind),
            detail: item.detail,
            documentation: toLspMarkup(item.documentation),
            sortText: item.sortText,
            filterText: item.filterText,
            insertText,
            insertTextFormat: isSnippet ? InsertTextFormat.Snippet : undefined,
            textEdit: item.range ? {
                range: toLspRange(item.range),
                newText: insertText || item.label,
            } : undefined,
        };
    });
}

export function toLspHover(hover: vscode.Hover | undefined): Hover | undefined {
    if (!hover) return undefined;
    const contents = hover.contents instanceof vscode.MarkdownString
        ? hover.contents.value
        : String(hover.contents);
    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: contents,
        },
    };
}

export function toLspDiagnostics(diagnostics: vscode.Diagnostic[]): Diagnostic[] {
    return diagnostics.map((diagnostic) => ({
        range: toLspRange(diagnostic.range),
        message: diagnostic.message,
        severity: toLspDiagnosticSeverity(diagnostic.severity),
        source: diagnostic.source,
    }));
}

export function fromLspPosition(position: { line: number; character: number }): vscode.Position {
    return new vscode.Position(position.line, position.character);
}

function toLspCompletionKind(kind: number | undefined): CompletionItemKind | undefined {
    if (kind === vscode.CompletionItemKind.Field) return CompletionItemKind.Field;
    if (kind === vscode.CompletionItemKind.Method) return CompletionItemKind.Method;
    if (kind === vscode.CompletionItemKind.Function) return CompletionItemKind.Function;
    if (kind === vscode.CompletionItemKind.Module) return CompletionItemKind.Module;
    if (kind === vscode.CompletionItemKind.Property) return CompletionItemKind.Property;
    return undefined;
}

function toLspDiagnosticSeverity(severity: number | undefined): DiagnosticSeverity | undefined {
    if (severity === vscode.DiagnosticSeverity.Error) return DiagnosticSeverity.Error;
    if (severity === vscode.DiagnosticSeverity.Information) return DiagnosticSeverity.Information;
    if (severity === vscode.DiagnosticSeverity.Hint) return DiagnosticSeverity.Hint;
    return DiagnosticSeverity.Warning;
}

function toLspMarkup(value: vscode.MarkdownString | string | undefined): { kind: MarkupKind; value: string } | string | undefined {
    if (!value) return undefined;
    if (value instanceof vscode.MarkdownString) {
        return { kind: MarkupKind.Markdown, value: value.value };
    }
    return value;
}
