import * as vscode from 'vscode';
import { toVscodeLocation } from '../adapters/vscode/converters';
import { StoreIndexer } from '../services/StoreIndexer';
import { VuexContextScanner } from '../services/VuexContextScanner';
import { ComponentMapper } from '../services/ComponentMapper';
import { VuexLookupService } from '../services/VuexLookupService';
import { PathResolver } from '../utils/PathResolver';
import {
    collectStoreLikeNames,
    extractStateAccessPath,
    extractContextAccessPath,
    extractRootAccessPath,
    extractStringLiteralPathAtPosition,
    detectStoreBracketAccessor,
    extractStoreAccessPath,
    hasChainedPropertySuffix,
    hasRootTrueOption,
    hasScopedVuexCallContext,
    hasParamContextMemberAccess,
    hasParamBindingMemberAccess,
    resolveMappedItem,
} from '../utils/VuexProviderUtils';

export class VuexDefinitionProvider implements vscode.DefinitionProvider {
    private scanner: VuexContextScanner;
    private componentMapper: ComponentMapper;
    private storeIndexer: StoreIndexer;
    private lookupService: VuexLookupService;
    private pathResolver: PathResolver;
    private storeLikeNamesCache?: { uri: string; version: number; names: string[] };

    constructor(storeIndexer: StoreIndexer, componentMapper?: ComponentMapper) {
        this.storeIndexer = storeIndexer;
        this.scanner = new VuexContextScanner();
        this.componentMapper = componentMapper ?? new ComponentMapper();
        this.lookupService = new VuexLookupService(storeIndexer);
        this.pathResolver = new PathResolver(storeIndexer.getWorkspaceRoot());
    }

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Definition | undefined> {
        if (token.isCancellationRequested) return undefined;
        
        const range = document.getWordRangeAtPosition(position);
        if (!range) return undefined;

        const word = document.getText(range);
        const storeLikeNames = await this.getStoreLikeNames(document);
        const storeLikeNameSet = new Set(storeLikeNames);

        // 1. Component Mapping (for this.methodName usage)
        const lineText = document.lineAt(position.line).text;

        // 跳过注释行（单行注释 // 和块注释中间的 * 行）
        const trimmedLine = lineText.trimStart();
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
            return undefined;
        }

        const rawPrefix = lineText.substring(0, range.start.character);
        const mapping = this.componentMapper.getMapping(document);
        const mappedItem = resolveMappedItem(mapping, rawPrefix, word);
        if (mappedItem) {
            return this.findDefinition(mappedItem.originalName, mappedItem.type, mappedItem.namespace);
        }

        // 功能 3：检查是否是 state 链式访问的中间路径词（如 state.common.merchant 中的 common）
        if (!mappedItem) {
            for (const key in mapping) {
                if (token.isCancellationRequested) return undefined;
                const info = mapping[key];
                if (info.type === 'state' && info.originalName.includes('.')) {
                    const parts = info.originalName.split('.');
                    const wordIndex = parts.indexOf(word);
                    if (wordIndex >= 0 && wordIndex < parts.length - 1) {
                        // word 是中间路径段，跳转到对应的 module 定义
                        const modulePath = parts.slice(0, wordIndex + 1).join('/');
                        const fullNamespace = info.namespace
                            ? `${info.namespace}/${modulePath}`
                            : modulePath;
                        return this.findModuleDefinition(fullNamespace);
                    }
                }
            }
        }

        const currentNamespace = this.storeIndexer.getNamespace(document.fileName);
        const currentAssetNamespace = this.storeIndexer.getAssetNamespace(document.fileName) ?? currentNamespace;

        // 2. Local State Definition (state.xxx)
        // Check if preceding text ends with "state."
        const stateAccessPath = extractStateAccessPath(rawPrefix, word);
        const contextStateAccessPath = extractContextAccessPath(rawPrefix, word, 'state');
        const contextGettersAccessPath = extractContextAccessPath(rawPrefix, word, 'getters');

        // 2a. rootState.xxx — 从根开始查找 state
        const rootStateAccessPath = extractRootAccessPath(rawPrefix, word, 'rootState');
        if (
            rootStateAccessPath &&
            hasParamBindingMemberAccess(document, position, 'rootState', currentNamespace)
        ) {
            // 检查 word 右侧是否有后续 ".xxx"，如果有则当前词是中间路径词
            const rawSuffix = lineText.substring(range.end.character);
            if (hasChainedPropertySuffix(rawSuffix)) {
                // word 是中间路径词，跳转到对应的 module 定义
                const nsSegments = rootStateAccessPath.replace(/\./g, '/');
                const moduleDef = this.findModuleDefinition(nsSegments);
                if (moduleDef) return moduleDef;
            }
            return this.findDefinition(rootStateAccessPath, 'state');
        }

