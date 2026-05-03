import * as vscode from 'vscode';
import * as fs from 'fs';
import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { PathResolver } from '../utils/PathResolver';
import { CoreLocation } from '../core/types';
import { VuexStoreMap, VuexStateInfo, VuexGetterInfo, VuexMutationInfo, VuexActionInfo } from '../types';

// Babel AST 中 ObjectExpression.properties 的元素类型
type ObjectMember = t.ObjectProperty | t.ObjectMethod | t.SpreadElement;

export interface StoreParseOptions {
    changedFiles?: string[];
}

interface ParseContext {
    allowedFiles?: Set<string>;
    previouslyIndexedFiles?: Set<string>;
}

export class StoreParser {
    private pathResolver: PathResolver;
    private storeMap: VuexStoreMap = {
        state: [],
        getters: [],
        mutations: [],
        actions: []
    };
    private fileNamespaceMap: Map<string, string[]> = new Map();
    private fileInheritedAssetNamespaceMap: Map<string, string[]> = new Map();
    private fileAssetNamespaceMap: Map<string, string[]> = new Map();
    private visitedModuleScope: Set<string> = new Set();
    private fileDependencyMap: Map<string, Set<string>> = new Map();
    private reverseDependencyMap: Map<string, Set<string>> = new Map();
    private lastStoreEntryPath: string | null = null;

    constructor(workspaceRoot: string) {
        this.pathResolver = new PathResolver(workspaceRoot);
    }

    public async parse(storeEntryPath: string, options: StoreParseOptions = {}): Promise<VuexStoreMap> {
        const normalizedEntry = vscode.Uri.file(storeEntryPath).fsPath;
        const normalizedChanged = (options.changedFiles || [])
            .map((filePath) => vscode.Uri.file(filePath).fsPath);

        const canIncremental =
            normalizedChanged.length > 0 &&
            this.lastStoreEntryPath === normalizedEntry &&
            this.fileNamespaceMap.size > 0;

        if (!canIncremental) {
            this.resetAllIndexState();
            this.pathResolver.clearCache();
            await this.parseModule(storeEntryPath, [], {}, []);
            this.lastStoreEntryPath = normalizedEntry;
            return this.storeMap;
        }

        const affectedFiles = new Set(this.getAffectedFiles(normalizedChanged));
        if (affectedFiles.size === 0) {
            return this.storeMap;
        }

        const namespaceSnapshot = new Map(this.fileNamespaceMap);
        const inheritedAssetNamespaceSnapshot = new Map(this.fileInheritedAssetNamespaceMap);
        this.prepareIncrementalState(affectedFiles);

        const parseContext: ParseContext = {
            allowedFiles: new Set(affectedFiles),
            previouslyIndexedFiles: new Set(namespaceSnapshot.keys())
        };

        for (const affectedFile of affectedFiles) {
            const namespace = namespaceSnapshot.get(affectedFile) || [];
            const inheritedAssetNamespace = inheritedAssetNamespaceSnapshot.get(affectedFile) || [];
            await this.parseModule(affectedFile, namespace, parseContext, inheritedAssetNamespace);
        }

        this.pruneUnreachableFiles(normalizedEntry);
        this.lastStoreEntryPath = normalizedEntry;
        return this.storeMap;
    }

    private async parseModule(
        filePath: string,
        moduleNamespace: string[],
        context: ParseContext,
        inheritedAssetNamespace: string[],
    ): Promise<void> {
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
        const normalizedPath = vscode.Uri.file(filePath).fsPath;

        if (context.allowedFiles && !context.allowedFiles.has(normalizedPath)) {
            const wasIndexed = context.previouslyIndexedFiles?.has(normalizedPath) || this.fileNamespaceMap.has(normalizedPath);
            if (wasIndexed) {
                return;
            }
            context.allowedFiles.add(normalizedPath);
        }

        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return;
        } catch {
            return; // 文件不存在或无权限
        }

        const visitKey = `${normalizedPath}::${moduleNamespace.join('/')}`;
        if (this.visitedModuleScope.has(visitKey)) {
            return;
        }
        this.visitedModuleScope.add(visitKey);

