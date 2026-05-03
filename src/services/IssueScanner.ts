import * as fs from 'fs';
import * as path from 'path';
import { IssueRegistry } from './IssueRegistry';

export class IssueScanner {
    constructor(private readonly workspaceRoot: string, private readonly registry: IssueRegistry) {}

    public scanProject(): void {
        this.scanDependencyRisks();
        this.scanSourceRisks(path.join(this.workspaceRoot, 'src'));
    }

    private scanDependencyRisks(): void {
        const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } as Record<string, string>;

        if (allDeps.glob && /^(\^|~)?8\./.test(allDeps.glob)) {
            this.registry.createIssue({
                id: 'DEP-001',
                title: 'glob v8 风险跟踪',
                type: 'security',
                severity: 'medium',
                impactScope: '依赖解析与文件扫描',
                reproduction: '当前 package.json 使用 glob@8.x，建议持续跟踪上游安全公告。',
                owner: 'engineering'
            });
        }
    }

    private scanSourceRisks(sourceRoot: string): void {
        if (!fs.existsSync(sourceRoot)) return;

        const files = this.collectTsFiles(sourceRoot);
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');

            if (content.includes('new Map()') && content.includes('cache') && !content.includes('trimCache')) {
                this.registry.createIssue({
                    id: `SRC-CACHE-${path.basename(file)}`,
                    title: '潜在无上限缓存',
                    type: 'memory',
                    severity: 'high',
                    impactScope: path.relative(this.workspaceRoot, file),
                    reproduction: '发现缓存 Map 未设置上限或淘汰策略。',
                    owner: 'engineering'
                });
            }

            if (content.includes('require.resolve(') && !content.includes('ensureWorkspacePath')) {
                this.registry.createIssue({
                    id: `SRC-PATH-${path.basename(file)}`,
                    title: '路径解析越界风险',
                    type: 'security',
                    severity: 'high',
                    impactScope: path.relative(this.workspaceRoot, file),
                    reproduction: '发现 require.resolve 结果未校验 workspace 边界。',
                    owner: 'engineering'
                });
            }
        }
    }

    private collectTsFiles(root: string): string[] {
        const results: string[] = [];
        const stack = [root];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(full);
                } else if (entry.isFile() && full.endsWith('.ts')) {
                    results.push(full);
                }
            }
        }
        return results;
    }
}
