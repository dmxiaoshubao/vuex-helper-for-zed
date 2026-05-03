import * as vscode from 'vscode';
import * as path from 'path';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import type * as t from '@babel/types';
import { PathResolver } from './PathResolver';

export type VuexItemType = 'state' | 'getter' | 'mutation' | 'action';
export type VuexMappedItemType = 'state' | 'getter' | 'mutation' | 'action';

export interface VuexMappedInfo {
    type: VuexMappedItemType;
    originalName: string;
    namespace?: string;
}

export interface StringLiteralAtPosition {
    path: string;
    range: vscode.Range;
}

interface StoreImportCandidate {
    localName: string;
    source: string;
}

type VuexHandlerSection = 'actions' | 'getters' | 'mutations';

interface ProviderScriptAnalysis {
    text: string;
    version: number | undefined;
    script: { content: string; offset: number } | null;
    ast: t.File | null;
    probeCache: Map<string, ProviderScriptProbe | null>;
    scopePathCache: Map<number, any | null>;
    hasExplicitStoreStructure?: boolean;
}

interface ProviderScriptProbe {
    ast: t.File | null;
    localOffset: number;
    placeholder: string;
}

const providerScriptAnalysisCache = new WeakMap<object, ProviderScriptAnalysis>();
const explicitStoreStructureCache = new WeakMap<t.File, boolean>();
const VUEX_STORE_SHAPE_KEYS = new Set(['state', 'getters', 'mutations', 'actions', 'modules']);

/**
 * 三个 Provider（Completion / Definition / Hover）共用的工具函数。
 * 提取自各 Provider 中完全重复的私有方法，统一维护。
 */

/** 从 rawPrefix 中提取 state.xxx 访问路径 */
export function extractStateAccessPath(rawPrefix: string, word: string): string | undefined {
    const match = rawPrefix.match(/\bstate(?:\?\.|\.)([A-Za-z0-9_$\.?]*)$/);
    if (!match) return undefined;
    const left = (match[1] || '').replace(/\?\./g, '.').replace(/\?/g, '');
    if (!left) return word;
    return `${left}${word}`;
}

/** rootState.xxx / rootGetters.xxx 的路径提取 */
export function extractRootAccessPath(rawPrefix: string, word: string, keyword: 'rootState' | 'rootGetters'): string | undefined {
    const pattern = new RegExp(`\\b${keyword}(?:\\?\\.|\\.)([A-Za-z0-9_$\\.?]*)$`);
    const match = rawPrefix.match(pattern);
    if (!match) return undefined;
    const left = (match[1] || '').replace(/\?\./g, '.').replace(/\?/g, '');
    if (!left) return word;
    return `${left}${word}`;
}

/** 从 rawPrefix 中提取 context.state.xxx / ctx.rootState.xxx 这类路径 */
export function extractContextAccessPath(
    rawPrefix: string,
    word: string,
    keyword: 'state' | 'getters' | 'rootState' | 'rootGetters'
): string | undefined {
    const pattern = new RegExp(
        `\\b[A-Za-z_$][\\w$]*(?:\\?\\.|\\.)${keyword}(?:\\?\\.|\\.)([A-Za-z0-9_$\\.?]*)$`
    );
    const match = rawPrefix.match(pattern);
    if (!match) return undefined;
    const left = (match[1] || '').replace(/\?\./g, '.').replace(/\?/g, '');
    if (!left) return word;
    return `${left}${word}`;
}

/** rootGetters['xxx'] 方括号语法路径提取 */
export function extractBracketPath(rawPrefix: string, keyword: string): string | undefined {
    const pattern = new RegExp(`\\b${keyword}(?:\\?\\.)?\\[['"]([^'"]*)$`);
    const match = rawPrefix.match(pattern);
    if (!match) return undefined;
    return match[1] || '';
}

/** 从光标位置提取字符串字面量路径（支持 'a/b'） */
export function extractStringLiteralPathAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): StringLiteralAtPosition | undefined {
    const lineText = document.lineAt(position.line).text;
    const cursor = position.character;
    const quoteChars = [`'`, `"`, '`'];

    let start = -1;
    let quoteChar = '';
    for (let i = cursor; i >= 0; i--) {
        const ch = lineText.charAt(i);
        if (quoteChars.includes(ch)) {
            start = i;
            quoteChar = ch;
            break;
        }
    }
    if (start < 0 || !quoteChar) return undefined;

    let end = -1;
    for (let i = start + 1; i < lineText.length; i++) {
        if (lineText.charAt(i) === quoteChar && lineText.charAt(i - 1) !== '\\') {
            end = i;
            break;
        }
    }
    if (end < 0) return undefined;

    if (cursor <= start || cursor > end) return undefined;
    return {
        path: lineText.substring(start + 1, end).trim(),
        range: new vscode.Range(position.line, start, position.line, end + 1),
    };
}

