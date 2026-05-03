import * as vscode from 'vscode';

export type VuexContextType = 'state' | 'getter' | 'mutation' | 'action' | 'unknown';

export interface VuexContext {
    type: VuexContextType;
    method: 'mapHelper' | 'dispatch' | 'commit' | 'access'; // 'access' for this.$store.state.xxx
    calleeName?: string; // actual callee token, e.g. "commit" / "dispatch" / alias like "c"
    namespace?: string;
    argumentIndex?: number; // 0-based index of the argument we are in
    isNested?: boolean; // true if we are inside [ ] or { } within the function call
    isObject?: boolean; // true if we are inside { } (Object context)
    isStoreMethod?: boolean; // true for this.$store.commit/dispatch style calls
}

type HelperName = 'mapState' | 'mapGetters' | 'mapMutations' | 'mapActions';

interface HelperContext {
    functionAliasMap: Record<string, { helperName: HelperName; namespace?: string }>;
    objectNamespaceMap: Record<string, string>;
    callAliasMap: Record<string, 'commit' | 'dispatch'>;
    contextObjectNames: Set<string>;
    thisAliases: Set<string>;
}

export class VuexContextScanner {

    // 静态正则缓存：避免每次 getContext 调用时重新构造
    private static readonly CONSTANT_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"][^'"]+['"])/g;
    private static readonly IMPORT_REGEX = /import\s*\{([^}]+)\}\s*from\s*['"]vuex['"]/g;
    private static readonly REQUIRE_REGEX = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]vuex['"]\s*\)/g;
    private static readonly ALIAS_ASSIGN_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(commit|dispatch)\b/g;
    private static readonly THIS_ALIAS_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*this\b/g;
    private static readonly DESTRUCTURE_REGEX = /\{([^{}]*\b(?:commit|dispatch)\b[^{}]*)\}/g;
    private static readonly FUNCTION_PARAM_REGEX = /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g;
    private static readonly METHOD_PARAM_REGEX = /\b(?:async\s+)?[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g;
    private static readonly ARROW_PARAM_REGEX = /\b([A-Za-z_$][\w$]*)\s*=>/g;
    private static readonly ARROW_PAREN_PARAM_REGEX = /\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))\s*=>/g;
    private static readonly SEARCH_WINDOW_BEFORE = 6000;
    private static readonly SEARCH_WINDOW_AFTER = 1200;

    // 单条目缓存：同一位置被 completion/hover/definition 连续查询时直接返回
    private contextCache?: {
        uri: string;
        version: number;
        offset: number;
        storeLikeKey: string;
        result: VuexContext | undefined;
    };

    /**
     * Determines the Vuex context at the given position.
     * Scans backwards to find if we are inside matchers like mapState([...]), this.$store.commit(...), etc.
     */
    public getContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        storeLikeNames: ReadonlySet<string> = new Set(),
    ): VuexContext | undefined {
        const offset = document.offsetAt(position);
        const uri = document.uri?.toString();
        const version = document.version;
        const storeLikeKey = Array.from(storeLikeNames).sort().join('|');

        // 缓存命中检查
        if (uri && this.contextCache &&
            this.contextCache.uri === uri &&
            this.contextCache.version === version &&
            this.contextCache.offset === offset &&
            this.contextCache.storeLikeKey === storeLikeKey) {
            return this.contextCache.result;
        }

        const result = this.computeContext(document, position, offset, storeLikeNames);

        // 更新缓存
        if (uri) {
            this.contextCache = { uri, version, offset, storeLikeKey, result };
        }

        return result;
    }

    private computeContext(
        document: vscode.TextDocument,
        position: vscode.Position,
        offset: number,
        storeLikeNames: ReadonlySet<string>,
    ): VuexContext | undefined {
        const window = this.getScanWindow(document, position, offset);
        if (!window) return undefined;

        let scriptStart = 0;
        if (document.fileName.endsWith('.vue')) {
            const scriptScope = this.resolveVueScriptScope(window.text, window.localOffset);
            if (!scriptScope.inScript) return undefined;
            scriptStart = scriptScope.start;
        }

        // Safety check limit (look back max 2000 chars, but not before script start)
        const searchLimit = Math.max(scriptStart, window.localOffset - 2000);
        const snippet = window.text.substring(searchLimit, window.localOffset);
        const helperContext = this.collectHelperContext(snippet);

        // Tokenize properly retaining string values to extract arguments
        const tokens = this.tokenize(snippet);

        // Parse stack to find enclosing function call and extracted args
        const result = this.analyzeTokens(tokens, helperContext, storeLikeNames);

        return result;
    }

    private getScanWindow(
        document: vscode.TextDocument,
        position: vscode.Position,
        offset: number
    ): { text: string; localOffset: number } | undefined {
        const hasRangeApi =
            typeof (document as any).positionAt === 'function' &&
            typeof (document as any).lineCount === 'number' &&
            typeof (document as any).lineAt === 'function';

        if (!hasRangeApi) {
            const text = document.getText();
            return { text, localOffset: offset };
        }

        const startOffset = Math.max(0, offset - VuexContextScanner.SEARCH_WINDOW_BEFORE);
        const endOffset = Math.min(
            this.getDocumentEndOffset(document),
            offset + VuexContextScanner.SEARCH_WINDOW_AFTER
        );
        const text = document.getText(
            new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset)
            )
        );
        const localOffset = Math.max(0, Math.min(text.length, offset - startOffset));
        return { text, localOffset };
    }

    private getDocumentEndOffset(document: vscode.TextDocument): number {
        const lastLineIndex = Math.max(0, document.lineCount - 1);
        const lastLine = document.lineAt(lastLineIndex);
        return document.offsetAt(new vscode.Position(lastLineIndex, lastLine.text.length));
    }

    private resolveVueScriptScope(windowText: string, localOffset: number): { inScript: boolean; start: number; end: number } {
        const scriptOpenRegex = /<script\b[^>]*>/gi;
        const scriptCloseToken = '</script>';
        let lastOpenStart = -1;
        let lastOpenEnd = -1;

        for (const match of windowText.matchAll(scriptOpenRegex)) {
            const openStart = match.index ?? -1;
            if (openStart < 0 || openStart > localOffset) break;
            lastOpenStart = openStart;
            lastOpenEnd = openStart + match[0].length;
        }

        const lastCloseBeforeCursor = windowText.lastIndexOf(scriptCloseToken, localOffset);
        if (lastOpenStart >= 0 && lastOpenStart > lastCloseBeforeCursor) {
            const closeAfterCursor = windowText.indexOf(scriptCloseToken, localOffset);
            return {
                inScript: true,
                start: lastOpenEnd,
                end: closeAfterCursor >= 0 ? closeAfterCursor : windowText.length
            };
        }

        // 兼容窗口从 script 中间开始的情况：左侧看不到 <script>，但右侧存在 </script>。
        if (lastOpenStart < 0 && windowText.indexOf(scriptCloseToken, localOffset) >= 0) {
            return {
                inScript: true,
                start: 0,
                end: windowText.indexOf(scriptCloseToken, localOffset)
            };
        }

        // 无 script 标签时按脚本内容处理（兼容测试及非标准片段）。
        if (!/<script\b/i.test(windowText) && !windowText.includes(scriptCloseToken)) {
            return { inScript: true, start: 0, end: windowText.length };
        }

        return { inScript: false, start: 0, end: windowText.length };
    }

    private tokenize(code: string): { type: 'word' | 'symbol' | 'string', value: string, index: number }[] {
        const tokens: { type: 'word' | 'symbol' | 'string', value: string, index: number }[] = [];

        // Regex:
        // 1. Strings: "...", '...', `...` - 单行匹配，避免截断导致跨行错误配对
        // 2. Symbols: ( ) [ ] { } ,
        // 3. Words: identifiers

        // 字符串匹配不跨行，避免 snippet 截断导致未闭合引号与后续引号错误配对
        const tokenRegex = /("[^\n]*?"|'[^\n]*?'|`[^`]*?`)|([(){},\[\]\.])|([a-zA-Z0-9_$]+)/g;

        // Pre-process: replace comments with spaces to avoid matching inside comments
        // Block comments: /\*[\s\S]*?\*/
        // Line comments: //.*$

        // We do this carefully. If we just blindly replace, we might mess up if a comment looks like a string or vice versa.
        // But for a simple scanner, standard strip is usually okay.
        const codeWithoutComments = code.replace(/\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

        let match;
        while ((match = tokenRegex.exec(codeWithoutComments)) !== null) {
            if (match[1]) {
                tokens.push({ type: 'string', value: match[1], index: match.index });
            } else if (match[2]) {
                tokens.push({ type: 'symbol', value: match[2], index: match.index });
            } else if (match[3]) {
                tokens.push({ type: 'word', value: match[3], index: match.index });
            }
        }
        return tokens;
    }

    private analyzeTokens(
        tokens: { type: string, value: string }[],
        helperContext: HelperContext,
        storeLikeNames: ReadonlySet<string>,
    ): VuexContext | undefined {
        // Stack to track brackets/parentheses and what precedes them
        // We also want to track arguments 'accumulated' inside the current parentheses scope
        const outputStack: {
            token: string,
            index: number,
            precedingWord: string,
            precedingObject: string,
            precedingParentObject: string,
            extractedArgs: string[],
            argIndex: number // Track current argument index (comma count)
        }[] = [];

        let prevWord = '';
        let prevObject = '';
        let prevParentObject = '';
        let pendingMemberObject = '';
        let pendingMemberParentObject = '';

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            if (token.type === 'symbol') {
                if (token.value === '.') {
                    if (prevWord) {
                        pendingMemberObject = prevWord;
                        pendingMemberParentObject = prevObject;
                    }
                    prevWord = '';
                    continue;
                }

                if (['(', '{', '['].includes(token.value)) {
                    outputStack.push({
                        token: token.value,
                        index: i,
                        precedingWord: prevWord,
                        precedingObject: prevObject,
                        precedingParentObject: prevParentObject,
                        extractedArgs: [],
                        argIndex: 0
                    });
                    prevWord = '';
                    prevObject = '';
                    prevParentObject = '';
                    pendingMemberObject = '';
                    pendingMemberParentObject = '';
                } else if ([')', '}', ']'].includes(token.value)) {
                    if (outputStack.length > 0) {
                        const last = outputStack[outputStack.length - 1];
                        // Basic matching check
                        if ((token.value === ')' && last.token === '(') ||
                            (token.value === '}' && last.token === '{') ||
                            (token.value === ']' && last.token === '[')) {
                            outputStack.pop();
                        }
                    }
                    prevWord = '';
                    prevObject = '';
                    prevParentObject = '';
                    pendingMemberObject = '';
                    pendingMemberParentObject = '';
                } else if (token.value === ',') {
                     // Comma increments argument index for the current scope
                     if (outputStack.length > 0) {
                         outputStack[outputStack.length - 1].argIndex++;
                     }
                     prevWord = '';
                     prevObject = '';
                     prevParentObject = '';
                     pendingMemberObject = '';
                     pendingMemberParentObject = '';
                }
            } else if (token.type === 'string') {
                // If we are directly inside a function call '(', this string is an argument
                 if (outputStack.length > 0) {
                     const last = outputStack[outputStack.length - 1];
                     if (last.token === '(') {
                        last.extractedArgs.push(token.value);
                     }
                 }
                 prevWord = '';
                 prevObject = '';
                 prevParentObject = '';
                 pendingMemberObject = '';
                 pendingMemberParentObject = '';
            } else {
                // word
                prevWord = token.value;
                if (pendingMemberObject) {
                    prevParentObject = pendingMemberParentObject;
                    prevObject = pendingMemberObject;
                    pendingMemberObject = '';
                    pendingMemberParentObject = '';
                } else {
                    prevObject = '';
                    prevParentObject = '';
                }
            }
        }

        // Now, look at the stack to find the immediate Vuex context.

        // nestingLevel: 0 means we are directly in the function. > 0 means we are in [ or {
        let nestingLevel = 0;

        for (let i = outputStack.length - 1; i >= 0; i--) {
            const frame = outputStack[i];

            if (frame.token === '(') {
                const func = frame.precedingWord;
                const helperInfo = helperContext.functionAliasMap[func];
                const canonicalFunc = helperInfo?.helperName || func;
                let namespace: string | undefined = helperInfo?.namespace;
                if (!namespace && frame.precedingObject) {
                    namespace = helperContext.objectNamespaceMap[frame.precedingObject];
                }
                let namespaceFromArguments: string | undefined = undefined;

                // Identify namespace if present (if we are at argIndex >= 1)
                if (frame.extractedArgs.length > 0) {
                    const firstArg = frame.extractedArgs[0];
                    // Strip quotes
                    if (firstArg.length >= 2) {
                         namespaceFromArguments = firstArg.slice(1, -1);
                    }
                }

                // If we are in the first argument (argIndex 0), namespace is not yet established from arguments
                // (unless we are editing it right now, which is handled by provider logic using direct string match)
                if (frame.argIndex > 0 && namespaceFromArguments) {
                    namespace = namespaceFromArguments;
                }

                if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(canonicalFunc)) {
                    let type: VuexContextType = 'unknown';
                    if (canonicalFunc === 'mapState') type = 'state';
                    if (canonicalFunc === 'mapGetters') type = 'getter';
                    if (canonicalFunc === 'mapMutations') type = 'mutation';
                    if (canonicalFunc === 'mapActions') type = 'action';

                    return {
                        type,
                        method: 'mapHelper',
                        calleeName: func,
                        namespace,
                        argumentIndex: frame.argIndex,
                        isNested: nestingLevel > 0,
                        isObject: nestingLevel > 0 && outputStack[outputStack.length - 1].token === '{'
                    };
                }

                const callAliasMethod = helperContext.callAliasMap[func];
                const parentObject = frame.precedingParentObject;
                const isThisStoreMethod =
                    frame.precedingObject === '$store' &&
                    (parentObject === 'this' || helperContext.thisAliases.has(parentObject));
                const isImportedStoreMethod =
                    !!frame.precedingObject && storeLikeNames.has(frame.precedingObject);
                const directMethod =
                    (func === 'commit' || func === 'dispatch') &&
                    frame.precedingObject &&
                    (
                        helperContext.contextObjectNames.has(frame.precedingObject) ||
                        isThisStoreMethod ||
                        isImportedStoreMethod
                    )
                        ? func
                        : undefined;
                const effectiveMethod = (callAliasMethod || directMethod) as 'commit' | 'dispatch' | undefined;
                if (effectiveMethod === 'commit' || effectiveMethod === 'dispatch') {
                    let type: VuexContextType = 'unknown';
                     if (effectiveMethod === 'commit') type = 'mutation';
                     if (effectiveMethod === 'dispatch') type = 'action';
                    const isStoreMethod = isThisStoreMethod || isImportedStoreMethod;
                    return {
                         type,
                         method: effectiveMethod as any,
                         calleeName: func,
                         namespace, // Usually commit('ns/module')
                         argumentIndex: frame.argIndex,
                         isNested: nestingLevel > 0,
                         isObject: false, // commit/dispatch don't usually use object context like mapHelpers
                         isStoreMethod
                     };
                }
            }

            // If we didn't return, we are going up the stack.
            // The current frame (e.g. '[') contributes to nesting for the *next* iteration (parent).
            nestingLevel++;
        }

        return undefined;
    }

    private collectHelperContext(snippet: string): HelperContext {
        const functionAliasMap: Record<string, { helperName: HelperName; namespace?: string }> = {
            mapState: { helperName: 'mapState' },
            mapGetters: { helperName: 'mapGetters' },
            mapMutations: { helperName: 'mapMutations' },
            mapActions: { helperName: 'mapActions' }
        };
        const objectNamespaceMap: Record<string, string> = {};
        const callAliasMap: Record<string, 'commit' | 'dispatch'> = {};
        const contextObjectNames = new Set<string>();
        const thisAliases = new Set<string>(['this']);
        const stringConstants: Record<string, string> = {};
        const namespacedFactoryNames = new Set<string>(['createNamespacedHelpers']);

        const parseNamespaceArg = (raw: string): string | undefined => {
            const trimmed = raw.trim();
            const quoted = trimmed.match(/^['"]([^'"]+)['"]$/);
            if (quoted) return quoted[1];
            return stringConstants[trimmed];
        };

        const collectParamNames = (regex: RegExp) => {
            regex.lastIndex = 0;
            for (const match of snippet.matchAll(regex)) {
                const paramName = match[1];
                if (paramName) {
                    contextObjectNames.add(paramName);
                }
            }
        };

        collectParamNames(VuexContextScanner.FUNCTION_PARAM_REGEX);
        collectParamNames(VuexContextScanner.METHOD_PARAM_REGEX);
        collectParamNames(VuexContextScanner.ARROW_PARAM_REGEX);
        collectParamNames(VuexContextScanner.ARROW_PAREN_PARAM_REGEX);

        VuexContextScanner.CONSTANT_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.CONSTANT_REGEX)) {
            const varName = match[1];
            const literal = match[2];
            const valueMatch = literal.match(/^['"]([^'"]+)['"]$/);
            if (varName && valueMatch) {
                stringConstants[varName] = valueMatch[1];
            }
        }

        VuexContextScanner.IMPORT_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.IMPORT_REGEX)) {
            const specList = match[1];
            if (!specList) continue;
            const specs = specList.split(',').map((s) => s.trim()).filter(Boolean);
            specs.forEach((spec) => {
                const aliasMatch = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                const importedName = aliasMatch ? aliasMatch[1] : spec;
                const localName = aliasMatch ? aliasMatch[2] : spec;
                if (importedName === 'createNamespacedHelpers') {
                    namespacedFactoryNames.add(localName);
                    return;
                }
                if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(importedName)) {
                    functionAliasMap[localName] = { helperName: importedName as HelperName };
                }
            });
        }

        VuexContextScanner.REQUIRE_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.REQUIRE_REGEX)) {
            const specList = match[1];
            if (!specList) continue;
            const specs = specList.split(',').map((s) => s.trim()).filter(Boolean);
            specs.forEach((spec) => {
                const aliasMatch = spec.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
                const importedName = aliasMatch ? aliasMatch[1] : spec;
                const localName = aliasMatch ? aliasMatch[2] : spec;
                if (importedName === 'createNamespacedHelpers') {
                    namespacedFactoryNames.add(localName);
                    return;
                }
                if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(importedName)) {
                    functionAliasMap[localName] = { helperName: importedName as HelperName };
                }
            });
        }

        namespacedFactoryNames.forEach((factoryName) => {
            const escapedFactory = factoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const objectFactoryRegex = new RegExp(
                `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedFactory}\\(\\s*([^\\)]+)\\s*\\)`,
                'g'
            );
            for (const match of snippet.matchAll(objectFactoryRegex)) {
                const localName = match[1];
                const namespace = parseNamespaceArg(match[2] || '');
                if (localName && namespace) {
                    objectNamespaceMap[localName] = namespace;
                }
            }

            const destructureFactoryRegex = new RegExp(
                `\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escapedFactory}\\(\\s*([^\\)]+)\\s*\\)`,
                'g'
            );
            for (const match of snippet.matchAll(destructureFactoryRegex)) {
                const specList = match[1];
                const namespace = parseNamespaceArg(match[2] || '');
                if (!specList || !namespace) continue;

                const specs = specList.split(',').map((s) => s.trim()).filter(Boolean);
                specs.forEach((spec) => {
                    const aliasMatch = spec.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
                    const helperName = aliasMatch ? aliasMatch[1] : spec;
                    const localName = aliasMatch ? aliasMatch[2] : spec;
                    if (['mapState', 'mapGetters', 'mapMutations', 'mapActions'].includes(helperName)) {
                        functionAliasMap[localName] = { helperName: helperName as HelperName, namespace };
                    }
                });
            }
        });

        VuexContextScanner.ALIAS_ASSIGN_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.ALIAS_ASSIGN_REGEX)) {
            const localName = match[1];
            const sourceName = match[2] as 'commit' | 'dispatch';
            if (localName && sourceName && callAliasMap[sourceName]) {
                callAliasMap[localName] = sourceName;
            }
        }

        const memberAliasAssignRegex =
            /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:this(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*|([A-Za-z_$][\w$]*)(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.\s*(commit|dispatch)\b/g;
        for (const match of snippet.matchAll(memberAliasAssignRegex)) {
            const localName = match[1];
            const sourceObject = match[2];
            const sourceName = match[3] as 'commit' | 'dispatch';
            if (localName && sourceName && sourceObject && contextObjectNames.has(sourceObject)) {
                callAliasMap[localName] = sourceName;
            }
        }

        VuexContextScanner.THIS_ALIAS_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.THIS_ALIAS_REGEX)) {
            const aliasName = match[1];
            if (aliasName) {
                thisAliases.add(aliasName);
            }
        }

        VuexContextScanner.DESTRUCTURE_REGEX.lastIndex = 0;
        for (const match of snippet.matchAll(VuexContextScanner.DESTRUCTURE_REGEX)) {
            const specList = match[1];
            if (!specList) continue;
            const specs = specList.split(',').map((s) => s.trim()).filter(Boolean);
            specs.forEach((spec) => {
                const noDefault = spec.split('=')[0].trim();
                const aliasMatch = noDefault.match(/^(commit|dispatch)\s*:\s*([A-Za-z_$][\w$]*)$/);
                if (aliasMatch) {
                    callAliasMap[aliasMatch[2]] = aliasMatch[1] as 'commit' | 'dispatch';
                    return;
                }
                if (noDefault === 'commit' || noDefault === 'dispatch') {
                    callAliasMap[noDefault] = noDefault as 'commit' | 'dispatch';
                }
            });
        }

        return { functionAliasMap, objectNamespaceMap, callAliasMap, contextObjectNames, thisAliases };
    }
}
