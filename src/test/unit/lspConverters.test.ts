import * as assert from 'assert';
import { Diagnostic, DiagnosticSeverity, Location, Range, CompletionItem, CompletionItemKind, MarkdownString, Hover, SnippetString } from '../../lsp/vscode-shim';
import { toLspCompletionItems, toLspDiagnostics, toLspHover, toLspLocation } from '../../lsp/converters';

describe('LSP converters', () => {
    it('should convert vscode-like location to LSP location', () => {
        const location = new Location(
            { fsPath: '/mock/workspace/src/store/index.js', toString: () => 'file:///mock/workspace/src/store/index.js' } as any,
            new Range(3, 4, 3, 9),
        );

        const converted = toLspLocation(location);

        assert.strictEqual(converted.uri, 'file:///mock/workspace/src/store/index.js');
        assert.deepStrictEqual(converted.range.start, { line: 3, character: 4 });
        assert.deepStrictEqual(converted.range.end, { line: 3, character: 9 });
    });

    it('should convert diagnostics to LSP diagnostics', () => {
        const diagnostic = new Diagnostic(new Range(1, 2, 1, 8), 'missing getter', DiagnosticSeverity.Warning);
        diagnostic.source = 'Vuex Helper';

        const [converted] = toLspDiagnostics([diagnostic]);

        assert.strictEqual(converted.message, 'missing getter');
        assert.strictEqual(converted.severity, 2);
        assert.strictEqual(converted.source, 'Vuex Helper');
    });

    it('should convert completion items to LSP completion items', () => {
        const item = new CompletionItem('fetchProfile', CompletionItemKind.Function);
        item.detail = 'Vuex action';

        const [converted] = toLspCompletionItems([item])!;

        assert.strictEqual(converted.label, 'fetchProfile');
        assert.strictEqual(converted.detail, 'Vuex action');
        assert.strictEqual(converted.kind, 3);
    });

    it('should convert snippet completion items to LSP snippets', () => {
        const item = new CompletionItem('dispatch', CompletionItemKind.Method);
        item.insertText = new SnippetString('dispatch($0)');
        item.range = new Range(0, 12, 0, 13);

        const [converted] = toLspCompletionItems([item])!;

        assert.strictEqual(converted.insertText, 'dispatch($0)');
        assert.strictEqual(converted.insertTextFormat, 2);
        assert.deepStrictEqual(converted.textEdit, {
            range: {
                start: { line: 0, character: 12 },
                end: { line: 0, character: 13 },
            },
            newText: 'dispatch($0)',
        });
    });

    it('should convert markdown hover to LSP hover', () => {
        const markdown = new MarkdownString();
        markdown.appendMarkdown('Vuex Getter');
        const converted = toLspHover(new Hover(markdown));

        assert.deepStrictEqual(converted?.contents, {
            kind: 'markdown',
            value: 'Vuex Getter',
        });
    });
});