/** 检测字符串前缀是否是 store getter/state 方括号访问 */
export function detectStoreBracketAccessor(
    textBefore: string,
    currentNamespace?: string[],
    storeLikeNames: readonly string[] = [],
): 'getter' | 'state' | undefined {
    const normalized = textBefore.replace(/\?\./g, '.');

    if (/\brootGetters\.?\s*\[$/.test(normalized)) return 'getter';
    if (/\brootState\.?\s*\[$/.test(normalized)) return 'state';

    const storeMatch = normalized.match(/\$store\.(getters|state)\.?\s*\[$/);
    if (storeMatch) {
        return storeMatch[1] === 'getters' ? 'getter' : 'state';
    }

    for (const storeLikeName of storeLikeNames) {
        const escaped = escapeRegex(storeLikeName);
        const directStorePattern = new RegExp(
            `(?:^|[^\\w$.])${escaped}\\.(getters|state)\\.?\\s*\\[$`
        );
        const directStoreMatch = normalized.match(directStorePattern);
        if (directStoreMatch) {
            return directStoreMatch[1] === 'getters' ? 'getter' : 'state';
        }
    }

    if (currentNamespace && /(?:^|[\s,(\[{;:=])getters\.?\s*\[$/.test(normalized)) {
        return 'getter';
    }
    if (currentNamespace && /(?:^|[\s,(\[{;:=])state\.?\s*\[$/.test(normalized)) {
        return 'state';
    }

    return undefined;
}

/** 提取 this.$store.state/getters 链式访问路径（支持可选链） */
export function extractStoreAccessPath(
    rawPrefix: string,
    word: string,
    storeLikeNames: readonly string[] = []
): { type: 'state' | 'getter'; accessPath: string } | undefined {
    const match = rawPrefix.match(/\$store(?:\?\.|\.)((?:state|getters))(?:\?\.|\.)([A-Za-z0-9_$.?]*)$/);
    if (match) {
        const accessType = match[1] === 'state' ? 'state' : 'getter';
        const leftPath = (match[2] || '').replace(/\?\./g, '.').replace(/\?/g, '');
        const accessPath = leftPath ? `${leftPath}${word}` : word;
        return { type: accessType, accessPath };
    }

    for (const storeLikeName of storeLikeNames) {
        const escaped = escapeRegex(storeLikeName);
        const pattern = new RegExp(
            `(?:^|[^\\w$.])${escaped}(?:\\?\\.|\\.)((?:state|getters))(?:\\?\\.|\\.)([A-Za-z0-9_$.?]*)$`
        );
        const directMatch = rawPrefix.match(pattern);
        if (!directMatch) continue;

        const accessType = directMatch[1] === 'state' ? 'state' : 'getter';
        const leftPath = (directMatch[2] || '').replace(/\?\./g, '.').replace(/\?/g, '');
        const accessPath = leftPath ? `${leftPath}${word}` : word;
        return { type: accessType, accessPath };
    }

    return undefined;
}

/**
 * 从文档中识别“导入的 store 实例变量名”，并通过 PathResolver + 已索引 store entry 进行校验。
 * 例如：import store from '@/store' / const s = require('@/store').default
 */
export async function collectStoreLikeNames(
    document: vscode.TextDocument,
    pathResolver: PathResolver,
    storeEntryPath?: string | null,
): Promise<string[]> {
    const sourceText = document.getText();
    if (!sourceText) return [];

    const candidates = collectStoreImportCandidates(sourceText);
    if (candidates.length === 0) return [];

    const resolvedCandidates = await Promise.all(
        candidates.map(async (candidate) => {
            const resolved = await pathResolver.resolve(candidate.source, document.fileName);
            return { candidate, resolved };
        })
    );

    const unique = new Set<string>();
    for (const { candidate, resolved } of resolvedCandidates) {
        if (!resolved) continue;
        if (!isStoreImportTarget(resolved, storeEntryPath)) continue;
        unique.add(candidate.localName);
    }
    return Array.from(unique);
}

function collectStoreImportCandidates(sourceText: string): StoreImportCandidate[] {
    const candidates: StoreImportCandidate[] = [];
    const pushMatch = (localName: string, source: string) => {
        if (!localName || !source) return;
        candidates.push({ localName, source });
    };

    const defaultImportRegex = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
    for (const match of sourceText.matchAll(defaultImportRegex)) {
        pushMatch(match[1], match[2]);
    }

    const namespaceImportRegex = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
    for (const match of sourceText.matchAll(namespaceImportRegex)) {
        pushMatch(match[1], match[2]);
    }

    const defaultAliasImportRegex = /\bimport\s*\{\s*default\s+as\s+([A-Za-z_$][\w$]*)[^}]*\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const match of sourceText.matchAll(defaultAliasImportRegex)) {
        pushMatch(match[1], match[2]);
    }

    const requireAssignRegex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.\s*default)?/g;
    for (const match of sourceText.matchAll(requireAssignRegex)) {
        pushMatch(match[1], match[2]);
    }

    const requireDefaultDestructureRegex = /\b(?:const|let|var)\s*\{\s*default\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of sourceText.matchAll(requireDefaultDestructureRegex)) {
        pushMatch(match[1], match[2]);
    }

    return candidates;
}

function isStoreImportTarget(resolvedPath: string, storeEntryPath?: string | null): boolean {
    const normalizedResolved = path.normalize(vscode.Uri.file(resolvedPath).fsPath);
    if (storeEntryPath) {
        const normalizedEntry = path.normalize(vscode.Uri.file(storeEntryPath).fsPath);
        if (normalizedResolved === normalizedEntry) {
            return true;
        }
    }

    return /(^|[\\/])store([\\/](index\.(js|ts|mjs|cjs|vue)))?$/.test(normalizedResolved);
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断 suffix 是否表示链式属性继续（.foo 或 ?.foo） */
export function hasChainedPropertySuffix(rawSuffix: string): boolean {
    return /^(?:\?\.|\.)([A-Za-z0-9_$\.]+)/.test(rawSuffix);
}

/** 解析 this['a/b'] / vm['a/b'] 或 this.foo 场景下的映射项 */
export function resolveMappedItem(
    mapping: Record<string, VuexMappedInfo>,
    rawPrefix: string,
    word: string
): VuexMappedInfo | undefined {
    const direct = mapping[word];
    if (direct) {
        const normalizedPrefix = rawPrefix.replace(/\?\./g, '.').trimEnd();
        if (
            !normalizedPrefix.endsWith('.') ||
            /\b(?:this|vm)\.$/.test(normalizedPrefix)
        ) {
            return direct;
        }
    }

    const bracketMappedPathPrefix = extractBracketPath(rawPrefix, 'this') ?? extractBracketPath(rawPrefix, 'vm');
    if (!bracketMappedPathPrefix) return undefined;

    const fullMappedKey = `${bracketMappedPathPrefix}${word}`;
    return mapping[fullMappedKey];
}

/** 构建查找候选项，统一处理命名空间和点号路径 */
export function buildLookupCandidates(
    name: string,
    type: VuexItemType,
    namespace?: string,
    currentNamespace?: string[]
): Array<{ name: string; namespace?: string }> {
    let normalizedName = name.trim();
    let normalizedNamespace = namespace?.trim();

    const absorbSlashPath = () => {
        if (!normalizedName.includes('/')) return;
        const parts = normalizedName.split('/');
        const last = parts.pop();
        if (!last) return;
        const pathNs = parts.join('/');
        normalizedName = last;
        normalizedNamespace = normalizedNamespace
            ? `${normalizedNamespace}/${pathNs}`
            : pathNs;
    };

    if (type === 'state') {
        absorbSlashPath();
        if (normalizedName.includes('.')) {
            const parts = normalizedName.split('.').filter(Boolean);
            const leaf = parts.pop();
            if (leaf) {
                normalizedName = leaf;
                const dottedNs = parts.join('/');
                if (dottedNs) {
                    normalizedNamespace = normalizedNamespace
                        ? `${normalizedNamespace}/${dottedNs}`
                        : currentNamespace && currentNamespace.length > 0
                            ? `${currentNamespace.join('/')}/${dottedNs}`
                            : dottedNs;
                }
            }
        }
    } else if (!normalizedNamespace) {
        absorbSlashPath();
    }

    return [{ name: normalizedName, namespace: normalizedNamespace }];
}

/**
 * 精确检测光标所在的 commit/dispatch 调用是否携带 { root: true } 选项。
 * 通过括号配对提取当前调用体，避免误匹配同函数内其他调用。
 */
export function hasRootTrueOption(
    document: vscode.TextDocument,
    position: vscode.Position,
    method: 'commit' | 'dispatch',
    calleeName?: string,
): boolean {
    const MAX_SCAN_WINDOW = 5000;
    const offset = document.offsetAt(position);
    const hasRangeApi =
        typeof (document as any).positionAt === 'function' &&
        typeof (document as any).lineCount === 'number';

    let source: string;
    let localOffset: number;
    if (hasRangeApi) {
        const startOffset = Math.max(0, offset - MAX_SCAN_WINDOW);
        const lastLine = document.lineAt(document.lineCount - 1);
        const documentEndOffset = document.offsetAt(new vscode.Position(document.lineCount - 1, lastLine.text.length));
        const endOffset = Math.min(documentEndOffset, offset + MAX_SCAN_WINDOW);
        source = document.getText(
            new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset),
            ),
        );
        localOffset = offset - startOffset;
    } else {
        // Unit-test fallback where mock TextDocument may only implement getText()/offsetAt.
        source = document.getText();
        localOffset = offset;
    }
    const callName = (calleeName || method).trim();

    // 精确提取光标所在的那个 commit/dispatch 调用体
    const callBody = extractCurrentCallBody(source, localOffset, callName);
    if (!callBody) return false;

    // 1. 直接在调用体内检测 { root: true }
    if (/\broot\s*:\s*true\b/.test(callBody)) {
        return true;
    }

    // 2. 检测第三个参数是标识符引用（如 opts），再在附近查找该变量的定义
    const thirdArgMatch = callBody.match(
        /,\s*([A-Za-z_$][\w$]*)\s*\)?\s*$/,
    );
    if (!thirdArgMatch) return false;

    const id = thirdArgMatch[1];
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localWindowStart = Math.max(0, localOffset - 2000);
    const localWindowEnd = Math.min(source.length, localOffset + 2000);
    const windowText = source.substring(localWindowStart, localWindowEnd);

    // 变量声明: const opts = { root: true }
    const declPattern = new RegExp(
        `\\b(?:const|let|var)\\s+${escapedId}\\s*=\\s*\\{[\\s\\S]{0,600}?\\broot\\s*:\\s*true\\b`,
    );
    if (declPattern.test(windowText)) return true;

    // 变量赋值: opts = { root: true }
    const assignPattern = new RegExp(
        `\\b${escapedId}\\s*=\\s*\\{[\\s\\S]{0,600}?\\broot\\s*:\\s*true\\b`,
    );
    if (assignPattern.test(windowText)) return true;

    // 工厂函数: const opts = buildOpts({ root: true })
    const methodLikePattern = new RegExp(
        `\\b(?:const|let|var)\\s+${escapedId}\\s*=\\s*[A-Za-z_$][\\w$]*\\([\\s\\S]{0,300}?\\broot\\s*:\\s*true\\b`,
    );
    if (methodLikePattern.test(windowText)) return true;

    return false;
}

/**
 * 校验光标所在的 commit/dispatch 字符串参数是否属于当前作用域内合法的 Vuex 调用。
 * 主要用于拦截前一个 action 的解构参数污染后一个 action 裸调用的误判。
 */
export function hasScopedVuexCallContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    method: 'commit' | 'dispatch',
    currentNamespace?: string[],
): boolean {
    const storeScope = normalizeStoreScope(currentNamespace, document.fileName);
    if (storeScope === undefined) return false;

    const scriptPrefix = extractScriptPrefixAtPosition(document, position);
    if (!scriptPrefix) return false;

    const rawPrefix = scriptPrefix.prefix.slice(Math.max(0, scriptPrefix.prefix.length - 1200));
    const currentCall = extractCurrentCallCalleeFromPrefix(rawPrefix);
    if (!currentCall) return false;

    const analysis = getProviderScriptAnalysis(document);
    const allowLooseStoreFileFallback = !hasExplicitVuexStoreStructure(analysis.ast);

    if (currentCall.kind === 'member') {
        const matchedMethod = currentCall.methodName;
        if (matchedMethod !== method) return false;

        const scopePath = findScopePathAtPosition(document, position);
        if (!scopePath) return false;
        const binding = scopePath.scope.getBinding(currentCall.objectName);
        return isLikelyVuexContextBinding(binding, storeScope, allowLooseStoreFileFallback);
    }

    const calleeName = currentCall.calleeName;
    const scopePath = findScopePathAtPosition(document, position);
    if (!scopePath) return false;
    const binding = scopePath.scope.getBinding(calleeName);
    return resolveScopedVuexMethodBinding(
        binding,
        method,
        storeScope,
        allowLooseStoreFileFallback,
    ) === method;
}

/**
 * 从光标位置向前找到当前所在的 callName( 调用，
 * 然后用括号配对提取整个调用体文本。
 */
export function extractCurrentCallBody(
    source: string,
    cursorOffset: number,
    callName: string,
): string | undefined {
    const searchStart = Math.max(0, cursorOffset - 2000);
    const before = source.substring(searchStart, cursorOffset);

    const escaped = callName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(before)) !== null) {
        lastMatch = m;
    }
    if (!lastMatch) return undefined;

    // 开始括号在源码中的绝对位置
    const openParenOffset = searchStart + lastMatch.index + lastMatch[0].length - 1;

    // 从开始括号向后用括号配对找到闭合括号
    let depth = 1;
    let i = openParenOffset + 1;
    const limit = Math.min(source.length, openParenOffset + 2000);
    let inString: string | false = false;
    while (i < limit && depth > 0) {
        const ch = source[i];
        if (inString) {
            if (ch === inString && source[i - 1] !== '\\') {
                inString = false;
            }
        } else {
            if (ch === '\x27' || ch === '\x22' || ch === '\x60') {
                inString = ch;
            } else if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
            }
        }
        i++;
    }

    return source.substring(openParenOffset, i);
}

/**
 * 检查当前位置是否命中了形如 getters.foo / getters?.foo 的成员访问，
 * 且该标识符在当前作用域中绑定为函数参数。
 * `replaceBeforeCursor` 用于补全中的不完整输入：会先把光标前的部分属性名替换成占位符再解析。
 */
export function hasParamBindingMemberAccess(
    document: vscode.TextDocument,
    position: vscode.Position,
    objectName: 'state' | 'getters' | 'rootState' | 'rootGetters',
    currentNamespace: string[] | undefined,
    options: { replaceBeforeCursor?: number } = {},
): boolean {
    const storeScope = normalizeStoreScope(currentNamespace, document.fileName);
    if (storeScope === undefined) return false;

    const analysis = getProviderScriptAnalysis(document);
    const probe = getProviderScriptProbe(document, position, options.replaceBeforeCursor ?? 0);
    if (!analysis.script || !probe?.ast) return false;
    const ast = probe.ast;
    const localOffset = probe.localOffset;
    const placeholder = probe.placeholder;
    const allowLooseStoreFileFallback = !hasExplicitVuexStoreStructure(analysis.ast);

    let matched = false;
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

    const visitMember = (path: any) => {
        const node = path.node;
        if (node.computed) return;
        if (node.property.type !== 'Identifier') return;

        const chain = getIdentifierChain(node.object as t.Node);
        if (!chain || chain[0] !== objectName) return;

        if (options.replaceBeforeCursor !== undefined) {
            if (node.property.name !== placeholder) return;
        } else {
            const start = node.property.start ?? -1;
            const end = node.property.end ?? start;
            if (localOffset < start || localOffset > end) return;
        }

        const binding = path.scope.getBinding(objectName);
        if (!isLikelyVuexSpecialParamBinding(binding, objectName, storeScope, allowLooseStoreFileFallback)) {
            return;
        }

        matched = true;
        path.stop();
    };

    traverse(ast, {
        MemberExpression: visitMember,
        OptionalMemberExpression: visitMember,
    } as any);

    return matched;
}

/**
 * 检查当前位置是否命中了形如 ctx.state.foo / context.rootGetters.bar 的成员访问，
 * 且最左侧对象标识符在当前作用域中绑定为函数参数。
 */
export function hasParamContextMemberAccess(
    document: vscode.TextDocument,
    position: vscode.Position,
    contextMemberName: 'state' | 'getters' | 'rootState' | 'rootGetters',
    currentNamespace: string[] | undefined,
    options: { replaceBeforeCursor?: number } = {},
): boolean {
    const storeScope = normalizeStoreScope(currentNamespace, document.fileName);
    if (storeScope === undefined) return false;

    const analysis = getProviderScriptAnalysis(document);
    const probe = getProviderScriptProbe(document, position, options.replaceBeforeCursor ?? 0);
    if (!analysis.script || !probe?.ast) return false;
    const ast = probe.ast;
    const localOffset = probe.localOffset;
    const placeholder = probe.placeholder;
    const allowLooseStoreFileFallback = !hasExplicitVuexStoreStructure(analysis.ast);

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

    let matched = false;
    const visitMember = (path: any) => {
        const node = path.node;
        if (node.computed) return;
        if (node.property.type !== 'Identifier') return;

        if (options.replaceBeforeCursor !== undefined) {
            if (node.property.name !== placeholder) return;
        } else {
            const start = node.property.start ?? -1;
            const end = node.property.end ?? start;
            if (localOffset < start || localOffset > end) return;
        }

        const chain = getIdentifierChain(node.object as t.Node);
        if (!chain || chain.length < 2 || chain[1] !== contextMemberName) return;

        const binding = path.scope.getBinding(chain[0]);
        if (!isLikelyVuexContextBinding(binding, storeScope, allowLooseStoreFileFallback)) return;

        matched = true;
        path.stop();
    };

    traverse(ast, {
        MemberExpression: visitMember,
        OptionalMemberExpression: visitMember,
    } as any);

    return matched;
}

export function hasExplicitVuexStoreStructure(ast: t.File | null | undefined): boolean {
    if (!ast) return false;

    const cached = explicitStoreStructureCache.get(ast);
    if (cached !== undefined) {
        return cached;
    }

    let found = false;
    traverse(ast, {
        ObjectExpression(path: any) {
            if (hasVuexStoreShape(path.node)) {
                found = true;
                path.stop();
            }
        },
    } as any);

    explicitStoreStructureCache.set(ast, found);
    return found;
}

export function isLikelyVuexContextBinding(
    binding: any,
    currentNamespace: string[] | undefined,
    allowLooseStoreFileFallback: boolean,
): boolean {
    if (currentNamespace === undefined || !binding || binding.kind !== 'param') return false;

    const functionPath = binding.path?.getFunctionParent?.();
    if (!functionPath) return false;

    if (getBindingParamIndex(functionPath, binding) !== 0) {
        return false;
    }

    const section = getVuexHandlerSectionForFunction(functionPath);
    if (section) {
        return section === 'actions' && isDirectParamIdentifierBinding(binding);
    }

    return allowLooseStoreFileFallback && isDirectParamIdentifierBinding(binding);
}

export function isLikelyVuexSpecialParamBinding(
    binding: any,
    objectName: 'state' | 'getters' | 'rootState' | 'rootGetters' | 'commit' | 'dispatch',
    currentNamespace: string[] | undefined,
    allowLooseStoreFileFallback: boolean,
): boolean {
    if (currentNamespace === undefined || !binding || binding.kind !== 'param') return false;

    const functionPath = binding.path?.getFunctionParent?.();
    if (!functionPath) return false;

    const sourceName = extractParamSourceName(binding);
    if (sourceName !== objectName) return false;

    const paramIndex = getBindingParamIndex(functionPath, binding);
    if (paramIndex < 0) return false;

    const section = getVuexHandlerSectionForFunction(functionPath);
    if (!section) {
        return allowLooseStoreFileFallback;
    }

    if (section === 'actions') {
        return paramIndex === 0;
    }

    if (section === 'mutations') {
        return objectName === 'state' && paramIndex === 0;
    }

    if (section === 'getters') {
        if (objectName === 'state') return paramIndex === 0;
        if (objectName === 'getters') return paramIndex === 1;
        if (objectName === 'rootState') return paramIndex === 2;
        if (objectName === 'rootGetters') return paramIndex === 3;
    }

    return false;
}

function extractProviderScriptContent(text: string): { content: string; offset: number } | null {
    const match = /<script(?![^>]*\bsetup\b)[^>]*>([\s\S]*?)<\/script>/.exec(text);
    if (match) {
        const contentStart = match.index + match[0].indexOf(match[1]);
        return { content: match[1], offset: contentStart };
    }

    if (!/<template[\s>]/.test(text)) {
        return { content: text, offset: 0 };
    }

    return null;
}

function findScopePathAtPosition(document: vscode.TextDocument, position: vscode.Position): any | undefined {
    const analysis = getProviderScriptAnalysis(document);
    const scriptPrefix = extractScriptPrefixAtPosition(document, position);
    if (!scriptPrefix) return undefined;

    const localOffset = scriptPrefix.localOffset;
    const cached = analysis.scopePathCache.get(localOffset);
    if (cached !== undefined) {
        return cached || undefined;
    }

    let content = closeUnterminatedStringAtCursor(scriptPrefix.prefix, localOffset);
    content += buildBalancedSuffix(content);

    const ast = parseProviderAst(content);
    if (!ast) {
        analysis.scopePathCache.set(localOffset, null);
        return undefined;
    }

    let bestPath: any | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;

    traverse(ast, {
        Program(path: any) {
            const start = path.node.start ?? 0;
            const end = path.node.end ?? 0;
            if (localOffset < start || localOffset > end) return;
            bestPath = path;
            bestSpan = end - start;
        },
        Function(path: any) {
            const start = path.node.start ?? 0;
            const end = path.node.end ?? 0;
            if (localOffset < start || localOffset > end) return;
            const span = end - start;
            if (span <= bestSpan) {
                bestPath = path;
                bestSpan = span;
            }
        },
    } as any);

    analysis.scopePathCache.set(localOffset, bestPath ?? null);
    return bestPath;
}

function closeUnterminatedStringAtCursor(content: string, localOffset: number): string {
    const lineStart = content.lastIndexOf('\n', Math.max(0, localOffset - 1)) + 1;
    const nextNewline = content.indexOf('\n', localOffset);
    const lineEnd = nextNewline >= 0 ? nextNewline : content.length;

    let quoteChar = '';
    for (let i = localOffset - 1; i >= lineStart; i--) {
        const ch = content[i];
        if ((ch === '"' || ch === '\'' || ch === '`') && content[i - 1] !== '\\') {
            quoteChar = ch;
            break;
        }
    }

    if (!quoteChar) return content;

    let hasClosingQuote = false;
    for (let i = localOffset; i < lineEnd; i++) {
        if (content[i] === quoteChar && content[i - 1] !== '\\') {
            hasClosingQuote = true;
            break;
        }
    }

    if (hasClosingQuote) return content;
    return content.slice(0, localOffset) + quoteChar + content.slice(localOffset);
}

function buildBalancedSuffix(content: string): string {
    const pairs: Record<string, string> = {
        '(': ')',
        '[': ']',
        '{': '}',
    };
    const stack: string[] = [];
    let inString: string | false = false;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === inString && content[i - 1] !== '\\') {
                inString = false;
            }
            continue;
        }

        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = ch;
            continue;
        }

        if (ch === '(' || ch === '[' || ch === '{') {
            stack.push(ch);
            continue;
        }

        if (ch === ')' || ch === ']' || ch === '}') {
            const expectedOpen =
                ch === ')' ? '(' :
                    ch === ']' ? '[' :
                        '{';
            if (stack[stack.length - 1] === expectedOpen) {
                stack.pop();
            }
        }
    }

    return stack.reverse().map((token) => pairs[token]).join('');
}