        const contextRootStateAccessPath = extractContextAccessPath(rawPrefix, word, 'rootState');
        if (
            contextRootStateAccessPath &&
            hasParamContextMemberAccess(document, position, 'rootState', currentNamespace)
        ) {
            const rawSuffix = lineText.substring(range.end.character);
            if (hasChainedPropertySuffix(rawSuffix)) {
                const nsSegments = contextRootStateAccessPath.replace(/\./g, '/');
                const moduleDef = this.findModuleDefinition(nsSegments);
                if (moduleDef) return moduleDef;
            }
            return this.findDefinition(contextRootStateAccessPath, 'state');
        }

        // 2b. rootGetters.xxx — 用 extractRootAccessPath 统一处理
        const rootGettersAccessPath = extractRootAccessPath(rawPrefix, word, 'rootGetters');
        if (
            rootGettersAccessPath &&
            hasParamBindingMemberAccess(document, position, 'rootGetters', currentNamespace)
        ) {
            return this.findDefinition(rootGettersAccessPath, 'getter');
        }

        const contextRootGettersAccessPath = extractContextAccessPath(rawPrefix, word, 'rootGetters');
        if (
            contextRootGettersAccessPath &&
            hasParamContextMemberAccess(document, position, 'rootGetters', currentNamespace)
        ) {
            return this.findDefinition(contextRootGettersAccessPath, 'getter');
        }

        // 2c. Bracket Notation: rootGetters['...'] / this.$store.getters['...']
        const stringLiteralObj = extractStringLiteralPathAtPosition(document, position);
        if (stringLiteralObj) {
            const { path: fullPath, range: literalRange } = stringLiteralObj;
            const prefixEndIndex = literalRange.start.character;
            const textBefore = lineText.substring(0, prefixEndIndex).trimEnd();

            const bracketAccessType = detectStoreBracketAccessor(textBefore, currentNamespace, storeLikeNames);
            if (bracketAccessType) {
                 const parts = fullPath.split('/');
                 const nameFromPath = parts.pop()!;
                 const namespaceFromPath = parts.join('/');

                 // 检查光标是否在 namespace 段上
                 if (word !== nameFromPath && parts.includes(word)) {
                     const moduleDef = this.findModuleDefinition(namespaceFromPath);
                     if (moduleDef) return moduleDef;
                 }
                 
                 return this.findDefinition(fullPath, bracketAccessType);
            }
        }


        if (
            currentNamespace &&
            /\bstate(?:\?\.|\.)$/.test(rawPrefix) &&
            hasParamBindingMemberAccess(document, position, 'state', currentNamespace)
        ) {
             return this.findDefinition(word, 'state', currentNamespace.join('/'));
        }

        if (
            currentNamespace &&
            contextStateAccessPath &&
            hasParamContextMemberAccess(document, position, 'state', currentNamespace)
        ) {
            return this.findDefinition(contextStateAccessPath, 'state', undefined, currentNamespace);
        }

        // 2c-2. 内部 getters.xxx 跳转（排除 rootGetters）
        if (
            currentAssetNamespace &&
            /(?<!\.|root)\bgetters(?:\?\.|\.)$/.test(rawPrefix) &&
            hasParamBindingMemberAccess(document, position, 'getters', currentNamespace)
        ) {
             return this.findDefinition(word, 'getter', currentAssetNamespace.join('/'));
        }

        if (
            currentAssetNamespace &&
            contextGettersAccessPath &&
            hasParamContextMemberAccess(document, position, 'getters', currentNamespace)
        ) {
             return this.findDefinition(contextGettersAccessPath, 'getter', undefined, currentAssetNamespace);
        }

        // 2d. this.$store.state.xxx.yyy / this.$store?.getters.xxx — 通用链式访问（含可选链）
        const storeAccess = extractStoreAccessPath(rawPrefix, word, storeLikeNames);
        if (storeAccess) {
            const { type: accessType, accessPath } = storeAccess;
            const rawSuffix = lineText.substring(range.end.character);
            if (hasChainedPropertySuffix(rawSuffix)) {
                // word 是中间路径词（模块名），跳转到模块定义
                const nsSegments = accessPath.replace(/\./g, '/');
                const moduleDef = this.findModuleDefinition(nsSegments);
                if (moduleDef) return moduleDef;
            }
            // 末端词，作为 state/getter 查找（需要解析出 namespace 和 name）
            const dotIndex = accessPath.lastIndexOf('.');
            if (dotIndex >= 0) {
                const ns = accessPath.substring(0, dotIndex).replace(/\./g, '/');
                const name = accessPath.substring(dotIndex + 1);
                return this.findDefinition(name, accessType, ns);
            }
            // 单层访问如 $store.getters.isAdmin / $store?.getters?.isAdmin（无 namespace）
            return this.findDefinition(word, accessType);
        }

