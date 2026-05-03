import * as vscode from 'vscode';
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
    hasScopedVuexCallContext,
    hasParamContextMemberAccess,
    hasParamBindingMemberAccess,
    hasRootTrueOption,
    resolveMappedItem,
} from '../utils/VuexProviderUtils';

export class VuexHoverProvider implements vscode.HoverProvider {
    private contextScanner: VuexContextScanner;
    private componentMapper: ComponentMapper;
    private storeIndexer: StoreIndexer;
    private lookupService: VuexLookupService;
    private pathResolver: PathResolver;
    private storeLikeNamesCache?: { uri: string; version: number; names: string[] };

    constructor(storeIndexer: StoreIndexer, componentMapper?: ComponentMapper) {
        this.storeIndexer = storeIndexer;
        this.contextScanner = new VuexContextScanner();
        this.componentMapper = componentMapper ?? new ComponentMapper();
        this.lookupService = new VuexLookupService(storeIndexer);
        this.pathResolver = new PathResolver(storeIndexer.getWorkspaceRoot());
    }

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (token.isCancellationRequested) return undefined;
        
        const range = document.getWordRangeAtPosition(position);
        if (!range) return undefined;
        const word = document.getText(range);
        const storeLikeNames = await this.getStoreLikeNames(document);
        const storeLikeNameSet = new Set(storeLikeNames);
        
        // 1. Vuex Context (String literals)
        // Moved logical check down to combine with context awareness
        const context = this.contextScanner.getContext(document, position, storeLikeNameSet);
        if (token.isCancellationRequested) return undefined;

