import { StoreIndexer } from '../services/StoreIndexer';
import { ComponentMapper } from '../services/ComponentMapper';
import { VuexDefinitionProvider } from '../providers/VuexDefinitionProvider';
import { VuexCompletionItemProvider } from '../providers/VuexCompletionItemProvider';
import { VuexHoverProvider } from '../providers/VuexHoverProvider';
import { VuexDiagnosticProvider } from '../services/VuexDiagnosticProvider';
import * as vscode from 'vscode';

interface ConfigurableVscodeWorkspace {
    workspaceFolders?: any;
    setConfiguration?: (section: string, values: Record<string, any>) => void;
}

function setVuexHelperConfiguration(configuration: Record<string, any>): void {
    const workspace = vscode.workspace as typeof vscode.workspace & ConfigurableVscodeWorkspace;
    workspace.setConfiguration?.('vuexHelper', configuration);
}

export class LspVuexWorkspace {
    public readonly storeIndexer: StoreIndexer;
    public readonly componentMapper = new ComponentMapper();
    public readonly definitionProvider: VuexDefinitionProvider;
    public readonly completionProvider: VuexCompletionItemProvider;
    public readonly hoverProvider: VuexHoverProvider;
    public readonly diagnosticProvider: VuexDiagnosticProvider;

    constructor(public readonly workspaceRoot: string, configuration: Record<string, any> = {}) {
        const workspace = vscode.workspace as typeof vscode.workspace & ConfigurableVscodeWorkspace;
        workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
        setVuexHelperConfiguration(configuration);
        this.storeIndexer = new StoreIndexer(workspaceRoot);
        this.definitionProvider = new VuexDefinitionProvider(this.storeIndexer, this.componentMapper);
        this.completionProvider = new VuexCompletionItemProvider(this.storeIndexer, this.componentMapper);
        this.hoverProvider = new VuexHoverProvider(this.storeIndexer, this.componentMapper);
        this.diagnosticProvider = new VuexDiagnosticProvider(this.storeIndexer);
    }

    async index(changedFiles?: string[]): Promise<void> {
        await this.storeIndexer.index({
            interactive: false,
            changedFiles,
            forceFull: !changedFiles || changedFiles.length === 0,
        });
    }

    async updateConfiguration(configuration: Record<string, any>): Promise<void> {
        setVuexHelperConfiguration(configuration);
        this.storeIndexer.resetEntryInteractionState();
        await this.index();
    }

    async isSupportedProject(): Promise<boolean> {
        return this.storeIndexer.isSupportedProject();
    }

    hasStoreEntry(): boolean {
        return !!this.storeIndexer.getStoreEntryPath();
    }

    shouldReindexForFile(filePath: string): boolean {
        return this.storeIndexer.shouldReindexForFile(filePath);
    }

    dispose(): void {
        this.storeIndexer.dispose();
        this.componentMapper.dispose();
    }
}