function extractCurrentCallCalleeFromPrefix(
    prefix: string,
): { kind: 'identifier'; calleeName: string } | { kind: 'member'; objectName: string; methodName: 'commit' | 'dispatch' } | undefined {
    let cursor = prefix.length - 1;
    let quoteChar = '';

    while (cursor >= 0) {
        const ch = prefix[cursor];
        if ((ch === '"' || ch === '\'' || ch === '`') && prefix[cursor - 1] !== '\\') {
            quoteChar = ch;
            break;
        }
        cursor--;
    }

    if (!quoteChar) return undefined;

    cursor--;
    let balance = 0;
    while (cursor >= 0) {
        const ch = prefix[cursor];
        if (ch === ')' || ch === ']' || ch === '}') {
            balance++;
            cursor--;
            continue;
        }

        if (ch === '(') {
            if (balance === 0) break;
            balance--;
            cursor--;
            continue;
        }

        if (ch === '[' || ch === '{') {
            if (balance > 0) {
                balance--;
            }
        }
        cursor--;
    }

    if (cursor < 0 || prefix[cursor] !== '(') return undefined;

    let calleeEnd = cursor - 1;
    while (calleeEnd >= 0 && /\s/.test(prefix[calleeEnd])) {
        calleeEnd--;
    }
    if (calleeEnd < 0) return undefined;

    const readIdentifierBackward = (end: number): { start: number; value: string } | undefined => {
        let start = end;
        while (start >= 0 && /[A-Za-z0-9_$]/.test(prefix[start])) {
            start--;
        }
        const value = prefix.slice(start + 1, end + 1);
        if (!value || !/^[A-Za-z_$][\w$]*$/.test(value)) return undefined;
        return { start: start + 1, value };
    };

    const methodIdentifier = readIdentifierBackward(calleeEnd);
    if (!methodIdentifier) return undefined;

    let beforeMethod = methodIdentifier.start - 1;
    while (beforeMethod >= 0 && /\s/.test(prefix[beforeMethod])) {
        beforeMethod--;
    }

    if (beforeMethod >= 0 && prefix[beforeMethod] === '.') {
        let objectEnd = beforeMethod - 1;
        while (objectEnd >= 0 && /\s/.test(prefix[objectEnd])) {
            objectEnd--;
        }
        if (objectEnd >= 0 && prefix[objectEnd] === '?') {
            objectEnd--;
            while (objectEnd >= 0 && /\s/.test(prefix[objectEnd])) {
                objectEnd--;
            }
        }
        const objectIdentifier = readIdentifierBackward(objectEnd);
        if (!objectIdentifier) return undefined;
        if (methodIdentifier.value !== 'commit' && methodIdentifier.value !== 'dispatch') {
            return undefined;
        }
        return {
            kind: 'member',
            objectName: objectIdentifier.value,
            methodName: methodIdentifier.value,
        };
    }

    return {
        kind: 'identifier',
        calleeName: methodIdentifier.value,
    };
}

