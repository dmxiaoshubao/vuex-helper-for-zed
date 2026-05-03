import { IssueRecord } from './IssueRegistry';

export interface PerformanceBaseline {
    name: string;
    baselineMs: number;
    measuredMs: number;
    maxRegressionRate: number;
}

export class QualityGate {
    public validateIssue(issue: IssueRecord): string[] {
        const errors: string[] = [];

        if (issue.tests.length === 0) {
            errors.push(`${issue.id}: 缺少测试映射`);
        }

        for (const test of issue.tests) {
            if (!test.preFixCovered || !test.postFixCovered) {
                errors.push(`${issue.id}: 测试 ${test.testId} 未覆盖修复前后路径`);
            }
            if (!test.passed) {
                errors.push(`${issue.id}: 测试 ${test.testId} 未通过`);
            }
        }

        return errors;
    }

    public validateTestsNoBypass(testSources: string[]): string[] {
        const errors: string[] = [];
        testSources.forEach((source, index) => {
            if (source.includes('.only(')) {
                errors.push(`test#${index}: 存在 .only 绕过`);
            }
            if (source.includes('.skip(')) {
                errors.push(`test#${index}: 存在 .skip 绕过`);
            }
        });
        return errors;
    }

    public validatePerformanceBaselines(baselines: PerformanceBaseline[]): string[] {
        const errors: string[] = [];
        baselines.forEach((baseline) => {
            const threshold = baseline.baselineMs * (1 + baseline.maxRegressionRate);
            if (baseline.measuredMs > threshold) {
                errors.push(`${baseline.name}: 性能退化超阈值 (${baseline.measuredMs}ms > ${threshold}ms)`);
            }
        });
        return errors;
    }
}
