import * as path from 'path';

declare const require: any;
const moduleLoader = require('module');
const vscodeShimPath = path.join(__dirname, 'vscode-shim.js');
const originalRequire = moduleLoader._load;
moduleLoader._load = function loadWithVscodeShim(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === 'vscode') {
        return originalRequire(vscodeShimPath, parent, isMain);
    }
    return originalRequire(request, parent, isMain);
};

import {
    createConnection,
    DidChangeWatchedFilesParams,
    InitializeParams,
    InitializeResult,
    ProposedFeatures,
    TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LspTextDocumentAdapter } from './documents';
import { LspVuexWorkspace } from './indexing';
import {
    fromLspPosition,
    toLspCompletionItems,
    toLspDiagnostics,
    toLspHover,
    toLspLocation,
} from './converters';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: LspVuexWorkspace | undefined;

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const root = getWorkspaceRoot(params);
    if (root) {
        workspace = new LspVuexWorkspace(root);
        void workspace.index().then(() => publishAllDiagnostics());
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: {
                triggerCharacters: ["'", '"', '.'],
            },
            workspace: {
                workspaceFolders: {
                    supported: true,
                },
            },
        },
    };
});

connection.onDefinition(async (params) => {
    if (!workspace) return undefined;
    const document = documents.get(params.textDocument.uri);
    if (!document) return undefined;

    const result = await workspace.definitionProvider.provideDefinition(
        new LspTextDocumentAdapter(document) as any,
        fromLspPosition(params.position) as any,
        { isCancellationRequested: false } as any,
    );
    if (!result) return undefined;
    return Array.isArray(result)
        ? result.map((item: any) => toLspLocation(item))
        : toLspLocation(result as any);
});

connection.onCompletion(async (params) => {
    if (!workspace) return undefined;
    const document = documents.get(params.textDocument.uri);
    if (!document) return undefined;

    const result = await workspace.completionProvider.provideCompletionItems(
        new LspTextDocumentAdapter(document) as any,
        fromLspPosition(params.position) as any,
        { isCancellationRequested: false } as any,
        { triggerKind: 1 } as any,
    );
    return toLspCompletionItems(result as any);
});

connection.onHover(async (params) => {
    if (!workspace) return undefined;
    const document = documents.get(params.textDocument.uri);
    if (!document) return undefined;

    const result = await workspace.hoverProvider.provideHover(
        new LspTextDocumentAdapter(document) as any,
        fromLspPosition(params.position) as any,
        { isCancellationRequested: false } as any,
    );
    return toLspHover(result as any);
});

documents.onDidOpen((event) => {
    void publishDiagnostics(event.document);
});

documents.onDidChangeContent((event) => {
    void publishDiagnostics(event.document);
});

documents.onDidSave((event) => {
    void reindexForDocument(event.document).then(() => publishAllDiagnostics());
});

connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
    if (!workspace) return;
    const changedFiles = params.changes
        .map((change) => uriToFilePath(change.uri))
        .filter((filePath): filePath is string => !!filePath)
        .filter((filePath) => workspace!.shouldReindexForFile(filePath));
    if (changedFiles.length === 0) return;
    void workspace.index(changedFiles).then(() => publishAllDiagnostics());
});

connection.onShutdown(() => {
    workspace?.dispose();
});

documents.listen(connection);
connection.listen();

async function reindexForDocument(document: TextDocument): Promise<void> {
    if (!workspace) return;
    const filePath = uriToFilePath(document.uri);
    if (!filePath || !workspace.shouldReindexForFile(filePath)) return;
    await workspace.index([filePath]);
}

async function publishAllDiagnostics(): Promise<void> {
    for (const document of documents.all()) {
        await publishDiagnostics(document);
    }
}

async function publishDiagnostics(document: TextDocument): Promise<void> {
    if (!workspace) {
        connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
        return;
    }
    const diagnostics = workspace.diagnosticProvider.diagnose(new LspTextDocumentAdapter(document) as any);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: toLspDiagnostics(diagnostics as any) });
}

function getWorkspaceRoot(params: InitializeParams): string | undefined {
    const folderUri = params.workspaceFolders?.[0]?.uri;
    if (folderUri) return uriToFilePath(folderUri);
    if (params.rootUri) return uriToFilePath(params.rootUri);
    return params.rootPath || undefined;
}

function uriToFilePath(uri: string): string | undefined {
    if (!uri) return undefined;
    if (!uri.startsWith('file://')) return uri;
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
