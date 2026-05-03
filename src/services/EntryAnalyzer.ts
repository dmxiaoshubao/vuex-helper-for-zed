import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { PathResolver } from '../utils/PathResolver';

export interface EntryAnalyzeOptions {
    interactive?: boolean;
    forceRefresh?: boolean;
}

export interface EntryAnalyzerHooks {
    onWillUpdateStoreEntryConfig?: () => void;
}

export class EntryAnalyzer {
    private workspaceRoot: string;
    private pathResolver: PathResolver;
    private hooks: EntryAnalyzerHooks;
    private promptedForMissingStore = false;
    private warnedInvalidConfiguredEntry = new Set<string>();
    private cachedStorePath: string | null | undefined;

    constructor(workspaceRoot: string, hooks: EntryAnalyzerHooks = {}) {
        this.workspaceRoot = workspaceRoot;
        this.pathResolver = new PathResolver(workspaceRoot);
        this.hooks = hooks;
    }

    /**
     * Find the main entry file and the store path.
     */
    public async analyze(options: EntryAnalyzeOptions = {}): Promise<string | null> {
        const interactive = options.interactive === true;
        const forceRefresh = options.forceRefresh === true;
        const targetUri = vscode.Uri.file(this.workspaceRoot);

        if (!forceRefresh && this.cachedStorePath !== undefined) {
            if (!this.cachedStorePath) return null;
            if (await this.isAllowedStorePath(this.cachedStorePath)) {
                return this.cachedStorePath;
            }
            this.cachedStorePath = undefined;
        }
        // 0. Check for configuration "vuexHelper.storeEntry"
        const config = vscode.workspace.getConfiguration('vuexHelper', targetUri);
        const configuredEntry = config.get<string>('storeEntry');

        if (configuredEntry && configuredEntry.trim() !== '') {
            // Resolve configured path
            // It could be:
            // 1. Alias: "@/store/index.js"
            // 2. Relative: "./str/store.js" or "src/store.js"
            // 3. Absolute: "/Users/..."
            
            // PathResolver can handle aliases and general paths if we give it a context.
            // But resolve(path, contextFile) assumes contextFile for relative lookups logic?
            // Actually PathResolver.resolve checks for startWith('.') for relative.
            
            let resolvedPath: string | null = null;

            // If absolute
            if (path.isAbsolute(configuredEntry)) {
                 if (await this.isAllowedStorePath(configuredEntry)) resolvedPath = configuredEntry;
            } else {
                 // Try alias first
                 resolvedPath = await this.pathResolver.resolve(configuredEntry, path.join(this.workspaceRoot, 'package.json')); // Dummy context

                 // If not alias, try workspace relative
                 if (!resolvedPath) {
                     const abs = path.resolve(this.workspaceRoot, configuredEntry);
                     if (await this.isAllowedStorePath(abs)) resolvedPath = abs;
                 }
            }

            if (resolvedPath && await this.isAllowedStorePath(resolvedPath)) {
                this.promptedForMissingStore = false;
                this.cachedStorePath = resolvedPath;
                return resolvedPath;
            } else {
                if (interactive && !this.warnedInvalidConfiguredEntry.has(configuredEntry)) {
                    this.warnedInvalidConfiguredEntry.add(configuredEntry);
                    void vscode.window.showWarningMessage(`Vuex Helper: Configured store entry "${configuredEntry}" not found.`);
                }
                // Fallback to auto-detection? Or stop? 
                // Usually if user configures it, they want that. But if it fails, maybe fallback is better than nothing.
                // But let's fallback to auto-detection with a warning.
            }
        }

        // 1. Find potential entry files
        const entryFiles = await this.findEntryFiles();
        
        // 2. Parse validation to find `new Vue({ store, ... })`
        for (const file of entryFiles) {
            const storePath = await this.findStoreInjection(file);
            if (storePath) {
                this.promptedForMissingStore = false;
                this.cachedStorePath = storePath;
                return storePath;
            }
        }
        
        // If nothing found
        // If nothing found
        if (!interactive || this.promptedForMissingStore) {
            this.cachedStorePath = null;
            return null;
        }
        this.promptedForMissingStore = true;

        const action = await vscode.window.showInformationMessage(
            'Vuex Helper: Could not find Vuex store entry automatically.',
            'Select Store File'
        );
        if (action === 'Select Store File') {
            const selection = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.join(this.workspaceRoot, 'src')),
                openLabel: 'Select Vuex Store Entry',
                filters: {
                    'JavaScript / TypeScript': ['js', 'ts'],
                    'All Files': ['*']
                }
            });

            const selected = selection?.[0];
            if (selected?.fsPath) {
                try {
                    if (!await this.isAllowedStorePath(selected.fsPath)) {
                        void vscode.window.showWarningMessage('Vuex Helper: Please select a store file inside the current workspace.');
                    } else {
                        const configPath = await this.pathResolver.toPreferredConfigPath(selected.fsPath);
                        this.hooks.onWillUpdateStoreEntryConfig?.();
                        await config.update('storeEntry', configPath, vscode.ConfigurationTarget.WorkspaceFolder);
                        this.resetInteractionState();
                        this.promptedForMissingStore = false;
                        this.cachedStorePath = selected.fsPath;
                        void vscode.window.showInformationMessage(`Vuex Helper: Store path configured to "${configPath}".`);
                        return selected.fsPath;
                    }
                } catch (e) {
                    void vscode.window.showErrorMessage(`Vuex Helper: Failed to save setting. ${e}`);
                }
            }
        }

        this.cachedStorePath = null;
        return null;
    }

    public invalidateCache(): void {
        this.cachedStorePath = undefined;
    }

    public resetInteractionState(): void {
        this.promptedForMissingStore = false;
        this.warnedInvalidConfiguredEntry.clear();
        this.cachedStorePath = undefined;
    }

    private async isAllowedStorePath(candidate: string): Promise<boolean> {
        try {
            const stat = await fs.promises.stat(candidate);
            if (!stat.isFile()) return false;
        } catch {
            return false;
        }
        const resolved = path.resolve(candidate);
        const workspace = path.resolve(this.workspaceRoot);
        const relative = path.relative(workspace, resolved);
        const isInsideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        return isInsideWorkspace;
    }

    private async findEntryFiles(): Promise<string[]> {
        const pattern = 'src/{main,index}.{js,ts}';
        return glob(pattern, { cwd: this.workspaceRoot, absolute: true });
    }

    private async findStoreInjection(filePath: string): Promise<string | null> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const ast = parser.parse(content, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx']
            });

            const importMap: Record<string, string> = {};
            const localVars: Record<string, t.Node | null | undefined> = {};
            let foundStoreRef: t.Node | null = null;

            // 单次 traverse 同时收集 imports/localVars 和查找 store 注入
            traverse(ast, {
                ImportDeclaration: (path: NodePath<t.ImportDeclaration>) => {
                    const source = path.node.source?.value;
                    if (!source) return;
                    path.node.specifiers.forEach((specifier) => {
                        if (specifier.local?.name) {
                            importMap[specifier.local.name] = source;
                        }
                    });
                },
                VariableDeclarator: (path: NodePath<t.VariableDeclarator>) => {
                    if (path.node.id?.type === 'Identifier') {
                        localVars[path.node.id.name] = path.node.init;
                    }
                },
                FunctionDeclaration: (path: NodePath<t.FunctionDeclaration>) => {
                    if (path.node.id?.name) {
                        localVars[path.node.id.name] = path.node;
                    }
                },
                NewExpression: (path: NodePath<t.NewExpression>) => {
                    if (foundStoreRef) return;
                    const callee = path.node.callee;
                    if (!(callee.type === 'Identifier' && callee.name === 'Vue')) return;
                    const args = path.node.arguments;
                    if (!args.length) return;

                    const optionsObject = this.resolveObjectExpression(args[0], localVars, 0, new Set());
                    if (!optionsObject) return;

                    for (const prop of (optionsObject as t.ObjectExpression).properties) {
                        if (prop.type !== 'ObjectProperty') continue;
                        if (prop.key.type !== 'Identifier' || prop.key.name !== 'store') continue;
                        foundStoreRef = prop.value;
                        break;
                    }
                }
            });

            if (foundStoreRef) {
                return await this.resolveStorePathFromNode(foundStoreRef, importMap, localVars, filePath, 0, new Set());
            }

        } catch (error) {
            console.error(`Error parsing ${filePath}:`, error);
        }
        return null;
    }

    private resolveObjectExpression(
        node: t.Node | null | undefined,
        localVars: Record<string, t.Node | null | undefined>,
        depth: number,
        seen: Set<string>
    ): t.Node | null {
        if (!node || depth > 10) return null;

        if (node.type === 'ObjectExpression') {
            return node;
        }

        if (node.type === 'Identifier') {
            if (seen.has(node.name)) return null;
            seen.add(node.name);
            return this.resolveObjectExpression(localVars[node.name], localVars, depth + 1, seen);
        }

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
            const calleeName = node.callee.name;
            if (seen.has(calleeName)) return null;
            seen.add(calleeName);
            const calleeNode = localVars[calleeName];
            const returnedObject = this.resolveFunctionReturnObject(calleeNode, localVars, depth + 1, seen);
            if (returnedObject) {
                return returnedObject;
            }
        }

        if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression') {
            return this.resolveObjectExpression(node.expression, localVars, depth + 1, seen);
        }

        return null;
    }

    private resolveFunctionReturnObject(
        node: t.Node | null | undefined,
        localVars: Record<string, t.Node | null | undefined>,
        depth: number,
        seen: Set<string>
    ): t.Node | null {
        if (!node || depth > 10) return null;
        if (node.type !== 'FunctionDeclaration' && node.type !== 'FunctionExpression' && node.type !== 'ArrowFunctionExpression') {
            return null;
        }

        if (node.type === 'ArrowFunctionExpression' && node.body && node.body.type !== 'BlockStatement') {
            return this.resolveObjectExpression(node.body, localVars, depth + 1, seen);
        }

        const body = node.body?.type === 'BlockStatement' ? node.body.body : [];
        for (const statement of body) {
            if (statement.type === 'ReturnStatement' && statement.argument) {
                return this.resolveObjectExpression(statement.argument, localVars, depth + 1, seen);
            }
        }
        return null;
    }

    private async resolveStorePathFromNode(
        node: t.Node | null | undefined,
        importMap: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        filePath: string,
        depth: number,
        seen: Set<string>
    ): Promise<string | null> {
        if (!node || depth > 12) return null;

        if (node.type === 'Identifier') {
            const name = node.name;
            if (seen.has(name)) return null;
            seen.add(name);

            if (importMap[name]) {
                return await this.pathResolver.resolve(importMap[name], filePath);
            }

            return this.resolveStorePathFromNode(localVars[name], importMap, localVars, filePath, depth + 1, seen);
        }

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
            const arg0 = node.arguments?.[0];
            if (arg0 && arg0.type === 'StringLiteral') {
                return await this.pathResolver.resolve(arg0.value, filePath);
            }
            return null;
        }

        if (node.type === 'MemberExpression' && node.object) {
            return this.resolveStorePathFromNode(node.object, importMap, localVars, filePath, depth + 1, seen);
        }

        if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression') {
            return this.resolveStorePathFromNode(node.expression, importMap, localVars, filePath, depth + 1, seen);
        }

        return null;
    }
}
