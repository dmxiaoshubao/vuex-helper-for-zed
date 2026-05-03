import * as path from 'path';
import * as fs from 'fs';
import * as json5 from 'json5';

export class PathResolver {
    private workspaceRoot: string;
    private aliasMap: Record<string, string[]> = {};
    private initialized = false;
    private resolvedWorkspaceRoot = '';
    // 路径解析缓存，key 为 `${importPath}::${dirname}`，生命周期与索引周期绑定
    private resolveCache: Map<string, string | null> = new Map();

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /** 清除路径解析缓存，应在每次全量索引开始前调用 */
    public clearCache(): void {
        this.resolveCache.clear();
    }

    private initPromise: Promise<void> | null = null;

    /** 延迟初始化：首次使用时异步加载配置并缓存 workspace realpath */
    private ensureInitialized(): Promise<void> {
        if (this.initialized) return Promise.resolve();
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            await this.loadConfig();
            try {
                this.resolvedWorkspaceRoot = await fs.promises.realpath(this.workspaceRoot);
            } catch {
                this.resolvedWorkspaceRoot = path.resolve(this.workspaceRoot);
            }
            this.initialized = true;
            this.initPromise = null;
        })();

        return this.initPromise;
    }

    private async loadConfig(): Promise<void> {
        const configFiles = ['tsconfig.json', 'jsconfig.json'];
        for (const file of configFiles) {
            const configPath = path.join(this.workspaceRoot, file);
            try {
                const content = await fs.promises.readFile(configPath, 'utf-8');
                const config = json5.parse(content);
                if (config.compilerOptions && config.compilerOptions.paths) {
                    this.aliasMap = config.compilerOptions.paths;
                    break; // Prioritize tsconfig over jsconfig
                }
            } catch {
                // 文件不存在或解析失败，继续尝试下一个
            }
        }
    }

    /**
     * Resolve an import path to an absolute file path.
     * @param importPath e.g. "@/store", "./modules/user"
     * @param currentFilePath Absolute path of the file containing the import
     */
    public async resolve(importPath: string, currentFilePath: string): Promise<string | null> {
        await this.ensureInitialized();

        // 缓存查询
        const cacheKey = `${importPath}::${path.dirname(currentFilePath)}`;
        if (this.resolveCache.has(cacheKey)) {
            return this.resolveCache.get(cacheKey)!;
        }

        const result = await this.resolveUncached(importPath, currentFilePath);
        this.resolveCache.set(cacheKey, result);
        return result;
    }

    /**
     * 将工作区内绝对路径转换成适合写入配置的路径。
     * 优先使用 ts/jsconfig 中可回解析的别名，否则退回到工作区相对路径。
     */
    public async toPreferredConfigPath(filePath: string): Promise<string> {
        await this.ensureInitialized();

        const normalizedFilePath = await this.normalizeRealPath(filePath);
        const aliasPath = await this.findAliasPathForFile(normalizedFilePath);
        if (aliasPath) {
            return aliasPath;
        }

        const relativePath = path.relative(this.resolvedWorkspaceRoot, normalizedFilePath);
        return this.normalizeConfigPath(relativePath);
    }

    private async resolveUncached(importPath: string, currentFilePath: string): Promise<string | null> {
        if (importPath.startsWith('.')) {
            // Relative path
            const dir = path.dirname(currentFilePath);
            const absolutePath = path.resolve(dir, importPath);
            return await this.ensureWorkspacePath(await this.tryExtensions(absolutePath));
        }

        // Alias path
        for (const alias in this.aliasMap) {
            // Remove wildcard *
            const aliasPrefix = alias.replace('/*', '');
            const isWildcardAlias = alias.endsWith('/*');
            const isExactMatch = importPath === aliasPrefix;
            const isNestedMatch = importPath.startsWith(`${aliasPrefix}/`);
            const matchesAlias = isWildcardAlias ? (isExactMatch || isNestedMatch) : isExactMatch;

            if (matchesAlias) {
                const paths = this.aliasMap[alias];
                for (const p of paths) {
                    // Remove wildcard * from target path and join with workspace root
                    const targetPrefix = p.replace('/*', '');
                    const rest = importPath.substring(aliasPrefix.length);
                    const absolutePath = path.join(this.workspaceRoot, targetPrefix, rest);
                    const resolved = await this.ensureWorkspacePath(await this.tryExtensions(absolutePath));
                    if (resolved) {
                        return resolved;
                    }
                }
            }
        }

        // Try node_modules or absolute path (less common for source files but possible)
        // require.resolve 无 async 版本，保持同步——仅作 node_modules 兜底，极少命中
        try {
            const absolutePath = require.resolve(importPath, { paths: [path.dirname(currentFilePath)] });
            return await this.ensureWorkspacePath(absolutePath);
        } catch (e) {
            // ignore
        }

        return null;
    }

    private async findAliasPathForFile(filePath: string): Promise<string | null> {
        const dummyContext = path.join(this.workspaceRoot, 'package.json');

        for (const alias in this.aliasMap) {
            const isWildcardAlias = alias.endsWith('/*');
            const aliasPrefix = alias.replace('/*', '');
            const targets = this.aliasMap[alias] || [];

            for (const target of targets) {
                const targetPrefix = target.replace('/*', '');
                const targetBasePath = path.resolve(this.workspaceRoot, targetPrefix);
                const normalizedTargetBase = await this.normalizePath(targetBasePath);

                if (isWildcardAlias) {
                    const relative = path.relative(normalizedTargetBase, filePath);
                    if (relative.startsWith('..') || path.isAbsolute(relative)) {
                        continue;
                    }

                    const candidate = relative
                        ? `${aliasPrefix}/${this.normalizeConfigPath(relative)}`
                        : aliasPrefix;
                    const resolvedCandidate = await this.resolve(candidate, dummyContext);
                    if (resolvedCandidate && await this.normalizeRealPath(resolvedCandidate) === filePath) {
                        return candidate;
                    }
                    continue;
                }

                if (normalizedTargetBase !== filePath) {
                    continue;
                }

                const resolvedCandidate = await this.resolve(aliasPrefix, dummyContext);
                if (resolvedCandidate && await this.normalizeRealPath(resolvedCandidate) === filePath) {
                    return aliasPrefix;
                }
            }
        }

        return null;
    }

    private async tryExtensions(filePath: string): Promise<string | null> {
        const extensions = ['.ts', '.js', '.vue', '.json', '/index.ts', '/index.js', '/index.vue'];

        // 快速路径：先检查原始文件是否存在
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) return filePath;
        } catch {
            // 不存在，继续尝试扩展名
        }

        // 并行探测所有扩展名
        const candidates = extensions.map(ext => filePath + ext);
        const results = await Promise.allSettled(
            candidates.map(async (fullPath) => {
                const stat = await fs.promises.stat(fullPath);
                if (stat.isFile()) return fullPath;
                throw new Error('not a file');
            })
        );

        // 按优先级顺序返回第一个成功结果
        for (const result of results) {
            if (result.status === 'fulfilled') return result.value;
        }
        return null;
    }

    private async ensureWorkspacePath(candidate: string | null): Promise<string | null> {
        if (!candidate) return null;

        // 使用已缓存的 resolvedWorkspaceRoot，避免重复 realpath 调用
        const workspaceRoot = this.resolvedWorkspaceRoot;
        const resolvedPath = await this.normalizeRealPath(candidate);

        const relative = path.relative(workspaceRoot, resolvedPath);
        const isInsideWorkspace = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

        if (relative === '' || isInsideWorkspace) {
            return resolvedPath;
        }
        return null;
    }

    private async normalizeRealPath(candidate: string): Promise<string> {
        try {
            return await fs.promises.realpath(candidate);
        } catch {
            return path.resolve(candidate);
        }
    }

    private async normalizePath(candidate: string): Promise<string> {
        try {
            return await fs.promises.realpath(candidate);
        } catch {
            return path.resolve(candidate);
        }
    }

    private normalizeConfigPath(candidate: string): string {
        return candidate.split(path.sep).join('/');
    }
}
