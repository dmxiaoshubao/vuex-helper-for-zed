import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import type * as t from '@babel/types';
import { CoreLocation } from '../core/types';
import { StoreIndexer } from './StoreIndexer';
import { VuexLookupService } from './VuexLookupService';
import {
    hasExplicitVuexStoreStructure,
    isLikelyVuexContextBinding,
    isLikelyVuexSpecialParamBinding,
} from '../utils/VuexProviderUtils';

/**
 * 可诊断的 Vuex 引用
 */
interface DiagnosableRef {
    name: string;
    type: 'state' | 'getter' | 'mutation' | 'action';
    namespace?: string;
    range: vscode.Range;
    preferLocal?: boolean;
    currentNamespace?: string[];
}

// mapHelper 名称到 Vuex 类型的映射
const HELPER_TYPE_MAP: Record<string, 'state' | 'getter' | 'mutation' | 'action'> = {
    mapState: 'state',
    mapGetters: 'getter',
    mapMutations: 'mutation',
    mapActions: 'action',
};

/**
 * Vuex 诊断 Provider：扫描文档中的 Vuex 引用，标记不存在的 store 项。
 */
export class VuexDiagnosticProvider {
    private lookupService: VuexLookupService;

    constructor(private readonly storeIndexer: StoreIndexer) {
        this.lookupService = new VuexLookupService(storeIndexer);
    }

    /**
     * 对单个文档执行全量诊断，返回 Diagnostic 数组。
     */
    public diagnose(document: vscode.TextDocument): vscode.Diagnostic[] {
        if (!this.storeIndexer.getStoreMap()) return [];

        const refs = this.scanReferences(document);
        const diagnostics: vscode.Diagnostic[] = this.collectDuplicateGlobalGetterDiagnostics(document);

        for (const ref of refs) {
            const found = this.lookupService.findItem({
                name: ref.name,
                type: ref.type,
                namespace: ref.namespace,
                currentNamespace: ref.currentNamespace,
                preferLocal: ref.preferLocal,
            });
            if (!found) {
                const typeLabel = ref.type.charAt(0).toUpperCase() + ref.type.slice(1);
                const diag = new vscode.Diagnostic(
                    ref.range,
                    `Vuex: ${typeLabel} "${ref.name}" not found in store.`,
                    vscode.DiagnosticSeverity.Warning,
                );
                diag.source = 'Vuex Helper';
                diagnostics.push(diag);
            }
        }

        return diagnostics;
    }

    private collectDuplicateGlobalGetterDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
        const conflicts = this.storeIndexer.getDuplicateGlobalGetterConflicts();
        if (conflicts.length === 0) return [];

        const diagnostics: vscode.Diagnostic[] = [];
        const normalizedFileName = vscode.Uri.file(document.fileName).fsPath;

        for (const conflict of conflicts) {
            const relatedItems = conflict.items.filter((item) =>
                vscode.Uri.file(item.defLocation.uri.fsPath).fsPath === normalizedFileName
            );
            if (relatedItems.length === 0) continue;

            const relatedFiles = conflict.items
                .map((item) => vscode.workspace.asRelativePath(item.defLocation.uri.fsPath))
                .filter((value, index, array) => array.indexOf(value) === index)
                .join(', ');

            for (const item of relatedItems) {
                const diag = new vscode.Diagnostic(
                    this.createDefinitionRange(item.defLocation, item.name),
                    `Vuex: Duplicate global getter "${conflict.name}" detected. Non-namespaced getters share the global namespace. Related definitions: ${relatedFiles}.`,
                    vscode.DiagnosticSeverity.Warning,
                );
                diag.source = 'Vuex Helper';
                diagnostics.push(diag);
            }
        }

