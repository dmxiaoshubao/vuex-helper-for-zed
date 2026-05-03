import * as path from 'path';

export class Uri {
    constructor(public fsPath: string, public scheme: string = 'file') {}

    static file(filePath: string): Uri {
        return new Uri(path.resolve(filePath));
    }

    static parse(value: string): Uri {
        if (value.startsWith('file://')) {
            return new Uri(decodeURIComponent(value.replace(/^file:\/\//, '')));
        }
        return new Uri(value);
    }

    toString(): string {
        return `${this.scheme}://${this.fsPath}`;
    }
}

export class Position {
    constructor(public line: number, public character: number) {}
}

export class Range {
    start: Position;
    end: Position;

    constructor(start: Position, end: Position);
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
        if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number' && typeof d === 'number') {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
            return;
        }

        this.start = a as Position;
        this.end = b as Position;
    }
}

export class Location {
    public range?: Range;
    public position?: Position;

    constructor(public uri: Uri, public rangeOrPosition: Range | Position) {
        if ('start' in rangeOrPosition && 'end' in rangeOrPosition) {
            this.range = rangeOrPosition;
        } else {
            this.position = rangeOrPosition;
        }
    }
}

export class MarkdownString {
    public value = '';

    appendCodeblock(text: string, lang?: string): MarkdownString {
        this.value += `\`\`\`${lang || ''}\n${text}\n\`\`\``;
        return this;
    }

    appendMarkdown(text: string): MarkdownString {
        this.value += text;
        return this;
    }
}

export class Hover {
    constructor(public contents: MarkdownString | string) {}
}

export class SnippetString {
    constructor(public value: string) {}
}

export class CompletionItem {
    public range?: Range;
    public detail?: string;
    public sortText?: string;
    public filterText?: string;
    public documentation?: MarkdownString | string;
    public insertText?: SnippetString | string;

    constructor(public label: string, public kind?: number) {}
}

export class CompletionList {
    constructor(public items: CompletionItem[], public isIncomplete = false) {}
}

export class Diagnostic {
    public source?: string;
    constructor(public range: Range, public message: string, public severity?: number) {}
}

export const CompletionItemKind = {
    Property: 1,
    Field: 2,
    Method: 3,
    Function: 4,
    Module: 5,
};

export const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
};

type ConfigurationValues = Record<string, Record<string, any>>;
const configurationValues: ConfigurationValues = {};

export function setConfiguration(section: string, values: Record<string, any> = {}): void {
    configurationValues[section] = { ...values };
}

export function getConfigurationValue<T>(section: string, key: string, defaultValue?: T): T | undefined {
    return Object.prototype.hasOwnProperty.call(configurationValues[section] || {}, key)
        ? configurationValues[section][key]
        : defaultValue;
}

export const workspace = {
    workspaceFolders: [] as Array<{ uri: Uri }>,
    textDocuments: [] as any[],
    setConfiguration,
    asRelativePath: (value: string | Uri | { fsPath?: string; toString?: () => string }) => {
        const raw = typeof value === 'string' ? value : value.fsPath || value.toString?.() || String(value);
        const root = workspace.workspaceFolders[0]?.uri.fsPath;
        return root && raw.startsWith(root) ? path.relative(root, raw) : raw;
    },
    getConfiguration: (section = '') => ({
        get: (key: string, defaultValue?: any) => getConfigurationValue(section, key, defaultValue),
        update: async (key: string, value: any) => {
            configurationValues[section] = {
                ...(configurationValues[section] || {}),
                [key]: value,
            };
        },
    }),
    onDidSaveTextDocument: () => ({ dispose: () => undefined }),
    onDidOpenTextDocument: () => ({ dispose: () => undefined }),
    onDidCloseTextDocument: () => ({ dispose: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    onDidCreateFiles: () => ({ dispose: () => undefined }),
    onDidDeleteFiles: () => ({ dispose: () => undefined }),
    onDidRenameFiles: () => ({ dispose: () => undefined }),
};

export const window = {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    withProgress: async (_options: any, task: any) => task({ report: () => undefined }, { isCancellationRequested: false }),
};

export const languages = {
    createDiagnosticCollection: () => ({
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
    }),
    registerDefinitionProvider: () => ({ dispose: () => undefined }),
    registerCompletionItemProvider: () => ({ dispose: () => undefined }),
    registerHoverProvider: () => ({ dispose: () => undefined }),
};

export const commands = {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: async () => undefined,
};

export const ProgressLocation = {
    Notification: 15,
};

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
};