function resolveScopedVuexMethodBinding(
    binding: any,
    expectedMethod: 'commit' | 'dispatch',
    currentNamespace: string[] | undefined,
    allowLooseStoreFileFallback: boolean,
    seen: Set<any> = new Set(),
): 'commit' | 'dispatch' | undefined {
    if (!binding || seen.has(binding)) return undefined;
    seen.add(binding);

    if (binding.kind === 'param') {
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
        return resolveScopedVuexMethodBinding(
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

function extractParamSourceName(binding: any): string | undefined {
    const path = binding.path;
    const node = path?.node;
    if (!node) return undefined;

    if (node.type === 'ObjectPattern') {
        const localName = binding.identifier?.name;
        for (const property of node.properties) {
            if (property.type !== 'ObjectProperty' || property.computed) continue;
            if (property.key.type !== 'Identifier') continue;

            if (property.value.type === 'Identifier' && property.value.name === localName) {
                return property.key.name;
            }

            if (
                property.value.type === 'AssignmentPattern' &&
                property.value.left.type === 'Identifier' &&
                property.value.left.name === localName
            ) {
                return property.key.name;
            }
        }
    }

    if (node.type === 'Identifier') {
        const parentNode = path.parentPath?.node;
        if (
            parentNode?.type === 'ObjectProperty' &&
            !parentNode.computed &&
            parentNode.key.type === 'Identifier'
        ) {
            return parentNode.key.name;
        }

        const grandParentNode = path.parentPath?.parentPath?.node;
        if (
            parentNode?.type === 'AssignmentPattern' &&
            grandParentNode?.type === 'ObjectProperty' &&
            !grandParentNode.computed &&
            grandParentNode.key.type === 'Identifier'
        ) {
            return grandParentNode.key.name;
        }

        return node.name;
    }

    if (
        node.type === 'ObjectProperty' &&
        !node.computed &&
        node.key.type === 'Identifier'
    ) {
        return node.key.name;
    }

    return undefined;
}

function extractScriptPrefixAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
): { prefix: string; localOffset: number } | undefined {
    const analysis = getProviderScriptAnalysis(document);
    const scriptText = analysis.script;
    if (!scriptText) return undefined;

    const documentOffset = document.offsetAt(position);
    const scriptStart = scriptText.offset;
    const scriptEnd = scriptStart + scriptText.content.length;
    if (documentOffset < scriptStart || documentOffset > scriptEnd) {
        return undefined;
    }

    const localOffset = documentOffset - scriptStart;
    return {
        prefix: scriptText.content.slice(0, localOffset),
        localOffset,
    };
}

function getProviderScriptAnalysis(document: vscode.TextDocument): ProviderScriptAnalysis {
    const cacheKey = document as unknown as object;
    const text = document.getText();
    const version = typeof (document as any).version === 'number'
        ? (document as any).version
        : undefined;

    const cached = providerScriptAnalysisCache.get(cacheKey);
    if (cached && cached.version === version && cached.text === text) {
        return cached;
    }

    const script = extractProviderScriptContent(text);
    const analysis: ProviderScriptAnalysis = {
        text,
        version,
        script,
        ast: script ? parseProviderAst(script.content) : null,
        probeCache: new Map(),
        scopePathCache: new Map(),
    };
    providerScriptAnalysisCache.set(cacheKey, analysis);
    return analysis;
}

function getProviderScriptProbe(
    document: vscode.TextDocument,
    position: vscode.Position,
    replaceBeforeCursor: number,
): ProviderScriptProbe | undefined {
    const analysis = getProviderScriptAnalysis(document);
    const scriptText = analysis.script;
    if (!scriptText) return undefined;

    const documentOffset = document.offsetAt(position);
    const scriptStart = scriptText.offset;
    const scriptEnd = scriptStart + scriptText.content.length;
    if (documentOffset < scriptStart || documentOffset > scriptEnd) {
        return undefined;
    }

    const originalLocalOffset = documentOffset - scriptStart;
    const cacheKey = `${originalLocalOffset}:${replaceBeforeCursor}`;
    const cached = analysis.probeCache.get(cacheKey);
    if (cached !== undefined) {
        return cached || undefined;
    }

    let content = scriptText.content;
    let localOffset = originalLocalOffset;
    const placeholder = '__vuexHelperProbe__';

    if (replaceBeforeCursor > 0) {
        const replaceStart = localOffset - replaceBeforeCursor;
        if (replaceStart < 0) {
            analysis.probeCache.set(cacheKey, null);
            return undefined;
        }
        content =
            content.slice(0, replaceStart) +
            placeholder +
            content.slice(localOffset);
        localOffset = replaceStart;
    } else if (replaceBeforeCursor === 0) {
        content =
            content.slice(0, localOffset) +
            placeholder +
            content.slice(localOffset);
    }

    const probe: ProviderScriptProbe = {
        ast: parseProviderAst(content),
        localOffset,
        placeholder,
    };
    analysis.probeCache.set(cacheKey, probe);
    return probe;
}

function parseProviderAst(content: string): t.File | null {
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

function hasVuexStoreShape(node: t.ObjectExpression): boolean {
    return node.properties.some((property) => {
        if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') {
            return false;
        }
        const keyName = getStaticPropertyName(property);
        return !!keyName && VUEX_STORE_SHAPE_KEYS.has(keyName);
    });
}

function getStaticPropertyName(node: any): string | undefined {
    const key = node?.key;
    if (!key || node.computed) return undefined;
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'StringLiteral') return key.value;
    return undefined;
}

function getVuexHandlerSectionForFunction(functionPath: any): VuexHandlerSection | undefined {
    if (functionPath.node?.type === 'ObjectMethod') {
        const containerPath = functionPath.parentPath;
        if (containerPath?.node?.type === 'ObjectExpression') {
            return resolveVuexHandlerSectionFromObjectExpression(containerPath);
        }
        return undefined;
    }

    const parentPath = functionPath.parentPath;
    if (!parentPath) return undefined;

    if (
        parentPath.node?.type === 'ObjectProperty' &&
        parentPath.node.value === functionPath.node
    ) {
        const containerPath = parentPath.parentPath;
        if (containerPath?.node?.type === 'ObjectExpression') {
            return resolveVuexHandlerSectionFromObjectExpression(containerPath);
        }
    }

    return undefined;
}

function resolveVuexHandlerSectionFromObjectExpression(objectExpressionPath: any): VuexHandlerSection | undefined {
    const parentPath = objectExpressionPath.parentPath;
    if (!parentPath) return undefined;

    if (
        (parentPath.node?.type === 'ObjectProperty' || parentPath.node?.type === 'ObjectMethod')
    ) {
        const keyName = getStaticPropertyName(parentPath.node);
        if (keyName === 'actions' || keyName === 'getters' || keyName === 'mutations') {
            return keyName;
        }

        const grandParentPath = parentPath.parentPath;
        if (grandParentPath?.node?.type === 'ObjectExpression') {
            return resolveVuexHandlerSectionFromObjectExpression(grandParentPath);
        }
    }

    if (parentPath.node?.type === 'VariableDeclarator' && parentPath.node.id?.type === 'Identifier') {
        const keyName = parentPath.node.id.name;
        if (keyName === 'actions' || keyName === 'getters' || keyName === 'mutations') {
            return keyName;
        }
    }

    return undefined;
}

function getBindingParamIndex(functionPath: any, binding: any): number {
    if (typeof functionPath.get !== 'function' || !binding?.path) return -1;

    const paramPaths = functionPath.get('params');
    if (!Array.isArray(paramPaths)) return -1;

    for (let index = 0; index < paramPaths.length; index++) {
        const paramPath = paramPaths[index];
        if (paramPath === binding.path) {
            return index;
        }
        const nestedInParam = binding.path.findParent((path: any) => path === paramPath);
        if (nestedInParam) {
            return index;
        }
        if (paramPath?.node?.type === 'AssignmentPattern' && typeof paramPath.get === 'function') {
            const leftPath = paramPath.get('left');
            if (leftPath === binding.path || binding.path.findParent((path: any) => path === leftPath)) {
                return index;
            }
        }
    }

    return -1;
}

function isDirectParamIdentifierBinding(binding: any): boolean {
    return binding?.path?.node?.type === 'Identifier' && binding.path.parentPath?.node?.type !== 'ObjectProperty';
}

function normalizeStoreScope(
    currentNamespace: string[] | undefined,
    fileName: string | undefined,
): string[] | undefined {
    if (currentNamespace !== undefined) return currentNamespace;
    if (fileName && /(^|[\\/])store([\\/]|$)/.test(fileName)) {
        return [];
    }
    return undefined;
}
