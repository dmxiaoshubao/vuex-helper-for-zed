export type IssueType = 'bug' | 'security' | 'performance' | 'memory';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'new' | 'analyzing' | 'in_progress' | 'fixed_pending_verification' | 'verified';

export interface IssueAuditEvent {
    from: IssueStatus;
    to: IssueStatus;
    actor: string;
    at: string;
    note?: string;
}

export interface IssueTestLink {
    testId: string;
    preFixCovered: boolean;
    postFixCovered: boolean;
    passed: boolean;
}

export interface IssueRecord {
    id: string;
    title: string;
    type: IssueType;
    severity: IssueSeverity;
    impactScope: string;
    reproduction: string;
    owner: string;
    status: IssueStatus;
    createdAt: string;
    updatedAt: string;
    remediation?: string;
    audit: IssueAuditEvent[];
    tests: IssueTestLink[];
}

const transitions: Record<IssueStatus, IssueStatus[]> = {
    new: ['analyzing'],
    analyzing: ['in_progress'],
    in_progress: ['fixed_pending_verification'],
    fixed_pending_verification: ['verified', 'in_progress'],
    verified: []
};

export class IssueRegistry {
    private readonly issues = new Map<string, IssueRecord>();

    public createIssue(input: Omit<IssueRecord, 'status' | 'createdAt' | 'updatedAt' | 'audit' | 'tests'>): IssueRecord {
        const now = new Date().toISOString();
        const issue: IssueRecord = {
            ...input,
            status: 'new',
            createdAt: now,
            updatedAt: now,
            audit: [],
            tests: []
        };
        this.issues.set(issue.id, issue);
        return issue;
    }

    public listIssues(): IssueRecord[] {
        return Array.from(this.issues.values());
    }

    public getByPriority(): IssueRecord[] {
        return this.listIssues().sort((a, b) => this.getPriorityScore(b) - this.getPriorityScore(a));
    }

    public transition(id: string, to: IssueStatus, actor: string, note?: string): IssueRecord {
        const issue = this.mustGet(id);
        const allowed = transitions[issue.status];
        if (!allowed.includes(to)) {
            throw new Error(`Illegal transition: ${issue.status} -> ${to}`);
        }

        issue.audit.push({
            from: issue.status,
            to,
            actor,
            at: new Date().toISOString(),
            note
        });
        issue.status = to;
        issue.updatedAt = new Date().toISOString();
        return issue;
    }

    public recordRemediation(id: string, remediation: string, impactScope: string): IssueRecord {
        const issue = this.mustGet(id);
        issue.remediation = remediation;
        issue.impactScope = impactScope;
        issue.updatedAt = new Date().toISOString();
        return issue;
    }

    public linkTest(id: string, link: IssueTestLink): IssueRecord {
        const issue = this.mustGet(id);
        const existing = issue.tests.find((item) => item.testId === link.testId);
        if (existing) {
            existing.preFixCovered = link.preFixCovered;
            existing.postFixCovered = link.postFixCovered;
            existing.passed = link.passed;
        } else {
            issue.tests.push(link);
        }
        issue.updatedAt = new Date().toISOString();
        return issue;
    }

    public canMarkVerified(id: string): boolean {
        const issue = this.mustGet(id);
        if (issue.tests.length === 0) return false;
        return issue.tests.every((test) => test.preFixCovered && test.postFixCovered && test.passed);
    }

    private getPriorityScore(issue: IssueRecord): number {
        const severityScore: Record<IssueSeverity, number> = {
            low: 1,
            medium: 2,
            high: 3,
            critical: 4
        };
        const typeWeight: Record<IssueType, number> = {
            bug: 0,
            performance: 1,
            memory: 2,
            security: 3
        };
        return severityScore[issue.severity] * 10 + typeWeight[issue.type];
    }

    private mustGet(id: string): IssueRecord {
        const issue = this.issues.get(id);
        if (!issue) {
            throw new Error(`Issue not found: ${id}`);
        }
        return issue;
    }
}
