import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import * as vscode from 'vscode';

export interface ComponentMapInfo {
    // Map local name to Vuex item Info
    // type: 'state' | 'getter' | 'mutation' | 'action'
    // originalName: string (the name in the store)
    // namespace?: string (the namespace if any)
    [localName: string]: {
        type: 'state' | 'getter' | 'mutation' | 'action';
        originalName: string;
        namespace?: string;
    };
}

export class ComponentMapper {
    
    private readonly maxCacheEntries = 100;
    private cache: Map<string, { version: number, signature: string, mapping: ComponentMapInfo }> = new Map();
    private static readonly NO_VUEX_SIGNATURE = '__no_vuex_helpers__';
    private static readonly VUEX_HINT_REGEX =
        /(mapState|mapGetters|mapMutations|mapActions|createNamespacedHelpers|from\s+['"]vuex['"]|require\(\s*['"]vuex['"]\s*\))/;

    /**
     * Analyzes the given document to find Vuex mapHelpers and build a mapping.
     */
    public getMapping(document: vscode.TextDocument): ComponentMapInfo {
        const text = document.getText();
        const uri = document.uri.toString();
        const fileName = typeof document.fileName === 'string' ? document.fileName : '';

        // For Vue SFC files, extract script content.
        // Host tests may open .vue as javascript/plaintext when Vue language service is unavailable.
        let scriptContent = text;
        const isVueSfc = document.languageId === 'vue' || fileName.endsWith('.vue');
        if (isVueSfc) {
            const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
            const parts: string[] = [];
            let match;
            while ((match = scriptRegex.exec(text)) !== null) {
                parts.push(match[1]);
            }
            if (parts.length > 0) {
                scriptContent = parts.join('\n');
            }
        }
        const hasVuexHint = ComponentMapper.VUEX_HINT_REGEX.test(scriptContent);
        const semanticSignature = hasVuexHint
            ? this.computeSemanticSignature(scriptContent)
            : ComponentMapper.NO_VUEX_SIGNATURE;

        const cached = this.cache.get(uri);
        if (cached && (cached.version === document.version || cached.signature === semanticSignature)) {
            // Touch entry for basic LRU behavior.
            if (cached.version !== document.version) {
                cached.version = document.version;
            }
            this.cache.delete(uri);
            this.cache.set(uri, cached);
            return cached.mapping;
        }

        // 快速路径：该脚本与 Vuex map helpers 无关，避免不必要 AST 解析。
        if (!hasVuexHint) {
            const emptyMapping: ComponentMapInfo = {};
            this.cache.set(uri, { version: document.version, signature: semanticSignature, mapping: emptyMapping });
            this.trimCache();
            return emptyMapping;
        }

        // 预处理：修复不完整的代码，使其能够被解析
        let processedContent = scriptContent;

        // 修复行末的 `this.` / `this?.` 及其别名（如 `_t.` / `_t?.`）后面没有属性名的情况
        const thisAliasPattern = this.buildThisAliasPattern(scriptContent);
        processedContent = processedContent.replace(
            new RegExp(`(^|[^\\w$])(${thisAliasPattern})\\?\\.\\s*$`, 'gm'),
            '$1$2?.__placeholder__'
        );
        processedContent = processedContent.replace(
            new RegExp(`(^|[^\\w$])(${thisAliasPattern})\\.\\s*$`, 'gm'),
            '$1$2.__placeholder__'
        );

        // 修复 mapHelper 数组中的空字符串参数
        // 如 mapState([""]) -> mapState(["__placeholder__"])
        // 如 mapState(["count", ""]) -> mapState(["count", "__placeholder__"])
        // 如 mapState(["", "count"]) -> mapState(["__placeholder__", "count"])
        processedContent = processedContent.replace(/,\s*(['"])\s*\1\s*([,\]])/g, ', "__placeholder__"$2');
        processedContent = processedContent.replace(/\[\s*(['"])\s*\1\s*([,\]])/g, '["__placeholder__"$2');

        // 修复 mapHelper 对象中的空字符串值，如 { key: "" } -> { key: "__placeholder__" }
        processedContent = processedContent.replace(/:\s*(['"])\s*\1\s*([,}\]])/g, ': "__placeholder__"$2');

        try {
            const ast = parser.parse(processedContent, {
                sourceType: 'module',
                plugins: ['typescript', 'decorators-legacy', 'classProperties', 'jsx'],
                errorRecovery: true, // Crucial for completion while typing
                allowAwaitOutsideFunction: true,
                allowReturnOutsideFunction: true,
                allowUndeclaredExports: true
            });

            const mapping: ComponentMapInfo = {};
            const validHelpers = ['mapState', 'mapGetters', 'mapMutations', 'mapActions'] as const;
            type HelperName = typeof validHelpers[number];
            const helperFunctionInfo: Record<string, { namespace?: string; helperName: HelperName }> = {};
            const helperObjectNamespace: Record<string, string> = {};
            const namespacedFactoryNames = new Set<string>(['createNamespacedHelpers']);
            const localStringConstants: Record<string, string> = {};

            // 合并三次 AST 遍历为一次
            traverse(ast, {
                ImportDeclaration: (path: NodePath<t.ImportDeclaration>) => {
                    const declaration = path.node;
                    if (!declaration.source || declaration.source.value !== 'vuex') return;

                    declaration.specifiers.forEach((specifier) => {
                        if (!specifier.local || !specifier.local.name) return;

                        if (specifier.type === 'ImportSpecifier') {
                            const imported = specifier.imported;
                            const importedName = imported.type === 'Identifier' ? imported.name : (imported as t.StringLiteral).value;
                            const localName = specifier.local.name;
                            if (importedName === 'createNamespacedHelpers') {
                                namespacedFactoryNames.add(localName);
                                return;
                            }
                            if (validHelpers.includes(importedName as HelperName)) {
                                helperFunctionInfo[localName] = {
                                    helperName: importedName as HelperName
                                };
                            }
                        }
                    });
                },
                VariableDeclarator: (path: NodePath<t.VariableDeclarator>) => {
                    const declarator = path.node;

                    if (
                        declarator.id?.type === 'Identifier' &&
                        declarator.init?.type === 'StringLiteral'
                    ) {
                        localStringConstants[declarator.id.name] = declarator.init.value;
                    }

                    if (
                        declarator.id?.type === 'ObjectPattern' &&
                        declarator.init?.type === 'CallExpression' &&
                        declarator.init.callee?.type === 'Identifier' &&
                        declarator.init.callee.name === 'require' &&
                        declarator.init.arguments?.[0]?.type === 'StringLiteral' &&
                        declarator.init.arguments[0].value === 'vuex'
                    ) {
                        (declarator.id as t.ObjectPattern).properties.forEach((prop) => {
                            if (prop.type !== 'ObjectProperty') return;

                            const importedName = prop.key.type === 'Identifier' ? prop.key.name : (prop.key as t.StringLiteral).value;
                            const localName = prop.value.type === 'Identifier' ? (prop.value as t.Identifier).name : importedName;
                            if (!importedName || !localName) return;

                            if (importedName === 'createNamespacedHelpers') {
                                namespacedFactoryNames.add(localName);
                                return;
                            }

                            if (validHelpers.includes(importedName as HelperName)) {
                                helperFunctionInfo[localName] = { helperName: importedName as HelperName };
                            }
                        });
                    }

                    if (!declarator.init || declarator.init.type !== 'CallExpression') return;
                    const init = declarator.init;

                    if (init.callee.type !== 'Identifier' || !namespacedFactoryNames.has(init.callee.name)) return;
                    if (!init.arguments || init.arguments.length === 0) return;

                    let namespace: string | undefined;
                    const namespaceArg = init.arguments[0];
                    if (namespaceArg.type === 'StringLiteral') {
                        namespace = namespaceArg.value;
                    } else if (namespaceArg.type === 'Identifier') {
                        namespace = localStringConstants[namespaceArg.name];
                    }
                    if (!namespace) return;

                    if (declarator.id.type === 'Identifier') {
                        helperObjectNamespace[declarator.id.name] = namespace;
                        return;
                    }

                    if (declarator.id.type === 'ObjectPattern') {
                        (declarator.id as t.ObjectPattern).properties.forEach((prop) => {
                            if (prop.type !== 'ObjectProperty') return;

                            const importedName = prop.key.type === 'Identifier' ? prop.key.name : (prop.key as t.StringLiteral).value;
                            if (!importedName || !validHelpers.includes(importedName as HelperName)) return;

                            const localName = prop.value.type === 'Identifier' ? (prop.value as t.Identifier).name : importedName;
                            helperFunctionInfo[localName] = { namespace, helperName: importedName as HelperName };
                        });
                    }
                },
                CallExpression: (path: NodePath<t.CallExpression>) => {
                    const callee = path.node.callee;
                    let calleeName: string | undefined;
                    let inferredNamespace: string | undefined;
                    let inferredHelperName: HelperName | undefined;

                    if (callee.type === 'Identifier') {
                        calleeName = callee.name;
                        const helperInfo = helperFunctionInfo[callee.name];
                        inferredNamespace = helperInfo?.namespace;
                        inferredHelperName = helperInfo?.helperName;
                    } else if (callee.type === 'MemberExpression' && callee.property) {
                        calleeName = callee.property.type === 'Identifier' ? callee.property.name : undefined;
                        if (callee.object && callee.object.type === 'Identifier') {
                            inferredNamespace = helperObjectNamespace[callee.object.name];
                        }
                    }

                    if (typeof calleeName === 'string') {
                        const helperName = (inferredHelperName || calleeName) as string;
                        if (!validHelpers.includes(helperName as HelperName)) {
                            return;
                        }

                        let type: 'state' | 'getter' | 'mutation' | 'action' | undefined;

                        if (helperName === 'mapState') type = 'state';
                        else if (helperName === 'mapGetters') type = 'getter';
                        else if (helperName === 'mapMutations') type = 'mutation';
                        else if (helperName === 'mapActions') type = 'action';

                        if (!type) return;

                        const args = path.node.arguments;
                        if (args.length === 0) return;

                        let namespace: string | undefined = inferredNamespace;
                        let mapObj: t.Node | undefined;

                        // Check for namespace: mapState('ns', [...])
                        if (args[0].type === 'StringLiteral') {
                            namespace = args[0].value;
                            if (args.length > 1) {
                                mapObj = args[1];
                            }
                        } else if (
                            args[0].type === 'Identifier' &&
                            !!localStringConstants[args[0].name] &&
                            args.length > 1
                        ) {
                            namespace = localStringConstants[args[0].name];
                            mapObj = args[1];
                        } else {
                            mapObj = args[0];
                        }

                        if (!mapObj) return;

                        // Handle Array: mapState(['count']) -> local 'count' maps to store 'count'
                        if (mapObj.type === 'ArrayExpression') {
                            (mapObj as t.ArrayExpression).elements.forEach((el) => {
                                if (el && el.type === 'StringLiteral') {
                                    const name = el.value;
                                    mapping[name] = { type: type!, originalName: name, namespace };
                                }
                            });
                        }
                        // Handle Object: mapState({ alias: 'count' })
                        else if (mapObj.type === 'ObjectExpression') {
                            (mapObj as t.ObjectExpression).properties.forEach((prop) => {
                                if (prop.type === 'ObjectProperty') {
                                    const localName = prop.key.type === 'Identifier'
                                        ? prop.key.name
                                        : (prop.key as t.StringLiteral).value;

                                    if (prop.value.type === 'StringLiteral') {
                                        mapping[localName] = { type: type!, originalName: prop.value.value, namespace };
                                    } else if (
                                        prop.value.type === 'ArrowFunctionExpression' ||
                                        prop.value.type === 'FunctionExpression'
                                    ) {
                                        // mapState({ local: state => state.xxx }) / method wrapper variants
                                        const inferredStateName =
                                            type === 'state' ? this.inferStatePropertyNameFromFunction(prop.value) : undefined;
                                        mapping[localName] = {
                                            type: type!,
                                            originalName: inferredStateName || localName,
                                            namespace
                                        };
                                    }
                                } else if (prop.type === 'ObjectMethod') {
                                    const localName = prop.key.type === 'Identifier'
                                        ? (prop.key as t.Identifier).name
                                        : (prop.key as t.StringLiteral).value;
                                    const inferredStateName =
                                        type === 'state' ? this.inferStatePropertyNameFromFunction(prop) : undefined;
                                    mapping[localName] = {
                                        type: type!,
                                        originalName: inferredStateName || localName,
                                        namespace
                                    };
                                }
                            });
                        }
                    }
                }
            });

            // 过滤掉预处理占位符 __placeholder__
            // 1. 删除 key 为 __placeholder__ 的映射
            delete mapping['__placeholder__'];

            // 2. 删除 originalName 为 __placeholder__ 的映射（值是空字符串的情况）
            for (const key in mapping) {
                if (mapping[key].originalName === '__placeholder__') {
                    delete mapping[key];
                }
            }

            // Success, update cache
            this.cache.set(uri, { version: document.version, signature: semanticSignature, mapping });
            this.trimCache();
            return mapping;

        } catch (e) {
            // If failed (highly unlikely with errorRecovery, but still), return cache
            return cached ? cached.mapping : {};
        }
    }

    public dispose(): void {
        this.cache.clear();
    }

    public getCacheSize(): number {
        return this.cache.size;
    }

    private inferStatePropertyNameFromFunction(fnNode: t.Node): string | undefined {
        if (!fnNode) return undefined;
        // 确认是函数类型节点
        const fn = fnNode as t.Function;
        if (!fn.params || fn.params.length === 0) {
            return undefined;
        }

        const firstParam = fn.params[0];
        if (!firstParam || firstParam.type !== 'Identifier' || !firstParam.name) {
            return undefined;
        }

        const stateParamName = firstParam.name;
        const expr = this.extractReturnedExpressionFromFunction(fnNode);
        if (!expr) {
            return undefined;
        }

        return this.inferStatePropertyFromExpression(expr, stateParamName);
    }

    private extractReturnedExpressionFromFunction(fnNode: t.Node): t.Node | undefined {
        if (!fnNode) return undefined;
        const fn = fnNode as t.Function & { body?: t.Node };

        if (fnNode.type === 'ArrowFunctionExpression' && fn.body && fn.body.type !== 'BlockStatement') {
            return fn.body;
        }

        const fnBody = fn.body;
        const blockBody = fnBody && fnBody.type === 'BlockStatement'
            ? (fnBody as t.BlockStatement).body : [];
        for (const statement of blockBody) {
            if (statement.type === 'ReturnStatement' && statement.argument) {
                return statement.argument;
            }
        }
        return undefined;
    }

    private inferStatePropertyFromExpression(expr: t.Node, stateParamName: string): string | undefined {
        let current = expr;

        // Unwrap wrappers to keep the extraction tolerant while editing.
        while (current && (current.type === 'TSAsExpression' || current.type === 'TSTypeAssertion' || current.type === 'ParenthesizedExpression')) {
            current = (current as t.TSAsExpression | t.TSTypeAssertion | t.ParenthesizedExpression).expression as t.Node;
        }

        if (!current) return undefined;

        const segments: string[] = [];
        let cursor: t.Node = current;
        while (cursor && (cursor.type === 'MemberExpression' || cursor.type === 'OptionalMemberExpression')) {
            const memberCursor = cursor as t.MemberExpression;
            const propertyNode = memberCursor.property;
            if (!propertyNode) return undefined;

            let propName: string | undefined;
            if (!memberCursor.computed && propertyNode.type === 'Identifier') {
                propName = propertyNode.name;
            } else if (memberCursor.computed && propertyNode.type === 'StringLiteral') {
                propName = propertyNode.value;
            }
            if (!propName) return undefined;

            segments.unshift(propName);
            cursor = memberCursor.object;
        }

        if (!cursor || cursor.type !== 'Identifier' || cursor.name !== stateParamName) {
            return undefined;
        }

        return segments.join('.');
    }

    private trimCache(): void {
        while (this.cache.size > this.maxCacheEntries) {
            const firstKey = this.cache.keys().next().value;
            if (!firstKey) break;
            this.cache.delete(firstKey);
        }
    }

    private buildThisAliasPattern(scriptContent: string): string {
        const aliases = new Set<string>(['this', 'vm']);
        const aliasRegex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*this\b/g;
        let match: RegExpExecArray | null;

        while ((match = aliasRegex.exec(scriptContent)) !== null) {
            if (match[1]) aliases.add(match[1]);
        }

        return Array.from(aliases)
            .sort((a, b) => b.length - a.length)
            .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');
    }

    private computeSemanticSignature(scriptContent: string): string {
        const lines = scriptContent.split(/\r?\n/);
        const importantLines = lines
            .map((line) => line.trim())
            .filter((line) =>
                /(mapState|mapGetters|mapMutations|mapActions|createNamespacedHelpers|from\s+['"]vuex['"]|require\(\s*['"]vuex['"]\s*\)|=\s*this\b)/.test(line)
            );
        return importantLines.join('\n');
    }
}