        return diagnostics;
    }

    /**
     * 扫描文档中所有可诊断的 Vuex 引用。
     */
    private scanReferences(document: vscode.TextDocument): DiagnosableRef[] {
        const text = document.getText();
        // 对 .vue 文件只扫描 <script> 区域
        const scriptText = this.extractScriptContent(text);
        if (!scriptText) return [];

        const { content, offset: scriptOffset } = scriptText;
        const currentNamespace = this.storeIndexer.getNamespace(document.fileName);
        const currentAssetNamespace = this.storeIndexer.getAssetNamespace(document.fileName) ?? currentNamespace;
        const storeScopeNamespace = currentNamespace ?? currentAssetNamespace;
        const refs: DiagnosableRef[] = [];
        const ast = this.parseScriptAst(content);
        const allowLooseStoreFileFallback =
            storeScopeNamespace !== undefined && !hasExplicitVuexStoreStructure(ast);

        if (ast) {
            this.scanMapHelpersAst(ast, scriptOffset, document, currentNamespace, refs);
            this.scanCommitDispatchAst(ast, scriptOffset, document, currentAssetNamespace, refs, allowLooseStoreFileFallback);
        } else {
            this.scanMapHelpers(content, scriptOffset, document, currentNamespace, refs);
            this.scanCommitDispatch(content, scriptOffset, document, currentAssetNamespace, refs);
        }
        this.scanStoreBracketAccess(content, scriptOffset, document, refs);
        this.scanStoreDotChain(content, scriptOffset, document, refs);
        if (ast) {
            this.scanParamContextAccessAst(
                ast,
                scriptOffset,
                document,
                currentNamespace,
                currentAssetNamespace,
                refs,
                allowLooseStoreFileFallback,
            );
        } else {
            this.scanRootStateGetters(content, scriptOffset, document, refs);
        }

        // store 文件内部的裸 state.xxx / getters.xxx 访问（mutation/getter/action 参数）
        if (currentNamespace !== undefined) {
            if (!ast) {
                this.scanInternalStateAccess(content, scriptOffset, document, currentNamespace, refs);
                if (currentAssetNamespace) {
                    this.scanInternalGettersAccess(content, scriptOffset, document, currentAssetNamespace, refs);
                }
            }
        }

        return refs;
    }

    private parseScriptAst(content: string): t.File | null {
        try {
            return parser.parse(content, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx'],
                errorRecovery: true,
            });
        } catch {
            return null;
        }
    }

    private createDefinitionRange(location: CoreLocation, name: string): vscode.Range {
        const explicitRange = location.range;
        if (explicitRange) {
            return new vscode.Range(
                explicitRange.start.line,
                explicitRange.start.character,
                explicitRange.end.line,
                Math.max(explicitRange.end.character, explicitRange.start.character + Math.max(name.length, 1)),
            );
        }

        return new vscode.Range(0, 0, 0, Math.max(name.length, 1));
    }

    /**
     * 提取 <script> 内容（非 setup），返回内容和在原文中的偏移量。
     * 对 .js/.ts 文件直接返回全文。
     */
    private extractScriptContent(text: string): { content: string; offset: number } | null {
        // 非 .vue 文件直接返回全文
        if (!/<template[\s>]/.test(text)) {
            return { content: text, offset: 0 };
        }
        // 匹配 <script>（排除 <script setup>），只取第一个
        const match = /<script(?![^>]*\bsetup\b)[^>]*>([\s\S]*?)<\/script>/.exec(text);
        if (!match) return null;
        const contentStart = match.index + match[0].indexOf(match[1]);
        return { content: match[1], offset: contentStart };
    }

    /**
     * a) 扫描 mapState/mapGetters/mapMutations/mapActions 中的字符串参数
     */
    private scanMapHelpers(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        currentNamespace: string[] | undefined, refs: DiagnosableRef[],
    ): void {
        // 匹配 mapXxx( 调用
        const helperCallRegex = /\b(mapState|mapGetters|mapMutations|mapActions)\s*\(/g;
        let callMatch: RegExpExecArray | null;

        while ((callMatch = helperCallRegex.exec(content)) !== null) {
            const helperName = callMatch[1];
            const type = HELPER_TYPE_MAP[helperName];
            if (!type) continue;

            const openParen = callMatch.index + callMatch[0].length - 1;
            const callBody = this.extractBalancedParens(content, openParen);
            if (!callBody) continue;

            const bodyStart = openParen + 1;
            const bodyText = callBody.slice(1, -1); // 去掉外层括号

            // 检测命名空间参数：mapState("ns", [...]) 的第一个字符串参数
            let namespace: string | undefined;
            const nsMatch = bodyText.match(/^\s*(['"])([^'"]+)\1\s*,/);
            if (nsMatch) {
                namespace = nsMatch[2];
            }

            // 提取所有字符串字面量（跳过命名空间参数本身和函数语法的值）
            this.extractStringLiteralsFromHelperBody(
                bodyText, bodyStart + scriptOffset, document, type, namespace, currentNamespace, refs,
                nsMatch ? nsMatch[0].length : 0,
            );
        }
    }

    private scanMapHelpersAst(
        ast: t.File,
        scriptOffset: number,
        document: vscode.TextDocument,
        currentNamespace: string[] | undefined,
        refs: DiagnosableRef[],
    ): void {
        traverse(ast, {
            CallExpression: (path) => {
                const callee = path.node.callee;
                if (callee.type !== 'Identifier') return;

                const type = HELPER_TYPE_MAP[callee.name];
                if (!type) return;

                const args = path.node.arguments;
                let namespace: string | undefined;
                let targetArgIndex = 0;

                if (args[0]?.type === 'StringLiteral' && args[0].value) {
                    namespace = args[0].value;
                    targetArgIndex = 1;
                }

                const target = args[targetArgIndex];
                if (!target) return;

                if (target.type === 'ArrayExpression') {
                    for (const element of target.elements) {
                        if (!element || element.type !== 'StringLiteral' || !element.value) continue;
                        this.pushStringRef(
                            refs,
                            element,
                            element.value,
                            type,
                            namespace,
                            currentNamespace,
                            scriptOffset,
                            document,
                        );
                    }
                    return;
                }

                if (target.type !== 'ObjectExpression') return;

                for (const prop of target.properties) {
                    if (prop.type !== 'ObjectProperty') continue;
                    if (prop.value.type !== 'StringLiteral' || !prop.value.value) continue;

                    this.pushStringRef(
                        refs,
                        prop.value,
                        prop.value.value,
                        type,
                        namespace,
                        currentNamespace,
                        scriptOffset,
                        document,
                    );
                }
            },
        });
    }

    /**
     * 从 mapHelper 调用体中提取字符串字面量引用。
     * 跳过命名空间参数、函数值（箭头函数/普通函数）。
     */
    private extractStringLiteralsFromHelperBody(
        bodyText: string, bodyAbsOffset: number, document: vscode.TextDocument,
        type: 'state' | 'getter' | 'mutation' | 'action',
        namespace: string | undefined, currentNamespace: string[] | undefined,
        refs: DiagnosableRef[], nsSkipLen: number,
    ): void {
        // 从命名空间参数之后开始扫描
        const scanText = bodyText.slice(nsSkipLen);
        const scanOffset = bodyAbsOffset + nsSkipLen;

        // 匹配字符串字面量（在数组 [...] 或对象 { key: "value" } 中）
        const stringRegex = /(['"])([^'"]*)\1/g;
        let strMatch: RegExpExecArray | null;

        while ((strMatch = stringRegex.exec(scanText)) !== null) {
            const value = strMatch[2];
            if (!value) continue;

            // 跳过注释行
            const absOffset = scanOffset + strMatch.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // 对象语法 { alias: "storeName" } 中，key（alias）后面跟着 `:`，不诊断
            // 数组项和对象 value 都应诊断
            const afterStr = scanText.slice(strMatch.index + strMatch[0].length).trimStart();
            if (afterStr.startsWith(':')) continue;

            // 计算字符串内容的 range（不含引号）
            const valueStart = absOffset + 1; // 跳过开头引号
            const startPos = document.positionAt(valueStart);
            const endPos = document.positionAt(valueStart + value.length);
            const range = new vscode.Range(startPos, endPos);

            // 处理带 / 的路径（如 "user/name"）
            let refName = value;
            let refNamespace = namespace;
            if (value.includes('/')) {
                const parts = value.split('/');
                refName = parts.pop()!;
                const pathNs = parts.join('/');
                refNamespace = refNamespace ? `${refNamespace}/${pathNs}` : pathNs;
            }

            refs.push({ name: refName, type, namespace: refNamespace, range, currentNamespace });
        }
    }

    /**
     * b) 扫描 commit("xxx") / dispatch("xxx") 字符串参数
     */
    private scanCommitDispatch(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        currentNamespace: string[] | undefined, refs: DiagnosableRef[],
    ): void {
        // 匹配 commit("xxx") 和 dispatch("xxx")，包括 $store.commit、store.commit、裸 commit
        const pattern = /\b(commit|dispatch)\s*\(\s*(['"])([^'"]*)\2/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(content)) !== null) {
            const method = match[1] as 'commit' | 'dispatch';
            const value = match[3];
            if (!value) continue;

            if (!this.isLikelyVuexMethodCall(content, match.index, currentNamespace)) continue;

            const type: 'mutation' | 'action' = method === 'commit' ? 'mutation' : 'action';

            // 跳过注释行
            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // 字符串内容的 range
            const quoteOffset = match[0].indexOf(match[2]);
            const valueStart = scriptOffset + match.index + quoteOffset + 1;
            const startPos = document.positionAt(valueStart);
            const endPos = document.positionAt(valueStart + value.length);
            const range = new vscode.Range(startPos, endPos);

            // 检测是否是 $store.commit / store.commit（非本模块上下文）
            const beforeCall = content.slice(Math.max(0, match.index - 50), match.index);
            const isStoreMethod = /\$store(?:\?\.)?\s*$/.test(beforeCall) ||
                /\b\w+(?:\?\.)?\s*$/.test(beforeCall) && /\.(?:commit|dispatch)\s*$/.test(beforeCall.trimEnd());
            const preferLocal = !isStoreMethod;

            // 处理带 / 的路径
            let refName = value;
            let refNamespace: string | undefined;
            if (value.includes('/')) {
                const parts = value.split('/');
                refName = parts.pop()!;
                refNamespace = parts.join('/');
            }

            refs.push({
                name: refName, type, namespace: refNamespace, range,
                preferLocal, currentNamespace,
            });
        }
    }

    private scanCommitDispatchAst(
        ast: t.File,
        scriptOffset: number,
        document: vscode.TextDocument,
        currentNamespace: string[] | undefined,
        refs: DiagnosableRef[],
        allowLooseStoreFileFallback: boolean,
    ): void {
        const visitCall = (path: any) => {
            const callee = path.node.callee;
            let method: 'commit' | 'dispatch' | undefined;
            let preferLocal = false;

            if (callee.type === 'Identifier' && (callee.name === 'commit' || callee.name === 'dispatch')) {
                const resolvedMethod = this.resolveVuexMethodBinding(
                    path.scope.getBinding(callee.name),
                    callee.name,
                    currentNamespace,
                    allowLooseStoreFileFallback,
                );
                if (!resolvedMethod) return;
                method = resolvedMethod;
                preferLocal = true;
            } else if (this.isStoreMethodCallee(callee)) {
                method = (callee.property as t.Identifier).name as 'commit' | 'dispatch';
                preferLocal = false;
            } else if (
                currentNamespace !== undefined &&
                (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
                !callee.computed &&
                callee.object.type === 'Identifier' &&
                callee.property.type === 'Identifier' &&
                (callee.property.name === 'commit' || callee.property.name === 'dispatch')
            ) {
                const binding = path.scope.getBinding(callee.object.name);
                if (!isLikelyVuexContextBinding(binding, currentNamespace, allowLooseStoreFileFallback)) return;
                method = callee.property.name;
                preferLocal = true;
            }

            if (!method) return;

            const firstArg = path.node.arguments?.[0];
            if (!firstArg || firstArg.type !== 'StringLiteral' || !firstArg.value) return;

            const type: 'mutation' | 'action' = method === 'commit' ? 'mutation' : 'action';
            let refName = firstArg.value;
            let refNamespace: string | undefined;
            if (refName.includes('/')) {
                const parts = refName.split('/');
                refName = parts.pop()!;
                refNamespace = parts.join('/');
            }

            refs.push({
                name: refName,
                type,
                namespace: refNamespace,
                range: this.createStringLiteralRange(firstArg, scriptOffset, document),
                preferLocal,
                currentNamespace,
            });
        };

        traverse(ast, {
            CallExpression: visitCall,
            OptionalCallExpression: visitCall,
        } as any);
    }

    private scanParamContextAccessAst(
        ast: t.File,
        scriptOffset: number,
        document: vscode.TextDocument,
        currentNamespace: string[] | undefined,
        currentAssetNamespace: string[] | undefined,
        refs: DiagnosableRef[],
        allowLooseStoreFileFallback: boolean,
    ): void {
        const storeScopeNamespace = currentNamespace ?? currentAssetNamespace;
        const getIdentifierChain = (node: t.Node | null | undefined): string[] | undefined => {
            if (!node) return undefined;
            if (node.type === 'Identifier') {
                return [node.name];
            }
            if (
                (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
                !node.computed &&
                node.property.type === 'Identifier'
            ) {
                const parent = getIdentifierChain(node.object as t.Node);
                if (!parent) return undefined;
                return [...parent, node.property.name];
            }
            return undefined;
        };

        const pushRef = (
            rawName: string,
            type: 'state' | 'getter',
            node: { start?: number | null; end?: number | null },
            preferLocal: boolean,
            targetCurrentNamespace: string[] | undefined,
        ) => {
            let name = rawName;
            let namespace: string | undefined;
            if (type !== 'state' && rawName.includes('/')) {
                const parts = rawName.split('/');
                name = parts.pop()!;
                namespace = parts.join('/');
            }

            refs.push({
                name,
                type,
                namespace,
                range: this.createNodeRange(node, scriptOffset, document),
                currentNamespace: targetCurrentNamespace,
                preferLocal,
            });
        };

        const visitMember = (path: any) => {
            const node = path.node as t.MemberExpression | t.OptionalMemberExpression;
            const parentNode = path.parentPath?.node;
            if (
                parentNode &&
                (parentNode.type === 'MemberExpression' || parentNode.type === 'OptionalMemberExpression') &&
                parentNode.object === node
            ) {
                return;
            }
            const objectChain = getIdentifierChain(node.object as t.Node);
            if (!objectChain) return;

            if (node.computed) {
                if (node.property.type !== 'StringLiteral' || !node.property.value) return;
                const binding = path.scope.getBinding(objectChain[0]);

                if (
                    (objectChain[0] === 'rootState' || objectChain[0] === 'rootGetters') &&
                    isLikelyVuexSpecialParamBinding(
                        binding,
                        objectChain[0],
                        storeScopeNamespace,
                        allowLooseStoreFileFallback,
                    )
                ) {
                    pushRef(
                        node.property.value,
                        objectChain[0] === 'rootState' ? 'state' : 'getter',
                        node.property,
                        false,
                        undefined,
                    );
                    return;
                }

                if (objectChain.length >= 2) {
                    const keyword = objectChain[1];
                    if (
                        (keyword === 'rootState' || keyword === 'rootGetters') &&
                        isLikelyVuexContextBinding(binding, storeScopeNamespace, allowLooseStoreFileFallback)
                    ) {
                        pushRef(
                            node.property.value,
                            keyword === 'rootState' ? 'state' : 'getter',
                            node.property,
                            false,
                            undefined,
                        );
                    }
                }
                return;
            }

            if (node.property.type !== 'Identifier') return;

            const binding = path.scope.getBinding(objectChain[0]);

            const directKeyword = objectChain[0];
            if (
                (directKeyword === 'state' || directKeyword === 'getters') &&
                objectChain.length === 1 &&
                isLikelyVuexSpecialParamBinding(
                    binding,
                    directKeyword,
                    storeScopeNamespace,
                    allowLooseStoreFileFallback,
                )
            ) {
                const targetNamespace = directKeyword === 'state' ? currentNamespace : currentAssetNamespace;
                if (targetNamespace === undefined) return;
                pushRef(node.property.name, directKeyword === 'state' ? 'state' : 'getter', node.property, true, targetNamespace);
                return;
            }

            if (
                (directKeyword === 'rootState' || directKeyword === 'rootGetters') &&
                objectChain.length === 1 &&
                isLikelyVuexSpecialParamBinding(
                    binding,
                    directKeyword,
                    storeScopeNamespace,
                    allowLooseStoreFileFallback,
                )
            ) {
                pushRef(node.property.name, directKeyword === 'rootState' ? 'state' : 'getter', node.property, false, undefined);
                return;
            }

            if (objectChain.length < 2 || storeScopeNamespace === undefined) return;

            const keyword = objectChain[1];
            if (
                (keyword === 'state' || keyword === 'getters') &&
                objectChain.length === 2 &&
                isLikelyVuexContextBinding(binding, storeScopeNamespace, allowLooseStoreFileFallback)
            ) {
                const targetNamespace = keyword === 'state' ? currentNamespace : currentAssetNamespace;
                if (targetNamespace === undefined) return;
                pushRef(node.property.name, keyword === 'state' ? 'state' : 'getter', node.property, true, targetNamespace);
                return;
            }

            if (
                (keyword === 'rootState' || keyword === 'rootGetters') &&
                objectChain.length === 2 &&
                isLikelyVuexContextBinding(binding, storeScopeNamespace, allowLooseStoreFileFallback)
            ) {
                pushRef(node.property.name, keyword === 'rootState' ? 'state' : 'getter', node.property, false, undefined);
            }
        };

        traverse(ast, {
            MemberExpression: visitMember,
            OptionalMemberExpression: visitMember,
        } as any);
    }

    /**
     * c) 扫描 $store.state['xxx'] / $store.getters['xxx'] 方括号访问
     */
    private scanStoreBracketAccess(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        refs: DiagnosableRef[],
    ): void {
        // 匹配 $store.state['xxx'] 和 $store.getters['xxx']（含可选链）
        const pattern = /\$store(?:\?\.)?\.(state|getters)(?:\?\.)?\[(['"])([^'"]*)\2\]/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(content)) !== null) {
            const accessor = match[1];
            const value = match[3];
            if (!value) continue;

            const type: 'state' | 'getter' = accessor === 'state' ? 'state' : 'getter';

            // 跳过注释行
            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // 字符串内容的 range
            const bracketIdx = match[0].indexOf('[');
            const valueStart = scriptOffset + match.index + bracketIdx + 2; // [' 后
            const startPos = document.positionAt(valueStart);
            const endPos = document.positionAt(valueStart + value.length);
            const range = new vscode.Range(startPos, endPos);

            // 处理带 / 的路径
            let refName = value;
            let refNamespace: string | undefined;
            if (value.includes('/')) {
                const parts = value.split('/');
                refName = parts.pop()!;
                refNamespace = parts.join('/');
            }

            refs.push({ name: refName, type, namespace: refNamespace, range });
        }
    }

    /**
     * d) 扫描 $store.state.xxx / $store.getters.xxx 点号链访问
     * 只诊断第一层属性（如 state.count），第二层及以上跳过——
     * 无法区分中间段是 Vuex 模块还是普通对象，不冒误报风险。
     */
    private scanStoreDotChain(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        refs: DiagnosableRef[],
    ): void {
        // 匹配 $store.state.xxx 或 $store.getters.xxx（含可选链，至少一层属性）
        const pattern = /\$store(?:\?\.)?\.(state|getters)(?:\?\.|\.)([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(content)) !== null) {
            const accessor = match[1];
            const chainStr = match[2];
            if (!chainStr) continue;

            // 只诊断第一层
            const segments = chainStr.replace(/\?\./g, '.').replace(/\?/g, '').split('.');
            if (segments.length !== 1) continue;

            const type: 'state' | 'getter' = accessor === 'state' ? 'state' : 'getter';
            const name = segments[0];

            // 跳过注释行
            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // name 在原文中的位置
            const nameIdx = match[0].lastIndexOf(name);
            const nameStart = scriptOffset + match.index + nameIdx;
            const startPos = document.positionAt(nameStart);
            const endPos = document.positionAt(nameStart + name.length);
            const range = new vscode.Range(startPos, endPos);

            refs.push({ name, type, range });
        }
    }

    /**
     * e) 扫描 rootState/rootGetters 的点号链和方括号访问（store 内部引用）
     * 点号链只诊断第一层，与 scanStoreDotChain 同理。
     * 仅匹配独立的 rootState/rootGetters（排除 context.rootState 等成员访问）。
     */
    private scanRootStateGetters(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        refs: DiagnosableRef[],
    ): void {
        // 点号链: rootState.xxx / rootGetters.xxx（排除 `.rootState` 成员访问）
        const dotPattern = /(?<!\.)\b(rootState|rootGetters)(?:\?\.|\.)([A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*)/g;
        let match: RegExpExecArray | null;

        while ((match = dotPattern.exec(content)) !== null) {
            const keyword = match[1];
            const chainStr = match[2];
            if (!chainStr) continue;

            // 只诊断第一层
            const segments = chainStr.replace(/\?\./g, '.').replace(/\?/g, '').split('.');
            if (segments.length !== 1) continue;

            const type: 'state' | 'getter' = keyword === 'rootState' ? 'state' : 'getter';
            const name = segments[0];

            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            const nameIdx = match[0].lastIndexOf(name);
            const nameStart = scriptOffset + match.index + nameIdx;
            const startPos = document.positionAt(nameStart);
            const endPos = document.positionAt(nameStart + name.length);
            const range = new vscode.Range(startPos, endPos);

            refs.push({ name, type, range });
        }

        // 方括号: rootState['xxx'] / rootGetters['xxx']
        const bracketPattern = /(?<!\.)\b(rootState|rootGetters)(?:\?\.)?\[(['"])([^'"]*)\2\]/g;

        while ((match = bracketPattern.exec(content)) !== null) {
            const keyword = match[1];
            const value = match[3];
            if (!value) continue;

            const type: 'state' | 'getter' = keyword === 'rootState' ? 'state' : 'getter';

            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            const bracketIdx = match[0].indexOf('[');
            const valueStart = scriptOffset + match.index + bracketIdx + 2;
            const startPos = document.positionAt(valueStart);
            const endPos = document.positionAt(valueStart + value.length);
            const range = new vscode.Range(startPos, endPos);

            let refName = value;
            let refNamespace: string | undefined;
            if (value.includes('/')) {
                const parts = value.split('/');
                refName = parts.pop()!;
                refNamespace = parts.join('/');
            }

            refs.push({ name: refName, type, namespace: refNamespace, range });
        }
    }

    /**
     * f) 扫描 store 文件内部裸 state.xxx 访问（mutation/getter/action 参数中的 state）
     * 只诊断第一层，排除 $store.state / rootState 等已由其他方法处理的模式。
     */
    private scanInternalStateAccess(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        currentNamespace: string[], refs: DiagnosableRef[],
    ): void {
        // 匹配独立的 state.xxx（排除 .state / $store.state / rootState）
        const pattern = /(?<!\.|root)\bstate(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(content)) !== null) {
            const name = match[1];

            // 跳过注释行
            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // name 在原文中的位置
            const nameIdx = match[0].lastIndexOf(name);
            const nameStart = scriptOffset + match.index + nameIdx;
            const startPos = document.positionAt(nameStart);
            const endPos = document.positionAt(nameStart + name.length);
            const range = new vscode.Range(startPos, endPos);

            refs.push({
                name, type: 'state', range,
                currentNamespace, preferLocal: true,
            });
        }
    }

    private scanInternalStateAccessAst(
        ast: t.File,
        scriptOffset: number,
        document: vscode.TextDocument,
        currentNamespace: string[],
        refs: DiagnosableRef[],
    ): void {
        const visitMember = (path: any) => {
            const node = path.node;
            if (node.computed) return;
            if (node.object.type !== 'Identifier' || node.object.name !== 'state') return;
            if (node.property.type !== 'Identifier') return;

            const binding = path.scope.getBinding('state');
            if (!binding || binding.kind !== 'param') return;

            refs.push({
                name: node.property.name,
                type: 'state',
                range: this.createNodeRange(node.property, scriptOffset, document),
                currentNamespace,
                preferLocal: true,
            });
        };

        traverse(ast, {
            MemberExpression: visitMember,
            OptionalMemberExpression: visitMember,
        } as any);
    }

    /**
     * g) 扫描 store 文件内部裸 getters.xxx 访问（getter/action 参数中的 getters）
     * 排除 rootGetters 和 .getters（如 $store.getters）已由其他方法处理的模式。
     */
    private scanInternalGettersAccess(
        content: string, scriptOffset: number, document: vscode.TextDocument,
        currentNamespace: string[], refs: DiagnosableRef[],
    ): void {
        const pattern = /(?<!\.|root)\bgetters(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(content)) !== null) {
            const name = match[1];

            const absOffset = scriptOffset + match.index;
            const pos = document.positionAt(absOffset);
            const lineText = document.lineAt(pos.line).text;
            const trimmed = lineText.trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            const nameIdx = match[0].lastIndexOf(name);
            const nameStart = scriptOffset + match.index + nameIdx;
            const startPos = document.positionAt(nameStart);
            const endPos = document.positionAt(nameStart + name.length);
            const range = new vscode.Range(startPos, endPos);

            refs.push({
                name, type: 'getter', range,
                currentNamespace, preferLocal: true,
            });
        }
    }

    private scanInternalGettersAccessAst(
        ast: t.File,
        scriptOffset: number,
        document: vscode.TextDocument,
        currentNamespace: string[],
        refs: DiagnosableRef[],
    ): void {
        const visitMember = (path: any) => {
            const node = path.node;
            if (node.computed) return;
            if (node.object.type !== 'Identifier' || node.object.name !== 'getters') return;
            if (node.property.type !== 'Identifier') return;

            const binding = path.scope.getBinding('getters');
            if (!binding || binding.kind !== 'param') return;

            refs.push({
                name: node.property.name,
                type: 'getter',
                range: this.createNodeRange(node.property, scriptOffset, document),
                currentNamespace,
                preferLocal: true,
            });
        };

        traverse(ast, {
            MemberExpression: visitMember,
            OptionalMemberExpression: visitMember,
        } as any);
    }

    private pushStringRef(
        refs: DiagnosableRef[],
        literal: t.StringLiteral,
        rawValue: string,
        type: 'state' | 'getter' | 'mutation' | 'action',
        namespace: string | undefined,
        currentNamespace: string[] | undefined,
        scriptOffset: number,
        document: vscode.TextDocument,
    ): void {
        let refName = rawValue;
        let refNamespace = namespace;
        if (rawValue.includes('/')) {
            const parts = rawValue.split('/');
            refName = parts.pop()!;
            const pathNs = parts.join('/');
            refNamespace = refNamespace ? `${refNamespace}/${pathNs}` : pathNs;
        }

        refs.push({
            name: refName,
            type,
            namespace: refNamespace,
            range: this.createStringLiteralRange(literal, scriptOffset, document),
            currentNamespace,
        });
    }

    private createStringLiteralRange(
        literal: t.StringLiteral,
        scriptOffset: number,
        document: vscode.TextDocument,
    ): vscode.Range {
        const start = (literal.start ?? 0) + scriptOffset + 1;
        const end = (literal.end ?? start) + scriptOffset - 1;
        return new vscode.Range(document.positionAt(start), document.positionAt(end));
    }

    private createNodeRange(
        node: { start?: number | null; end?: number | null },
        scriptOffset: number,
        document: vscode.TextDocument,
    ): vscode.Range {
        const start = (node.start ?? 0) + scriptOffset;
        const end = (node.end ?? start) + scriptOffset;
        return new vscode.Range(document.positionAt(start), document.positionAt(end));
    }

    private resolveVuexMethodBinding(
        binding: any,
        expectedMethod: 'commit' | 'dispatch',
        currentNamespace: string[] | undefined,
        allowLooseStoreFileFallback: boolean,
        seen: Set<any> = new Set(),
    ): 'commit' | 'dispatch' | undefined {
        if (!binding || seen.has(binding)) return undefined;
        seen.add(binding);

        if (binding.kind === 'param' || binding.path?.node?.type === 'ObjectProperty') {
            return isLikelyVuexSpecialParamBinding(
                binding,
                expectedMethod,
                currentNamespace,
                allowLooseStoreFileFallback,
            )
                ? expectedMethod
                : undefined;
        }

        const declarator = binding.path?.node;
        if (!declarator || declarator.type !== 'VariableDeclarator' || !declarator.init) {
            return undefined;
        }

        const init = declarator.init;
        if (init.type === 'Identifier') {
            return this.resolveVuexMethodBinding(
                binding.path.scope.getBinding(init.name),
                expectedMethod,
                currentNamespace,
                allowLooseStoreFileFallback,
                seen,
            );
        }

        if (
            (init.type === 'MemberExpression' || init.type === 'OptionalMemberExpression') &&
            !init.computed &&
            init.property.type === 'Identifier' &&
            init.property.name === expectedMethod &&
            init.object.type === 'Identifier'
        ) {
            const sourceBinding = binding.path.scope.getBinding(init.object.name);
            if (isLikelyVuexContextBinding(sourceBinding, currentNamespace, allowLooseStoreFileFallback)) {
                return expectedMethod;
            }
        }

        return undefined;
    }

    private isStoreMethodCallee(callee: any): callee is t.MemberExpression | t.OptionalMemberExpression {
        if (!callee || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) {
            return false;
        }
        if (callee.computed || callee.property.type !== 'Identifier') return false;
        if (callee.property.name !== 'commit' && callee.property.name !== 'dispatch') return false;
        return this.isDollarStoreAccess(callee.object);
    }

    private isDollarStoreAccess(node: any): boolean {
        if (!node) return false;
        if (node.type === 'Identifier') return node.name === '$store';
        if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
        if (node.computed || node.property.type !== 'Identifier') return false;
        if (node.property.name !== '$store') return false;
        return node.object.type === 'ThisExpression';
    }

    private isLikelyVuexMethodCall(
        content: string,
        callIndex: number,
        currentNamespace: string[] | undefined,
    ): boolean {
        const beforeCall = content.slice(Math.max(0, callIndex - 80), callIndex).trimEnd();
        if (/\$store(?:\?\.)?\.$/.test(beforeCall)) return true;
        if (/\bstore(?:\?\.)?\.$/.test(beforeCall)) return true;
        if (/(?:\?\.|\.)$/.test(beforeCall)) return false;
        return currentNamespace !== undefined;
    }

    /**
     * 从指定位置提取括号配对的内容（含外层括号）。
     */
    private extractBalancedParens(text: string, openIdx: number): string | null {
        if (text[openIdx] !== '(') return null;
        let depth = 1;
        let i = openIdx + 1;
        let inString: string | false = false;
        while (i < text.length && depth > 0) {
            const ch = text[i];
            if (inString) {
                if (ch === inString && text[i - 1] !== '\\') inString = false;
            } else {
                if (ch === '\x27' || ch === '\x22' || ch === '\x60') inString = ch;
                else if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
            i++;
        }
        if (depth !== 0) return null;
        return text.slice(openIdx, i);
    }
}
