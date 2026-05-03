import * as vscode from "vscode";
import {
  CoreDiagnostic,
  CoreLocation,
  CorePosition,
  CoreRange,
  CoreTextDocument,
} from "../../core/types";

export function toVscodePosition(position: CorePosition): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

export function fromVscodePosition(position: vscode.Position): CorePosition {
  return { line: position.line, character: position.character };
}

export function toVscodeRange(
  range: CoreRange | vscode.Range | vscode.Position | undefined,
): vscode.Range {
  if (!range) return new vscode.Range(0, 0, 0, 0);
  if ("start" in range && "end" in range) {
    return new vscode.Range(
      toVscodePosition(range.start),
      toVscodePosition(range.end),
    );
  }
  return new vscode.Range(
    range.line,
    range.character,
    range.line,
    range.character,
  );
}

export function fromVscodeRange(range: vscode.Range): CoreRange {
  return {
    start: fromVscodePosition(range.start),
    end: fromVscodePosition(range.end),
  };
}

export function toVscodeLocation(location: CoreLocation): vscode.Location {
  const anyLocation = location as any;
  const fsPath = anyLocation.uri?.fsPath || "";
  const legacyRangeOrPosition =
    anyLocation.rangeOrPosition || anyLocation.position;
  if (legacyRangeOrPosition) {
    return new vscode.Location(vscode.Uri.file(fsPath), legacyRangeOrPosition);
  }
  return new vscode.Location(
    vscode.Uri.file(fsPath),
    toVscodeRange(anyLocation.range),
  );
}

export function toVscodeDiagnostic(
  diagnostic: CoreDiagnostic,
): vscode.Diagnostic {
  const converted = new vscode.Diagnostic(
    toVscodeRange(diagnostic.range),
    diagnostic.message,
    toVscodeDiagnosticSeverity(diagnostic.severity),
  );
  converted.source = diagnostic.source;
  return converted;
}

export function asCoreTextDocument(
  document: vscode.TextDocument,
): CoreTextDocument {
  return {
    uri: document.uri.toString(),
    fileName: document.fileName,
    languageId: document.languageId,
    version: document.version,
    getText: (range?: CoreRange) =>
      document.getText(range ? toVscodeRange(range) : undefined),
    positionAt: (offset: number) =>
      fromVscodePosition(document.positionAt(offset)),
    offsetAt: (position: CorePosition) =>
      document.offsetAt(toVscodePosition(position)),
    lineAt: (line: number) => ({ text: document.lineAt(line).text }),
    getWordRangeAtPosition: (position: CorePosition) => {
      const range = document.getWordRangeAtPosition(toVscodePosition(position));
      return range ? fromVscodeRange(range) : undefined;
    },
  };
}

function toVscodeDiagnosticSeverity(
  severity: CoreDiagnostic["severity"],
): vscode.DiagnosticSeverity {
  if (severity === "error") return vscode.DiagnosticSeverity.Error;
  if (severity === "information") return vscode.DiagnosticSeverity.Information;
  if (severity === "hint") return vscode.DiagnosticSeverity.Hint;
  return vscode.DiagnosticSeverity.Warning;
}