        this.fileNamespaceMap.set(normalizedPath, moduleNamespace);
        this.fileInheritedAssetNamespaceMap.set(normalizedPath, [...inheritedAssetNamespace]);
        const directDependencies = new Set<string>();

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const ast = parser.parse(content, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx']
            });

            const { imports, localVars, exportedStoreObject, dynamicRegistrations } = await this.collectDeclarations(ast, filePath);

            let currentAssetNamespace = [...inheritedAssetNamespace];
            if (exportedStoreObject) {
                currentAssetNamespace = this.computeAssetNamespace(
                    moduleNamespace,
                    inheritedAssetNamespace,
                    exportedStoreObject,
                    localVars,
                );
                this.fileAssetNamespaceMap.set(normalizedPath, currentAssetNamespace);
                await this.processStoreObject(
                    exportedStoreObject,
                    filePath,
                    moduleNamespace,
                    currentAssetNamespace,
                    imports,
                    localVars,
                    directDependencies,
                    context,
                );
            }

            // 处理动态模块注册（namespace 需拼接 baseNamespace）
            for (const registration of dynamicRegistrations) {
                const dynamicInheritedAssetNamespace = registration.namespace.length > 1
                    ? [...currentAssetNamespace, ...registration.namespace.slice(0, -1)]
                    : currentAssetNamespace;
                await this.processModuleReference(
                    registration.moduleNode, filePath,
                    [...moduleNamespace, ...registration.namespace],
                    imports, localVars, directDependencies, context, dynamicInheritedAssetNamespace
                );
            }
        } catch (error) {
            console.error(`Error parsing module ${filePath}:`, error);
        } finally {
            this.setFileDependencies(normalizedPath, directDependencies);
        }
    }

    /**
     * 单次 traverse 收集所有必要信息：imports、局部变量、store 实例标识符、
     * 导出的 store 对象、动态模块注册
     */
    private async collectDeclarations(ast: t.File, filePath: string): Promise<{
        imports: Record<string, string>;
        localVars: Record<string, t.Node | null | undefined>;
        storeIdentifiers: Set<string>;
        exportedStoreObject: t.Node | null;
        dynamicRegistrations: Array<{ namespace: string[]; moduleNode: t.Node }>;
    }> {
        const imports: Record<string, string> = {};
        const localVars: Record<string, t.Node | null | undefined> = {};
        const storeIdentifiers = new Set<string>();
        const rawImports: Array<{ localName: string; source: string }> = [];

        // 导出 store 对象收集（原 findExportedStoreObject 逻辑）
        let exportDefault: t.Node | null = null;
        let moduleExports: t.Node | null = null;
        let newExpression: t.Node | null = null;

        // 动态注册收集（原 processDynamicModuleRegistrations 逻辑）
        const rawRegistrations: Array<{ call: t.CallExpression }> = [];

        // 延迟解析的 store 候选节点
        const storeCandidates: Array<{ id: string; init: t.Node }> = [];
        let exportDefaultCandidate: t.Node | null = null;
        let moduleExportsCandidate: t.Node | null = null;
        let newExpressionCandidate: t.Node | null = null;
        const isTopLevelDeclaration = (path: NodePath<any>) =>
            path.parentPath?.isProgram() === true
            || (path.parentPath?.isExportNamedDeclaration() === true && path.parentPath.parentPath?.isProgram() === true);

        traverse(ast, {
            ImportDeclaration: (path: NodePath<t.ImportDeclaration>) => {
                const source = path.node.source.value;
                path.node.specifiers.forEach((specifier) => {
                    if (specifier.local && specifier.local.name) {
                        rawImports.push({ localName: specifier.local.name, source });
                    }
                });
            },
            FunctionDeclaration: (path: NodePath<t.FunctionDeclaration>) => {
                if (!isTopLevelDeclaration(path)) return;
                if (path.node.id && path.node.id.name) {
                    localVars[path.node.id.name] = path.node;
                }
            },
            VariableDeclarator: (path: NodePath<t.VariableDeclarator>) => {
                const declarationPath = path.parentPath?.parentPath;
                const isTopLevelVariable =
                    declarationPath?.isProgram() === true
                    || (declarationPath?.isExportNamedDeclaration() === true && declarationPath.parentPath?.isProgram() === true);
                if (!isTopLevelVariable) return;
                if (path.node.id.type === 'Identifier') {
                    localVars[path.node.id.name] = path.node.init;
                }
                const id = path.node.id;
                if (!id || id.type !== 'Identifier') return;
                // 仅收集候选，延迟到遍历结束后解析
                if (path.node.init) {
                    storeCandidates.push({ id: id.name, init: path.node.init });
                }
            },
            ExportDefaultDeclaration: (path: NodePath<t.ExportDefaultDeclaration>) => {
                const declaration = path.node.declaration;
                // store identifier 检测
                if (declaration && declaration.type === 'Identifier') {
                    storeCandidates.push({ id: declaration.name, init: declaration });
                }
                // 导出 store 对象收集
                if (!exportDefault) {
                    exportDefaultCandidate = declaration;
                }
            },
            AssignmentExpression: (path: NodePath<t.AssignmentExpression>) => {
                const left = path.node.left;
                const isModuleExports =
                    left.type === 'MemberExpression' &&
                    left.object.type === 'Identifier' &&
                    left.object.name === 'module' &&
                    left.property.type === 'Identifier' &&
                    left.property.name === 'exports';
                const isExportsDefault =
                    left.type === 'MemberExpression' &&
                    left.object.type === 'Identifier' &&
                    left.object.name === 'exports' &&
                    left.property.type === 'Identifier' &&
                    left.property.name === 'default';
                if (!isModuleExports && !isExportsDefault) return;

                const right = path.node.right;
                // store identifier 检测
                if (right && right.type === 'Identifier') {
                    storeCandidates.push({ id: right.name, init: right });
                }
                // 导出 store 对象收集（module.exports / exports.default）
                if (!moduleExports) {
                    moduleExportsCandidate = right;
                }
            },
            NewExpression: (path: NodePath<t.NewExpression>) => {
                // 导出 store 对象收集（new Vuex.Store(...)）
                if (!newExpression) {
                    newExpressionCandidate = path.node;
                }
            },
            CallExpression: (path: NodePath<t.CallExpression>) => {
                // 动态模块注册检测（store.registerModule(...)）
                const call = path.node;
                const callee = call.callee;
                if (!callee || callee.type !== 'MemberExpression') return;
                if (callee.computed) return;
                if (callee.property.type !== 'Identifier' || callee.property.name !== 'registerModule') return;
                if (callee.object.type !== 'Identifier') return;
                if (!call.arguments || call.arguments.length < 2) return;
                // 暂存原始节点，后续用 storeIdentifiers 过滤
                rawRegistrations.push({ call });
            }
        });

        // resolve import paths（并行）
        const resolvedImports = await Promise.all(
            rawImports.map(async ({ localName, source }) => {
                const resolved = await this.pathResolver.resolve(source, filePath);
                return { localName, resolved };
            })
        );
        for (const { localName, resolved } of resolvedImports) {
            if (resolved) {
                imports[localName] = resolved;
            }
        }

        // --- Phase 2: Resolve Store Identifiers & Exports with complete localVars ---
        
        for (const { id, init } of storeCandidates) {
            const candidate = this.extractStoreObject(init, localVars);
            if (candidate) {
                storeIdentifiers.add(id);
            }
        }

        if (exportDefaultCandidate) {
            exportDefault = this.extractStoreObject(exportDefaultCandidate, localVars);
        }
        if (moduleExportsCandidate) {
            moduleExports = this.extractStoreObject(moduleExportsCandidate, localVars);
        }
        if (newExpressionCandidate) {
            newExpression = this.extractStoreObject(newExpressionCandidate, localVars);
        }

        // 导出 store 对象按优先级返回
        const exportedStoreObject = exportDefault ?? moduleExports ?? newExpression ?? null;

        // 过滤动态注册：仅保留 callee.object 在 storeIdentifiers 中的注册
        const dynamicRegistrations: Array<{ namespace: string[]; moduleNode: t.Node }> = [];
        for (const { call } of rawRegistrations) {
            const objectName = (call.callee as t.MemberExpression).object.type === 'Identifier'
                ? ((call.callee as t.MemberExpression).object as t.Identifier).name
                : '';
            if (!storeIdentifiers.has(objectName)) continue;
            const namespacePath = this.parseNamespaceArgument(call.arguments[0], localVars);
            if (!namespacePath || namespacePath.length === 0) continue;
            dynamicRegistrations.push({
                namespace: namespacePath,
                moduleNode: call.arguments[1]
            });
        }

        return { imports, localVars, storeIdentifiers, exportedStoreObject, dynamicRegistrations };
    }

    private parseNamespaceArgument(node: t.Node, localVars: Record<string, t.Node | null | undefined>): string[] | null {
        const resolved = this.resolveNode(node, localVars, 0, new Set());
        if (!resolved) return null;

        if (resolved.type === 'StringLiteral') {
            return [resolved.value];
        }

        if (resolved.type === 'ArrayExpression') {
            const namespace: string[] = [];
            for (const element of resolved.elements || []) {
                if (!element) return null;
                const resolvedElement = this.resolveNode(element, localVars, 0, new Set());
                if (!resolvedElement) return null;
                if (resolvedElement.type === 'StringLiteral') {
                    namespace.push(resolvedElement.value);
                    continue;
                }
                return null;
            }
            return namespace.length > 0 ? namespace : null;
        }

        return null;
    }

    private extractStoreObject(node: t.Node, localVars: Record<string, t.Node | null | undefined>): t.Node | null {
        const resolvedNode = this.resolveNode(node, localVars, 0, new Set());
        if (!resolvedNode) return null;

        if (resolvedNode.type === 'ObjectExpression') {
            return this.looksLikeStoreObject(resolvedNode) ? resolvedNode : null;
        }

        if (resolvedNode.type === 'NewExpression') {
            const arg0 = resolvedNode.arguments && resolvedNode.arguments.length > 0
                ? this.resolveNode(resolvedNode.arguments[0], localVars, 0, new Set())
                : null;

            if (arg0 && arg0.type === 'ObjectExpression' && this.looksLikeStoreObject(arg0)) {
                return arg0;
            }
        }

        if (resolvedNode.type === 'CallExpression') {
            const arg0 = resolvedNode.arguments && resolvedNode.arguments.length > 0
                ? this.resolveNode(resolvedNode.arguments[0], localVars, 0, new Set())
                : null;

            if (arg0 && arg0.type === 'ObjectExpression' && this.looksLikeStoreObject(arg0)) {
                return arg0;
            }
        }

        return null;
    }

    private looksLikeStoreObject(objExpression: t.Node): boolean {
        const keys = new Set<string>();
        (objExpression as t.ObjectExpression).properties.forEach((prop) => {
            const key = this.getPropertyKeyName(prop, {});
            if (key) keys.add(key);
        });

        return ['state', 'getters', 'mutations', 'actions', 'modules', 'namespaced'].some((k) => keys.has(k));
    }

    private resolveNode(node: t.Node | null | undefined, localVars: Record<string, t.Node | null | undefined>, depth: number, seen: Set<string>): t.Node | null | undefined {
        if (!node || depth > 12) return node;

        if (node.type === 'Identifier') {
            const name = node.name;
            if (seen.has(name)) return node;

            const next = localVars[name];
            if (!next) return node;

            seen.add(name);
            return this.resolveNode(next, localVars, depth + 1, seen);
        }

        if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression') {
            return this.resolveNode(node.expression, localVars, depth + 1, seen);
        }

        if (node.type === 'AwaitExpression') {
            return this.resolveNode(node.argument, localVars, depth + 1, seen);
        }

        if (node.type === 'OptionalCallExpression' || node.type === 'OptionalMemberExpression') {
            return node; // Babel 使用 Optional* 而非 ESTree 的 ChainExpression
        }

        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
            const calleeName = node.callee.name;
            if (seen.has(calleeName)) return node;

            const calleeNode = this.resolveNode(localVars[calleeName], localVars, depth + 1, seen);
            if (
                calleeNode &&
                (calleeNode.type === 'FunctionDeclaration' ||
                    calleeNode.type === 'FunctionExpression' ||
                    calleeNode.type === 'ArrowFunctionExpression')
            ) {
                seen.add(calleeName);
                const returned = this.resolveFunctionReturnValue(calleeNode, localVars, depth + 1, seen);
                if (returned) {
                    return returned;
                }
            }
        }

        return node;
    }

    private resolveFunctionReturnValue(
        fnNode: t.Node | null | undefined,
        localVars: Record<string, t.Node | null | undefined>,
        depth: number,
        seen: Set<string>
    ): t.Node | null | undefined {
        if (!fnNode) return null;

        if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body && fnNode.body.type !== 'BlockStatement') {
            return this.resolveNode(fnNode.body, localVars, depth + 1, seen);
        }

        const fnBody = 'body' in fnNode ? fnNode.body : undefined;
        const blockBody = fnBody && typeof fnBody === 'object' && 'type' in (fnBody as t.Node)
            && (fnBody as t.Node).type === 'BlockStatement'
            ? ((fnBody as t.BlockStatement).body) : [];
        for (const statement of blockBody) {
            if (statement.type === 'ReturnStatement' && statement.argument) {
                return this.resolveNode(statement.argument, localVars, depth + 1, seen);
            }
        }
        return null;
    }

    private async processStoreObject(
        objExpression: t.Node,
        filePath: string,
        moduleNamespace: string[],
        assetNamespace: string[],
        imports: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        directDependencies: Set<string>,
        context: ParseContext
    ): Promise<void> {
        for (const prop of (objExpression as t.ObjectExpression).properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;

            const keyName = this.getPropertyKeyName(prop, localVars);
            if (!keyName) continue;

            const valueNode = this.getPropertyValueNode(prop, localVars);

            if (keyName === 'state') {
                this.processState(valueNode, filePath, moduleNamespace, localVars);
            } else if (keyName === 'getters') {
                this.processGetters(valueNode, filePath, assetNamespace, localVars);
            } else if (keyName === 'mutations') {
                this.processMutations(valueNode, filePath, assetNamespace, localVars);
            } else if (keyName === 'actions') {
                this.processActions(valueNode, filePath, assetNamespace, localVars);
            } else if (keyName === 'modules') {
                await this.processModules(
                    valueNode,
                    filePath,
                    moduleNamespace,
                    assetNamespace,
                    imports,
                    localVars,
                    directDependencies,
                    context,
                );
            }
        }
    }

    private computeAssetNamespace(
        moduleNamespace: string[],
        inheritedAssetNamespace: string[],
        objExpression: t.Node,
        localVars: Record<string, t.Node | null | undefined>,
    ): string[] {
        if (moduleNamespace.length === 0) return [];
        if (!this.readNamespacedFlag(objExpression, localVars)) {
            return [...inheritedAssetNamespace];
        }
        const currentKey = moduleNamespace[moduleNamespace.length - 1];
        return [...inheritedAssetNamespace, currentKey];
    }

    private readNamespacedFlag(objExpression: t.Node, localVars: Record<string, t.Node | null | undefined>): boolean {
        for (const prop of (objExpression as t.ObjectExpression).properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;

            const keyName = this.getPropertyKeyName(prop, localVars);
            if (keyName !== 'namespaced') continue;

            const valueNode = this.getPropertyValueNode(prop, localVars);
            const resolvedValue = this.resolveNode(valueNode, localVars, 0, new Set());
            if (resolvedValue && resolvedValue.type === 'BooleanLiteral' && resolvedValue.value === true) {
                return true;
            }
        }
        return false;
    }

    private getPropertyValueNode(prop: ObjectMember, localVars: Record<string, t.Node | null | undefined>): t.Node | null | undefined {
        if (prop.type === 'ObjectMethod') {
            return prop;
        }
        if (prop.type === 'SpreadElement') {
            return prop.argument;
        }

        if (!prop.value) return prop.value;
        return this.resolveNode(prop.value, localVars, 0, new Set());
    }

    private getPropertyKeyName(prop: ObjectMember, localVars: Record<string, t.Node | null | undefined>): string | null {
        if (prop.type === 'SpreadElement') return null;
        const key = prop.key;
        if (!key) return null;

        if (key.type === 'Identifier' && !prop.computed) {
            return key.name;
        }

        if (key.type === 'StringLiteral') {
            return key.value;
        }

        if (key.type === 'NumericLiteral') {
            return String(key.value);
        }

        if (prop.computed) {
            const resolvedKey = this.resolveNode(key, localVars, 0, new Set());
            if (!resolvedKey) return null;

            if (resolvedKey.type === 'StringLiteral') {
                return resolvedKey.value;
            }

            if (resolvedKey.type === 'NumericLiteral') {
                return String(resolvedKey.value);
            }
        }

        return null;
    }

    private getPropertyLocation(prop: ObjectMember): t.SourceLocation | null {
        if (prop.type === 'SpreadElement') {
            return prop.loc ?? null;
        }
        if (prop.key && prop.key.loc) return prop.key.loc;
        if (prop.loc) return prop.loc;
        return null;
    }

    private processState(valueNode: t.Node | null | undefined, filePath: string, namespace: string[], localVars: Record<string, t.Node | null | undefined>): void {
        if (!valueNode) return;

        const resolvedValueNode = this.resolveNode(valueNode, localVars, 0, new Set());

        let stateObj = resolvedValueNode;
        if (resolvedValueNode && (resolvedValueNode.type === 'ArrowFunctionExpression' || resolvedValueNode.type === 'FunctionExpression')) {
            if (resolvedValueNode.body.type === 'ObjectExpression') {
                stateObj = resolvedValueNode.body;
            } else if (resolvedValueNode.body.type === 'BlockStatement') {
                const returnStmt = (resolvedValueNode as t.ArrowFunctionExpression & { body: t.BlockStatement }).body.body.find((statement: t.Node) => statement.type === 'ReturnStatement');
                if (returnStmt && returnStmt.argument) {
                    stateObj = this.resolveNode(returnStmt.argument, localVars, 0, new Set());
                }
            }
        }

        if (!stateObj || stateObj.type !== 'ObjectExpression') return;
        this.collectStateProperties(stateObj, filePath, namespace, localVars, []);
    }

    private collectStateProperties(
        stateObj: t.Node,
        filePath: string,
        moduleNamespace: string[],
        localVars: Record<string, t.Node | null | undefined>,
        nestedPath: string[]
    ): void {
        if (!stateObj || stateObj.type !== 'ObjectExpression') return;

        (stateObj as t.ObjectExpression).properties.forEach((property) => {
            if (property.type !== 'ObjectProperty') return;

            const keyName = this.getPropertyKeyName(property, localVars);
            const loc = this.getPropertyLocation(property);
            if (!keyName || !loc) return;

            const currentPath = [...moduleNamespace, ...nestedPath];
            this.storeMap.state.push({
                name: keyName,
                defLocation: this.createLocation(filePath, loc),
                modulePath: currentPath,
                documentation: this.extractDocumentation(property),
                displayType: this.inferType(property.value)
            });

            const resolvedValue = this.resolveNode(property.value, localVars, 0, new Set());
            if (resolvedValue && resolvedValue.type === 'ObjectExpression') {
                this.collectStateProperties(
                    resolvedValue,
                    filePath,
                    moduleNamespace,
                    localVars,
                    [...nestedPath, keyName]
                );
            }
        });
    }

    private createLocation(filePath: string, loc: t.SourceLocation): CoreLocation {
        const uri = vscode.Uri.file(filePath);
        const start = { line: loc.start.line - 1, character: loc.start.column };
        return {
            uri: {
                fsPath: uri.fsPath,
                toString: () => uri.toString(),
            },
            range: {
                start,
                end: start,
            },
        };
    }

    private inferType(node: t.Node | null | undefined): string | undefined {
        if (!node) return undefined;

        if (node.type === 'StringLiteral') return 'string';
        if (node.type === 'NumericLiteral') return 'number';
        if (node.type === 'BooleanLiteral') return 'boolean';
        if (node.type === 'NullLiteral') return 'null';
        if (node.type === 'ArrayExpression') return 'Array<unknown>';
        if (node.type === 'ObjectExpression') return 'Object';
        if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
            return node.callee.name;
        }
        if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return 'Function';

        return undefined;
    }

    private processGetters(valueNode: t.Node | null | undefined, filePath: string, namespace: string[], localVars: Record<string, t.Node | null | undefined>): void {
        this.processFunctionCollection(valueNode, filePath, namespace, localVars, this.storeMap.getters);
    }

    private processMutations(valueNode: t.Node | null | undefined, filePath: string, namespace: string[], localVars: Record<string, t.Node | null | undefined>): void {
        this.processFunctionCollection(valueNode, filePath, namespace, localVars, this.storeMap.mutations);
    }

    private processActions(valueNode: t.Node | null | undefined, filePath: string, namespace: string[], localVars: Record<string, t.Node | null | undefined>): void {
        if (!valueNode) return;

        const resolvedValue = this.resolveNode(valueNode, localVars, 0, new Set());
        if (!resolvedValue || resolvedValue.type !== 'ObjectExpression') return;

        (resolvedValue as t.ObjectExpression).properties.forEach((property) => {
            if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') return;

            const keyName = this.getPropertyKeyName(property, localVars);
            const loc = this.getPropertyLocation(property);
            if (!keyName || !loc) return;

            this.storeMap.actions.push({
                name: keyName,
                defLocation: this.createLocation(filePath, loc),
                modulePath: this.resolveActionNamespace(property, namespace, localVars),
                documentation: this.extractDocumentation(property)
            });
        });
    }

    private resolveActionNamespace(
        property: t.ObjectProperty | t.ObjectMethod,
        namespace: string[],
        localVars: Record<string, t.Node | null | undefined>,
    ): string[] {
        if (property.type === 'ObjectMethod') {
            return namespace;
        }

        const actionValue = this.resolveNode(property.value, localVars, 0, new Set());
        if (!actionValue || actionValue.type !== 'ObjectExpression') {
            return namespace;
        }

        const isRootAction = this.readBooleanProperty(actionValue, 'root', localVars);
        if (!isRootAction) {
            return namespace;
        }

        const handlerNode = this.getNamedPropertyValue(actionValue, 'handler', localVars);
        if (!handlerNode || !this.isCallableNode(handlerNode)) {
            return namespace;
        }

        return [];
    }

    private readBooleanProperty(
        objExpression: t.ObjectExpression,
        keyName: string,
        localVars: Record<string, t.Node | null | undefined>,
    ): boolean {
        for (const prop of objExpression.properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;
            if (this.getPropertyKeyName(prop, localVars) !== keyName) continue;
            const valueNode = this.getPropertyValueNode(prop, localVars);
            const resolvedValue = this.resolveNode(valueNode, localVars, 0, new Set());
            return !!(resolvedValue && resolvedValue.type === 'BooleanLiteral' && resolvedValue.value === true);
        }
        return false;
    }

    private getNamedPropertyValue(
        objExpression: t.ObjectExpression,
        keyName: string,
        localVars: Record<string, t.Node | null | undefined>,
    ): t.Node | null | undefined {
        for (const prop of objExpression.properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;
            if (this.getPropertyKeyName(prop, localVars) !== keyName) continue;
            return this.getPropertyValueNode(prop, localVars);
        }
        return undefined;
    }

    private isCallableNode(node: t.Node | null | undefined): boolean {
        if (!node) return false;
        return node.type === 'FunctionExpression'
            || node.type === 'ArrowFunctionExpression'
            || node.type === 'FunctionDeclaration'
            || node.type === 'ObjectMethod';
    }

    private processFunctionCollection(
        valueNode: t.Node | null | undefined,
        filePath: string,
        namespace: string[],
        localVars: Record<string, t.Node | null | undefined>,
        output: VuexGetterInfo[] | VuexMutationInfo[] | VuexActionInfo[]
    ): void {
        if (!valueNode) return;

        const resolvedValue = this.resolveNode(valueNode, localVars, 0, new Set());
        if (!resolvedValue || resolvedValue.type !== 'ObjectExpression') return;

        (resolvedValue as t.ObjectExpression).properties.forEach((property) => {
            if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') return;

            const keyName = this.getPropertyKeyName(property, localVars);
            const loc = this.getPropertyLocation(property);
            if (!keyName || !loc) return;

            output.push({
                name: keyName,
                defLocation: this.createLocation(filePath, loc),
                modulePath: namespace,
                documentation: this.extractDocumentation(property)
            });
        });
    }

    private async processModules(
        valueNode: t.Node | null | undefined,
        filePath: string,
        namespace: string[],
        inheritedAssetNamespace: string[],
        imports: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        directDependencies: Set<string>,
        context: ParseContext
    ): Promise<void> {
        if (!valueNode) return;

        const resolvedValue = this.resolveNode(valueNode, localVars, 0, new Set());
        if (!resolvedValue || resolvedValue.type !== 'ObjectExpression') return;

        await this.processModulesObjectExpression(
            resolvedValue,
            filePath,
            namespace,
            inheritedAssetNamespace,
            imports,
            localVars,
            directDependencies,
            context,
        );
    }

    private async processModulesObjectExpression(
        modulesObject: t.Node,
        filePath: string,
        namespace: string[],
        inheritedAssetNamespace: string[],
        imports: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        directDependencies: Set<string>,
        context: ParseContext
    ): Promise<void> {
        if (!modulesObject || modulesObject.type !== 'ObjectExpression') return;

        for (const property of modulesObject.properties) {
            if (property.type === 'SpreadElement') {
                const spreadValue = this.resolveNode(property.argument, localVars, 0, new Set());
                if (spreadValue && spreadValue.type === 'ObjectExpression') {
                    await this.processModulesObjectExpression(
                        spreadValue,
                        filePath,
                        namespace,
                        inheritedAssetNamespace,
                        imports,
                        localVars,
                        directDependencies,
                        context,
                    );
                }
                continue;
            }

            if (property.type !== 'ObjectProperty') continue;

            const moduleName = this.getPropertyKeyName(property, localVars);
            if (!moduleName) continue;

            const newNamespace = [...namespace, moduleName];
            await this.processModuleReference(
                property.value,
                filePath,
                newNamespace,
                imports,
                localVars,
                directDependencies,
                context,
                inheritedAssetNamespace,
            );
        }
    }

    private async processModuleReference(
        moduleNode: t.Node,
        filePath: string,
        namespace: string[],
        imports: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        directDependencies: Set<string>,
        context: ParseContext,
        inheritedAssetNamespace: string[],
    ): Promise<void> {
        const resolvedModule = this.resolveNode(moduleNode, localVars, 0, new Set());
        if (!resolvedModule) return;

        if (resolvedModule.type === 'ObjectExpression') {
            const assetNamespace = this.computeAssetNamespace(namespace, inheritedAssetNamespace, resolvedModule, localVars);
            await this.processStoreObject(
                resolvedModule,
                filePath,
                namespace,
                assetNamespace,
                imports,
                localVars,
                directDependencies,
                context,
            );
            return;
        }

        if (resolvedModule.type === 'Identifier') {
            const importedPath = await this.resolveImportedModulePath(resolvedModule.name, imports, localVars, filePath);
            if (importedPath) {
                directDependencies.add(vscode.Uri.file(importedPath).fsPath);
                await this.parseModule(importedPath, namespace, context, inheritedAssetNamespace);
                return;
            }

            const resolvedLocalValue = this.resolveNode(localVars[resolvedModule.name], localVars, 0, new Set());
            if (resolvedLocalValue && resolvedLocalValue.type === 'ObjectExpression') {
                const assetNamespace = this.computeAssetNamespace(namespace, inheritedAssetNamespace, resolvedLocalValue, localVars);
                await this.processStoreObject(
                    resolvedLocalValue,
                    filePath,
                    namespace,
                    assetNamespace,
                    imports,
                    localVars,
                    directDependencies,
                    context,
                );
            }
            return;
        }

        const dynamicPath = await this.resolveModulePathFromNode(resolvedModule, localVars, filePath);
        if (dynamicPath) {
            directDependencies.add(vscode.Uri.file(dynamicPath).fsPath);
            await this.parseModule(dynamicPath, namespace, context, inheritedAssetNamespace);
        }
    }

    private async resolveModulePathFromNode(node: t.Node, localVars: Record<string, t.Node | null | undefined>, filePath: string): Promise<string | null> {
        const resolvedNode = this.resolveNode(node, localVars, 0, new Set());
        if (!resolvedNode) return null;

        if (
            resolvedNode.type === 'CallExpression' &&
            resolvedNode.callee.type === 'Identifier' &&
            resolvedNode.callee.name === 'require'
        ) {
            const arg0 = resolvedNode.arguments && resolvedNode.arguments[0];
            if (arg0 && arg0.type === 'StringLiteral') {
                return await this.pathResolver.resolve(arg0.value, filePath);
            }
            return null;
        }

        if (resolvedNode.type === 'MemberExpression' && resolvedNode.object) {
            const objectNode = this.resolveNode(resolvedNode.object, localVars, 0, new Set());
            if (
                objectNode &&
                objectNode.type === 'CallExpression' &&
                objectNode.callee.type === 'Identifier' &&
                objectNode.callee.name === 'require'
            ) {
                const arg0 = objectNode.arguments && objectNode.arguments[0];
                if (arg0 && arg0.type === 'StringLiteral') {
                    return await this.pathResolver.resolve(arg0.value, filePath);
                }
            }
        }

        return null;
    }

    private async resolveImportedModulePath(
        identifier: string,
        imports: Record<string, string>,
        localVars: Record<string, t.Node | null | undefined>,
        filePath: string
    ): Promise<string | null> {
        if (imports[identifier]) {
            return imports[identifier];
        }

        const localValue = this.resolveNode(localVars[identifier], localVars, 0, new Set());
        if (!localValue) return null;
        return await this.resolveModulePathFromNode(localValue, localVars, filePath);
    }

    private resetAllIndexState(): void {
        this.storeMap = { state: [], getters: [], mutations: [], actions: [] };
        this.fileNamespaceMap.clear();
        this.fileInheritedAssetNamespaceMap.clear();
        this.fileAssetNamespaceMap.clear();
        this.visitedModuleScope.clear();
        this.fileDependencyMap.clear();
        this.reverseDependencyMap.clear();
    }

    private prepareIncrementalState(affectedFiles: Set<string>): void {
        this.storeMap = this.filterStoreMapExcludingFiles(affectedFiles);
        for (const file of affectedFiles) {
            this.fileNamespaceMap.delete(file);
            this.fileInheritedAssetNamespaceMap.delete(file);
            this.fileAssetNamespaceMap.delete(file);
            this.clearDependenciesForFile(file);
        }
        this.visitedModuleScope.clear();
    }

    private filterStoreMapExcludingFiles(excludedFiles: Set<string>): VuexStoreMap {
        const keep = <T extends { defLocation: CoreLocation }>(items: T[]) =>
            items.filter((item) => !excludedFiles.has(item.defLocation.uri.fsPath));

        return {
            state: keep(this.storeMap.state),
            getters: keep(this.storeMap.getters),
            mutations: keep(this.storeMap.mutations),
            actions: keep(this.storeMap.actions)
        };
    }

    private clearDependenciesForFile(file: string): void {
        const deps = this.fileDependencyMap.get(file);
        if (deps) {
            for (const dep of deps) {
                const parents = this.reverseDependencyMap.get(dep);
                if (!parents) continue;
                parents.delete(file);
                if (parents.size === 0) {
                    this.reverseDependencyMap.delete(dep);
                }
            }
        }

        this.fileDependencyMap.delete(file);
        this.reverseDependencyMap.delete(file);
    }

    private setFileDependencies(file: string, dependencies: Set<string>): void {
        this.clearDependenciesForFile(file);
        this.fileDependencyMap.set(file, new Set(dependencies));

        for (const dep of dependencies) {
            if (!this.reverseDependencyMap.has(dep)) {
                this.reverseDependencyMap.set(dep, new Set());
            }
            this.reverseDependencyMap.get(dep)!.add(file);
        }
    }

    private pruneUnreachableFiles(entryFile: string): void {
        const reachable = this.collectReachableFiles(entryFile);
        if (reachable.size === 0) return;

        const indexedFiles = Array.from(this.fileNamespaceMap.keys());
        const unreachable = indexedFiles.filter((file) => !reachable.has(file));
        if (unreachable.length === 0) return;

        const unreachableSet = new Set(unreachable);
        this.storeMap = this.filterStoreMapExcludingFiles(unreachableSet);
        for (const file of unreachableSet) {
            this.fileNamespaceMap.delete(file);
            this.fileInheritedAssetNamespaceMap.delete(file);
            this.fileAssetNamespaceMap.delete(file);
            this.clearDependenciesForFile(file);
        }
    }

    private collectReachableFiles(entryFile: string): Set<string> {
        const reachable = new Set<string>();
        const queue: string[] = [entryFile];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (reachable.has(current)) continue;
            reachable.add(current);

            const deps = this.fileDependencyMap.get(current);
            if (!deps) continue;
            for (const dep of deps) {
                if (!reachable.has(dep)) {
                    queue.push(dep);
                }
            }
        }

        return reachable;
    }

    private extractDocumentation(node: t.Node): string | undefined {
        if (!(node.leadingComments && Array.isArray(node.leadingComments) && node.leadingComments.length > 0)) {
            return undefined;
        }

        const jsDocComments = node.leadingComments.filter((comment) =>
            comment.type === 'CommentBlock' && comment.value.startsWith('*')
        );

        if (jsDocComments.length === 0) return undefined;

        return jsDocComments.map((comment) => {
            let value = comment.value;
            value = value.substring(1).trim();

            return value
                .split('\n')
                .map((line: string) => line.trim().replace(/^\*\s?/, ''))
                .join('  \n')
                .trim();
        }).join('\n\n');
    }

    public getNamespace(filePath: string): string[] | undefined {
        const normalizedPath = vscode.Uri.file(filePath).fsPath;
        return this.fileNamespaceMap.get(normalizedPath);
    }

    public dispose(): void {
        this.resetAllIndexState();
        this.pathResolver.clearCache();
        this.lastStoreEntryPath = null;
    }

    public getAssetNamespace(filePath: string): string[] | undefined {
        const normalizedPath = vscode.Uri.file(filePath).fsPath;
        return this.fileAssetNamespaceMap.get(normalizedPath);
    }

    public hasIndexedFile(filePath: string): boolean {
        const normalizedPath = vscode.Uri.file(filePath).fsPath;
        return this.fileNamespaceMap.has(normalizedPath);
    }

    public getAffectedFiles(changedFiles: string[]): string[] {
        const affected = new Set<string>();
        const queue = changedFiles
            .map((filePath) => vscode.Uri.file(filePath).fsPath)
            .filter((filePath) =>
                this.fileNamespaceMap.has(filePath) ||
                this.reverseDependencyMap.has(filePath) ||
                this.fileDependencyMap.has(filePath)
            );

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (affected.has(current)) continue;
            affected.add(current);

            const parents = this.reverseDependencyMap.get(current);
            if (!parents) continue;
            for (const parent of parents) {
                if (!affected.has(parent)) {
                    queue.push(parent);
                }
            }
        }

        return Array.from(affected);
    }
}