        // 2. Component Mapping (this.methodName)
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
            return this.findHover(mappedItem.originalName, mappedItem.type, mappedItem.namespace);
        }

        const currentNamespace = this.storeIndexer.getNamespace(document.fileName);
        const currentAssetNamespace = this.storeIndexer.getAssetNamespace(document.fileName) ?? currentNamespace;
        const validatedContext =
            context &&
            (context.method !== 'commit' && context.method !== 'dispatch' ||
                context.isStoreMethod === true ||
                hasScopedVuexCallContext(document, position, context.method, currentNamespace))
                ? context
                : undefined;

        // 3. Local State Hover (state.xxx)
        const stateAccessPath = extractStateAccessPath(rawPrefix, word);
        const contextStateAccessPath = extractContextAccessPath(rawPrefix, word, 'state');
        const contextGettersAccessPath = extractContextAccessPath(rawPrefix, word, 'getters');

        // 3a. rootState.xxx hover — 从根开始查找 state
        const rootStateAccessPath = extractRootAccessPath(rawPrefix, word, 'rootState');
        if (
            rootStateAccessPath &&
            hasParamBindingMemberAccess(document, position, 'rootState', currentNamespace)
        ) {
            return this.findHover(rootStateAccessPath, 'state');
        }

        const contextRootStateAccessPath = extractContextAccessPath(rawPrefix, word, 'rootState');
        if (
            contextRootStateAccessPath &&
            hasParamContextMemberAccess(document, position, 'rootState', currentNamespace)
        ) {
            return this.findHover(contextRootStateAccessPath, 'state');
        }

        // 3b. rootGetters.xxx hover — 用 extractRootAccessPath 统一处理
        const rootGettersAccessPath = extractRootAccessPath(rawPrefix, word, 'rootGetters');
        if (
            rootGettersAccessPath &&
            hasParamBindingMemberAccess(document, position, 'rootGetters', currentNamespace)
        ) {
            return this.findHover(rootGettersAccessPath, 'getter');
        }

        const contextRootGettersAccessPath = extractContextAccessPath(rawPrefix, word, 'rootGetters');
        if (
            contextRootGettersAccessPath &&
            hasParamContextMemberAccess(document, position, 'rootGetters', currentNamespace)
        ) {
            return this.findHover(contextRootGettersAccessPath, 'getter');
        }

        // 3c. Bracket Notation hover：rootGetters['...'] / this.$store?.getters?.['...']
        const stringLiteralObj = extractStringLiteralPathAtPosition(document, position);
        if (stringLiteralObj) {
            const { path: fullPath, range: literalRange } = stringLiteralObj;
            const textBefore = lineText.substring(0, literalRange.start.character).trimEnd();
            const bracketAccessType = detectStoreBracketAccessor(textBefore, currentNamespace, storeLikeNames);
            if (bracketAccessType) {
                return this.findHover(fullPath, bracketAccessType);
            }
        }

        if (
            currentNamespace &&
            /\bstate(?:\?\.|\.)$/.test(rawPrefix) &&
            hasParamBindingMemberAccess(document, position, 'state', currentNamespace)
        ) {
             return this.findHover(word, 'state', currentNamespace.join('/'));
        }

        if (
            currentNamespace &&
            contextStateAccessPath &&
            hasParamContextMemberAccess(document, position, 'state', currentNamespace)
        ) {
             return this.findHover(contextStateAccessPath, 'state', undefined, currentNamespace);
        }

        if (
            currentAssetNamespace &&
            /(?<!\.|root)\bgetters(?:\?\.|\.)$/.test(rawPrefix) &&
            hasParamBindingMemberAccess(document, position, 'getters', currentNamespace)
        ) {
             return this.findHover(word, 'getter', currentAssetNamespace.join('/'));
        }

        if (
            currentAssetNamespace &&
            contextGettersAccessPath &&
            hasParamContextMemberAccess(document, position, 'getters', currentNamespace)
        ) {
             return this.findHover(contextGettersAccessPath, 'getter', undefined, currentAssetNamespace);
        }

        // 3d. this.$store.state.xxx / this.$store?.getters?.xxx hover
        const storeAccess = extractStoreAccessPath(rawPrefix, word, storeLikeNames);
        if (storeAccess) {
            const { type: accessType, accessPath } = storeAccess;
            const dotIndex = accessPath.lastIndexOf('.');
            if (dotIndex >= 0) {
                const ns = accessPath.substring(0, dotIndex).replace(/\./g, '/');
                const name = accessPath.substring(dotIndex + 1);
                return this.findHover(name, accessType, ns);
            }
            return this.findHover(word, accessType);
        }

        // Re-check context with awareness of current file namespace
        if (validatedContext && validatedContext.type !== 'unknown') {
             const preferLocalFromContext = !(
                 (validatedContext.method === 'commit' || validatedContext.method === 'dispatch') &&
                 (
                     validatedContext.isStoreMethod === true ||
                     hasRootTrueOption(document, position, validatedContext.method, validatedContext.calleeName)
                 )
             );
             if (validatedContext.type === 'state' && stateAccessPath) {
                 return this.findHover(stateAccessPath, 'state', validatedContext.namespace, currentNamespace, preferLocalFromContext);
             }
             const lookupNamespace = validatedContext.type === 'state'
                 ? currentNamespace
                 : currentAssetNamespace;
             const explicitPath = stringLiteralObj?.path;
             if (explicitPath && explicitPath.includes('/')) {
                 const parts = explicitPath.split('/');
                 const nameFromPath = parts.pop();
                 const namespaceFromPath = parts.join('/');
                 if (nameFromPath && namespaceFromPath) {
                     return this.findHover(nameFromPath, validatedContext.type, namespaceFromPath, lookupNamespace, preferLocalFromContext);
                 }
             }
             return this.findHover(word, validatedContext.type, validatedContext.namespace, lookupNamespace, preferLocalFromContext);
        }

        return undefined;
    }


    private findHover(
        name: string,
        type: 'state' | 'getter' | 'mutation' | 'action',
        namespace?: string,
        currentNamespace?: string[],
        preferLocal: boolean = true
    ): vscode.Hover | undefined {
        const result = this.lookupService.findItem({
            name,
            type,
            namespace,
            currentNamespace,
            preferLocal
        }) as { defLocation: { uri: { fsPath: string } }, documentation?: string } | undefined;
        let labelPrefix = '';

        if (type === 'action') labelPrefix = 'Action';
        else if (type === 'mutation') labelPrefix = 'Mutation';
        else if (type === 'state') labelPrefix = 'State';
        else if (type === 'getter') labelPrefix = 'Getter';

        if (result) {
            const md = new vscode.MarkdownString();
            
            let label = `${labelPrefix}: ${name}`;
            if (type === 'state') {
                const stateInfo = result as any; // Cast to access displayType
                if (stateInfo.displayType) {
                    label += `: ${stateInfo.displayType}`;
                }
            }
            
            md.appendMarkdown(label);
            if (result.documentation) {
                md.appendMarkdown(`\n\n${result.documentation}\n\n`);
            } else {
                md.appendMarkdown('\n\n');
            }
            md.appendMarkdown(`Defined in: **${vscode.workspace.asRelativePath(result.defLocation.uri.fsPath)}**`);
            return new vscode.Hover(md);
        }
        return undefined;
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