        // 3. Try VuexContextScanner (for String Literal contexts like mapState('...'))
        const context = this.scanner.getContext(document, position, storeLikeNameSet);
        if (token.isCancellationRequested) return undefined;
        // Re-check context with awareness of current file namespace
        const scopedContext =
            context &&
            (context.method !== 'commit' && context.method !== 'dispatch' ||
                context.isStoreMethod === true ||
                hasScopedVuexCallContext(document, position, context.method, currentNamespace))
                ? context
                : undefined;
        if (scopedContext && scopedContext.type !== 'unknown') {
            const preferLocalFromContext = !(
                (scopedContext.method === 'commit' || scopedContext.method === 'dispatch') &&
                (
                    scopedContext.isStoreMethod === true ||
                    hasRootTrueOption(document, position, scopedContext.method, scopedContext.calleeName)
                )
            );
            if (scopedContext.type === 'state' && stateAccessPath) {
                // 功能 3 补充：在 state 上下文中检查中间路径词的 module 跳转
                // 例如 state.user.name 中点击 user，stateAccessPath = "user"
                // 需要检查 word 右侧是否还有 ".xxx" 后续路径
                const rawSuffix = lineText.substring(range.end.character);
                if (hasChainedPropertySuffix(rawSuffix)) {
                    // word 右侧还有后续路径（如 ".name"），说明 word 是中间路径词
                    const nsFromPath = stateAccessPath; // stateAccessPath 已经包含了 word 及其左侧路径
                    const nsSegments = nsFromPath.replace(/\./g, '/');
                    const fullNs = scopedContext.namespace
                        ? `${scopedContext.namespace}/${nsSegments}`
                        : nsSegments;
                    const moduleDef = this.findModuleDefinition(fullNs);
                    if (moduleDef) return moduleDef;
                }
                return this.findDefinition(stateAccessPath, 'state', scopedContext.namespace, currentNamespace, preferLocalFromContext);
            }
            // 3. Try VuexContextScanner (for String Literal contexts like mapState('...'))
            // Note: extractStringLiteralPathAtPosition result is reused from earlier call
            const explicitPath = stringLiteralObj ? stringLiteralObj.path : undefined;

            // mapState/mapGetters/mapMutations/mapActions('namespace', [...])
            // 首参是独立 namespace 时，跳转到对应模块文件。
            if (
                scopedContext.method === 'mapHelper' &&
                scopedContext.argumentIndex === 0 &&
                scopedContext.isNested !== true &&
                explicitPath
            ) {
                const moduleDef = this.findModuleDefinition(explicitPath);
                if (moduleDef) return moduleDef;
            }
            
            if (explicitPath && explicitPath.includes('/')) {
                const parts = explicitPath.split('/');
                const nameFromPath = parts.pop()!;
                const namespaceFromPath = parts.join('/');

                // 检查光标是否在 namespace 段上（如 'common/a' 中点击 common）
                if (word !== nameFromPath && parts.includes(word)) {
                    const moduleDef = this.findModuleDefinition(namespaceFromPath);
                    if (moduleDef) return moduleDef;
                }

                if (nameFromPath && namespaceFromPath) {
                    return this.findDefinition(nameFromPath, scopedContext.type, namespaceFromPath, currentNamespace, preferLocalFromContext);
                }
            }
            const lookupNamespace = scopedContext.type === 'state'
                ? currentNamespace
                : currentAssetNamespace;
            return this.findDefinition(word, scopedContext.type, scopedContext.namespace, lookupNamespace, preferLocalFromContext);
        }

        return undefined;
    }

    private findDefinition(
        name: string,
        type: 'state' | 'getter' | 'mutation' | 'action',
        namespace?: string,
        currentNamespace?: string[],
        preferLocal: boolean = true
    ): vscode.Definition | undefined {
        const found = this.lookupService.findItem({
            name,
            type,
            namespace,
            currentNamespace,
            preferLocal,
            allowRootFallback: true
        });
        return found ? toVscodeLocation(found.defLocation) : undefined;
    }

    /**
     * 查找指定命名空间对应的模块文件定义位置。
     * 通过查找 storeMap 中属于该命名空间的任意项来定位文件。
     */
    private findModuleDefinition(namespace: string): vscode.Definition | undefined {
        const def = this.storeIndexer.getModuleDefinition(namespace);
        if (!def) return undefined;
        return new vscode.Location(vscode.Uri.file(def.uri.fsPath), new vscode.Position(0, 0));
    }

    private async getStoreLikeNames(document: vscode.TextDocument): Promise<string[]> {
        const uri = document.uri?.toString();
        const version = document.version;
        if (
            uri &&
            this.storeLikeNamesCache?.uri === uri &&
            this.storeLikeNamesCache.version === version
        ) {
            return this.storeLikeNamesCache.names;
        }

        const names = await collectStoreLikeNames(
            document,
            this.pathResolver,
            this.storeIndexer.getStoreEntryPath()
        );
        if (uri) {
            this.storeLikeNamesCache = { uri, version, names };
        }
        return names;
    }
}
