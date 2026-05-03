import * as fs from 'fs';
import * as vscode from 'vscode';
import { EntryAnalyzer } from './EntryAnalyzer';
import { StoreParser } from './StoreParser';
import { CoreLocation } from '../core/types';
import { VuexStoreMap, VuexStateInfo, VuexGetterInfo, VuexMutationInfo, VuexActionInfo } from '../types';

export interface IndexOptions {
    interactive?: boolean;
    changedFiles?: string[];
    forceFull?: boolean;
}

export type VuexItemType = 'state' | 'getter' | 'mutation' | 'action';
export type VuexAnyItem = VuexStateInfo | VuexGetterInfo | VuexMutationInfo | VuexActionInfo;

export interface VuexGlobalGetterConflict {
    name: string;
    items: VuexGetterInfo[];
}

export class StoreIndexer {
    private workspaceRoot: string;
    private entryAnalyzer: EntryAnalyzer;
    private storeParser: StoreParser;
    private storeMap: VuexStoreMap | null = null;
    private lastStoreEntryPath: string | null = null;
    private indexingPromise: Promise<void> | null = null;
    private rerunRequested = false;
    private rerunInteractive = false;
    private rerunForceFull = false;
    private rerunChangedFiles: Set<string> = new Set();
    private itemIndexByTypeNsName: Map<string, VuexAnyItem> = new Map();
    private itemIndexByTypeFullPath: Map<string, VuexAnyItem> = new Map();
    private itemIndexByTypeNamespace: Map<string, VuexAnyItem[]> = new Map();
    private moduleDefinitionIndex: Map<string, CoreLocation> = new Map();
    private moduleNames: Set<string> = new Set();
    private duplicateGlobalGetterConflicts: VuexGlobalGetterConflict[] = [];
    private internalStoreEntryConfigChangeCount = 0;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.entryAnalyzer = new EntryAnalyzer(workspaceRoot, {
            onWillUpdateStoreEntryConfig: () => {
                this.internalStoreEntryConfigChangeCount++;
            }
        });
        this.storeParser = new StoreParser(workspaceRoot);
    }

    public async index(options: IndexOptions = {}) {
        const interactive = options.interactive === true;
        const forceFull = options.forceFull === true;
        const changedFiles = options.changedFiles || [];
        const hasMeaningfulRequest = interactive || forceFull || changedFiles.length > 0;
        if (this.indexingPromise) {
            if (hasMeaningfulRequest) {
                this.rerunRequested = true;
                this.rerunInteractive = this.rerunInteractive || interactive;
                this.rerunForceFull = this.rerunForceFull || forceFull;
                changedFiles.forEach((file) => this.rerunChangedFiles.add(file));
            }
            return this.indexingPromise;
        }

        try {
            this.indexingPromise = this.performIndex({ interactive, forceFull, changedFiles });
            await this.indexingPromise;
            while (this.rerunRequested) {
                const nextInteractive = this.rerunInteractive;
                const nextForceFull = this.rerunForceFull;
                const nextChangedFiles = Array.from(this.rerunChangedFiles);
                this.rerunRequested = false;
                this.rerunInteractive = false;
                this.rerunForceFull = false;
                this.rerunChangedFiles.clear();
                this.indexingPromise = this.performIndex({ interactive: nextInteractive, forceFull: nextForceFull, changedFiles: nextChangedFiles });
                await this.indexingPromise;
            }
        } finally {
            this.indexingPromise = null;
            this.rerunInteractive = false;
            this.rerunForceFull = false;
        }
    }

    private async performIndex(options: IndexOptions) {
        const interactive = options.interactive === true;
        const forceFull = options.forceFull === true;
        const normalizedChangedFiles = (options.changedFiles || []).map((filePath) => vscode.Uri.file(filePath).fsPath);
        const shouldRefreshEntry = forceFull || this.shouldRefreshEntry(normalizedChangedFiles);
        if (shouldRefreshEntry && 'invalidateCache' in this.entryAnalyzer) {
            this.entryAnalyzer.invalidateCache();
        }

        const storePath = shouldRefreshEntry || !this.lastStoreEntryPath
            ? await this.entryAnalyzer.analyze({ interactive, forceRefresh: shouldRefreshEntry })
            : this.lastStoreEntryPath;

        if (storePath) {
            const normalizedStorePath = vscode.Uri.file(storePath).fsPath;
            const hasUnindexedChangedFile = normalizedChangedFiles.some((filePath) => !this.storeParser.hasIndexedFile(filePath));
            const canIncremental =
                !forceFull &&
                normalizedChangedFiles.length > 0 &&
                !!this.storeMap &&
                this.lastStoreEntryPath === normalizedStorePath &&
                !hasUnindexedChangedFile;

            this.storeMap = canIncremental
                ? await this.storeParser.parse(normalizedStorePath, { changedFiles: normalizedChangedFiles })
                : await this.storeParser.parse(normalizedStorePath);
            this.lastStoreEntryPath = normalizedStorePath;
            this.rebuildIndexes();
        } else {
            // Avoid stale completion/definition results after store deletion/misconfiguration.
            this.lastStoreEntryPath = null;
            this.storeMap = null;
            this.clearIndexes();
        }
    }

    private shouldRefreshEntry(changedFiles: string[]): boolean {
        if (!this.lastStoreEntryPath) return true;
        if (changedFiles.length === 0) {
            return !fs.existsSync(this.lastStoreEntryPath);
        }

        const entryPath = vscode.Uri.file(this.lastStoreEntryPath).fsPath;
        for (const filePath of changedFiles) {
            const lowerPath = filePath.toLowerCase();
            if (filePath === entryPath) return true;
            if (/(^|[\\/])(tsconfig|jsconfig)\.json$/.test(lowerPath)) return true;
            if (/(^|[\\/])src[\\/](main|index)\.(js|ts)$/.test(lowerPath)) return true;
        }
        return false;
    }

    public shouldReindexForFile(filePath: string): boolean {
        const normalizedPath = vscode.Uri.file(filePath).fsPath;
        const lowerPath = normalizedPath.toLowerCase();

        // During cold start we have no graph yet; allow discovery.
        if (!this.storeMap) return true;

        if (this.storeParser.hasIndexedFile(normalizedPath)) return true;
        if (/(^|[\\/])(tsconfig|jsconfig)\.json$/.test(lowerPath)) return true;
        if (/(^|[\\/])src[\\/](main|index)\.(js|ts)$/.test(lowerPath)) return true;
        if (/[\\/]store[\\/]/.test(lowerPath)) return true;

        if (this.lastStoreEntryPath) {
            const normalizedEntry = vscode.Uri.file(this.lastStoreEntryPath).fsPath;
            if (normalizedPath === normalizedEntry) return true;
        }

        return false;
    }

    public dispose(): void {
        this.storeMap = null;
        this.lastStoreEntryPath = null;
        this.indexingPromise = null;
        this.rerunRequested = false;
        this.rerunInteractive = false;
        this.rerunForceFull = false;
        this.rerunChangedFiles.clear();
        if ('dispose' in this.storeParser && typeof this.storeParser.dispose === 'function') {
            this.storeParser.dispose();
        }
        this.clearIndexes();
    }

    public getStoreMap(): VuexStoreMap | null {
        return this.storeMap;
    }

    public getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    public getStoreEntryPath(): string | null {
        return this.lastStoreEntryPath;
    }

    public resetEntryInteractionState(): void {
        this.entryAnalyzer.resetInteractionState();
    }

    public consumeInternalStoreEntryConfigChange(): boolean {
        if (this.internalStoreEntryConfigChangeCount <= 0) {
            return false;
        }
        this.internalStoreEntryConfigChangeCount--;
        return true;
    }

    private clearIndexes(): void {
        this.itemIndexByTypeNsName.clear();
        this.itemIndexByTypeFullPath.clear();
        this.itemIndexByTypeNamespace.clear();
        this.moduleDefinitionIndex.clear();
        this.moduleNames.clear();
        this.duplicateGlobalGetterConflicts = [];
    }

    private rebuildIndexes(): void {
        this.clearIndexes();
        if (!this.storeMap) return;

        const indexItems = (type: VuexItemType, items: VuexAnyItem[]) => {
            for (const item of items) {
                const namespace = item.modulePath.join('/');
                const fullPath = namespace ? `${namespace}/${item.name}` : item.name;
                this.itemIndexByTypeNsName.set(this.makeNsNameKey(type, namespace, item.name), item);
                this.itemIndexByTypeFullPath.set(this.makeFullPathKey(type, fullPath), item);

                const nsBucketKey = this.makeTypeNamespaceKey(type, namespace);
                const bucket = this.itemIndexByTypeNamespace.get(nsBucketKey);
                if (bucket) {
                    bucket.push(item);
                } else {
                    this.itemIndexByTypeNamespace.set(nsBucketKey, [item]);
                }

                if (namespace) {
                    this.moduleNames.add(namespace);
                    if (!this.moduleDefinitionIndex.has(namespace)) {
                        this.moduleDefinitionIndex.set(namespace, item.defLocation);
                    }
                }
            }
        };

        indexItems('state', this.storeMap.state);
        indexItems('getter', this.storeMap.getters);
        indexItems('mutation', this.storeMap.mutations);
        indexItems('action', this.storeMap.actions);
        this.duplicateGlobalGetterConflicts = this.collectDuplicateGlobalGetterConflicts();
    }

    private collectDuplicateGlobalGetterConflicts(): VuexGlobalGetterConflict[] {
        if (!this.storeMap) return [];

        const buckets = new Map<string, VuexGetterInfo[]>();
        for (const getter of this.storeMap.getters) {
            if (getter.modulePath.length !== 0) continue;
            const bucket = buckets.get(getter.name);
            if (bucket) {
                bucket.push(getter);
            } else {
                buckets.set(getter.name, [getter]);
            }
        }

        const conflicts: VuexGlobalGetterConflict[] = [];
        for (const [name, items] of buckets) {
            if (items.length > 1) {
                conflicts.push({ name, items: [...items] });
            }
        }
        return conflicts;
    }

    private makeTypeNamespaceKey(type: VuexItemType, namespace: string): string {
        return `${type}::${namespace}`;
    }

    private makeNsNameKey(type: VuexItemType, namespace: string, name: string): string {
        return `${type}::${namespace}::${name}`;
    }

    private makeFullPathKey(type: VuexItemType, fullPath: string): string {
        return `${type}::${fullPath}`;
    }

    public getIndexedItem(type: VuexItemType, name: string, namespace?: string): VuexAnyItem | undefined {
        const byIndex = this.itemIndexByTypeNsName.get(this.makeNsNameKey(type, namespace || '', name));
        if (byIndex) return byIndex;

        const namespaceStr = namespace || '';
        return this.getItemsByType(type).find((item) => item.name === name && item.modulePath.join('/') === namespaceStr);
    }

    public getIndexedItemByFullPath(type: VuexItemType, fullPath: string): VuexAnyItem | undefined {
        const byIndex = this.itemIndexByTypeFullPath.get(this.makeFullPathKey(type, fullPath));
        if (byIndex) return byIndex;

        const parts = fullPath.split('/');
        const itemName = parts.pop() || '';
        const namespace = parts.join('/');
        return this.getItemsByType(type).find((item) => item.name === itemName && item.modulePath.join('/') === namespace);
    }

    public getItemsByType(type: VuexItemType): VuexAnyItem[] {
        const storeMap = this.getStoreMap();
        if (!storeMap) return [];
        if (type === 'state') return storeMap.state;
        if (type === 'getter') return storeMap.getters;
        if (type === 'mutation') return storeMap.mutations;
        return storeMap.actions;
    }

    public getItemsByTypeAndNamespace(type: VuexItemType, namespace: string): VuexAnyItem[] {
        const byIndex = this.itemIndexByTypeNamespace.get(this.makeTypeNamespaceKey(type, namespace));
        if (byIndex && byIndex.length > 0) return byIndex;
        return this.getItemsByType(type).filter((item) => item.modulePath.join('/') === namespace);
    }

    public getModuleDefinition(namespace: string): CoreLocation | undefined {
        const byIndex = this.moduleDefinitionIndex.get(namespace);
        if (byIndex) return byIndex;

        const allItems = [
            ...this.getItemsByType('state'),
            ...this.getItemsByType('getter'),
            ...this.getItemsByType('mutation'),
            ...this.getItemsByType('action'),
        ];
        const moduleItem = allItems.find((item) => item.modulePath.join('/') === namespace);
        return moduleItem?.defLocation;
    }

    public getAllModuleNames(): string[] {
        if (this.moduleNames.size > 0) {
            return Array.from(this.moduleNames);
        }

        const names = new Set<string>();
        const allItems = [
            ...this.getItemsByType('state'),
            ...this.getItemsByType('getter'),
            ...this.getItemsByType('mutation'),
            ...this.getItemsByType('action'),
        ];
        for (const item of allItems) {
            const ns = item.modulePath.join('/');
            if (ns) names.add(ns);
        }
        return Array.from(names);
    }

    public getDuplicateGlobalGetterConflicts(): VuexGlobalGetterConflict[] {
        return this.duplicateGlobalGetterConflicts.map((conflict) => ({
            name: conflict.name,
            items: [...conflict.items],
        }));
    }

    // Helpers to find specific items
    // NOTE: This assumes 'namespaced: true' for all modules for simplicity in path construction
    // In a real robust app, we'd check the 'namespaced' flag for each level.
    // Here we implicitly joined namespaces in StoreParser.
    
    public getMutation(name: string): VuexMutationInfo | undefined {
        const exactByPath = this.getIndexedItemByFullPath('mutation', name);
        if (exactByPath) return exactByPath as VuexMutationInfo;
        return this.storeMap?.mutations.find((item) => item.name === name);
    }

    public getAction(name: string): VuexActionInfo | undefined {
        const exactByPath = this.getIndexedItemByFullPath('action', name);
        if (exactByPath) return exactByPath as VuexActionInfo;
        return this.storeMap?.actions.find((item) => item.name === name);
    }

    // ... getters, state

    public getNamespace(filePath: string): string[] | undefined {
        return this.storeParser.getNamespace(filePath);
    }

    public getAssetNamespace(filePath: string): string[] | undefined {
        return this.storeParser.getAssetNamespace(filePath);
    }
}
