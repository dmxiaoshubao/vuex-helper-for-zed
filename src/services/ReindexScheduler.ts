export class ReindexScheduler {
    private timer: NodeJS.Timeout | undefined;
    private pendingFiles: Set<string> = new Set();

    constructor(private readonly callback: (changedFiles: string[]) => void, private readonly delayMs: number = 150) {}

    public schedule(filePath?: string): void {
        if (filePath) {
            this.pendingFiles.add(filePath);
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            const changedFiles = Array.from(this.pendingFiles);
            this.pendingFiles.clear();
            this.callback(changedFiles);
        }, this.delayMs);
    }

    public hasPending(): boolean {
        return this.timer !== undefined;
    }

    public dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pendingFiles.clear();
    }
}
