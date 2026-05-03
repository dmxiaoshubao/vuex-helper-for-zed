export interface CoreUri {
    fsPath: string;
    toString(): string;
}

export interface CorePosition {
    line: number;
    character: number;
}

export interface CoreRange {
    start: CorePosition;
    end: CorePosition;
}

export interface CoreLocation {
    uri: CoreUri;
    range: CoreRange;
}

export type CoreDiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface CoreDiagnostic {
    range: CoreRange;
    message: string;
    severity: CoreDiagnosticSeverity;
    source?: string;
}

export interface CoreTextLine {
    text: string;
}

export interface CoreTextDocument {
    uri: string;
    fileName: string;
    languageId?: string;
    version?: number;
    getText(range?: CoreRange): string;
    positionAt(offset: number): CorePosition;
    offsetAt(position: CorePosition): number;
    lineAt(line: number): CoreTextLine;
    getWordRangeAtPosition?(position: CorePosition): CoreRange | undefined;
}
