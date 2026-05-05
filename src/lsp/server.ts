import * as fs from 'fs';
import * as JSON5 from 'json5';
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
    DidChangeConfigurationParams,
    DidChangeWatchedFilesNotification,
    DidChangeWatchedFilesParams,
    DidChangeWatchedFilesRegistrationOptions,
    ExecuteCommandParams,
    InitializeParams,
    InitializeResult,
    MessageActionItem,
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

const VUEX_HELPER_REINDEX_COMMAND = 'vuexHelper.reindex';
const CONFIGURE_STORE_ENTRY_ACTION = 'Add Store Entry Setting';
const WATCHED_FILES: DidChangeWatchedFilesRegistrationOptions = {
    watchers: [
        { globPattern: '**/*.{js,ts,vue,json}' },
    ],
};

interface VuexHelperLspSettings {
    storeEntry?: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspace: LspVuexWorkspace | undefined;
let missingStoreEntryPrompted = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const root = getWorkspaceRoot(params);
    if (root) {
        workspace = new LspVuexWorkspace(root, getVuexHelperSettings(params.initializationOptions));
        void workspace.index().then(() => {
            void maybePromptForMissingStoreEntry();
            return publishAllDiagnostics();
        });
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: {
                triggerCharacters: ["'", '"', '.'],
            },
            executeCommandProvider: {
                commands: [VUEX_HELPER_REINDEX_COMMAND],
            },
            workspace: {
                workspaceFolders: {
                    supported: true,
                },
            },
        },
    };
});

connection.onInitialized(() => {
    void connection.client.register(DidChangeWatchedFilesNotification.type, WATCHED_FILES);
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

connection.onExecuteCommand((params: ExecuteCommandParams) => {
    if (params.command !== VUEX_HELPER_REINDEX_COMMAND || !workspace) return undefined;
    return workspace.index().then(() => publishAllDiagnostics());
});

connection.onDidChangeConfiguration((params: DidChangeConfigurationParams) => {
    if (!workspace) return;
    void workspace.updateConfiguration(getVuexHelperSettings(params.settings)).then(() => {
        void maybePromptForMissingStoreEntry();
        return publishAllDiagnostics();
    });
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

async function maybePromptForMissingStoreEntry(): Promise<void> {
    if (!workspace || missingStoreEntryPrompted) return;
    if (!await workspace.isSupportedProject()) return;
    if (workspace.hasStoreEntry()) return;
    missingStoreEntryPrompted = true;

    const action = await connection.window.showInformationMessage<MessageActionItem>(
        'Vuex Helper: Could not find Vuex store entry automatically. Add vuexHelper.storeEntry to .zed/settings.json.',
        { title: CONFIGURE_STORE_ENTRY_ACTION },
    );
    if (action?.title !== CONFIGURE_STORE_ENTRY_ACTION) return;

    ensureZedSettingsTemplate(workspace.workspaceRoot);
}

function ensureZedSettingsTemplate(workspaceRoot: string): string {
    const settingsDir = path.join(workspaceRoot, '.zed');
    const settingsPath = path.join(settingsDir, 'settings.json');
    fs.mkdirSync(settingsDir, { recursive: true });

    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify(createZedSettingsTemplate(), null, 2) + '\n');
        return settingsPath;
    }

    try {
        const content = fs.readFileSync(settingsPath, 'utf8');
        const config = content.trim() ? JSON5.parse(content) : {};
        config.lsp = config.lsp || {};
        config.lsp['vuex-helper'] = config.lsp['vuex-helper'] || {};
        config.lsp['vuex-helper'].settings = config.lsp['vuex-helper'].settings || {};
        if (typeof config.lsp['vuex-helper'].settings.storeEntry !== 'string') {
            config.lsp['vuex-helper'].settings.storeEntry = '';
            fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
        }
    } catch {
        connection.window.showWarningMessage('Vuex Helper: Please add lsp.vuex-helper.settings.storeEntry to .zed/settings.json manually.');
    }

    return settingsPath;
}

function createZedSettingsTemplate(): Record<string, any> {
    return {
        lsp: {
            'vuex-helper': {
                settings: {
                    storeEntry: '',
                },
            },
        },
    };
}

function fileUri(filePath: string): string {
    return `file://${filePath}`;
}

function getWorkspaceRoot(params: InitializeParams): string | undefined {
    const folderUri = params.workspaceFolders?.[0]?.uri;
    if (folderUri) return uriToFilePath(folderUri);
    if (params.rootUri) return uriToFilePath(params.rootUri);
    return params.rootPath || undefined;
}

function getVuexHelperSettings(initializationOptions: unknown): VuexHelperLspSettings {
    if (!initializationOptions || typeof initializationOptions !== 'object') return {};
    const options = initializationOptions as Record<string, any>;
    const settings = options.settings || options.vuexHelper || options;
    const vuexHelper = settings.vuexHelper || settings;
    return {
        storeEntry: typeof vuexHelper.storeEntry === 'string' ? vuexHelper.storeEntry : undefined,
    };
}

function uriToFilePath(uri: string): string | undefined {
    if (!uri) return undefined;
    if (!uri.startsWith('file://')) return uri;
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
