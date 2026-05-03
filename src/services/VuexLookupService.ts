import { StoreIndexer } from './StoreIndexer';
import { VuexAnyItem } from './StoreIndexer';
import { buildLookupCandidates, VuexItemType } from '../utils/VuexProviderUtils';

type ProviderItemType = 'state' | 'getter' | 'mutation' | 'action';

interface FindItemOptions {
    name: string;
    type: ProviderItemType;
    namespace?: string;
    currentNamespace?: string[];
    preferLocal?: boolean;
    allowRootFallback?: boolean;
}

export class VuexLookupService {
    constructor(private readonly storeIndexer: StoreIndexer) {}

    public findItem(options: FindItemOptions): VuexAnyItem | undefined {
        const lookups = buildLookupCandidates(
            options.name,
            options.type,
            options.namespace,
            options.currentNamespace
        );

        for (const lookup of lookups) {
            const found = this.findIndexedItem(
                options.type,
                lookup.name,
                lookup.namespace,
                options.currentNamespace,
                options.preferLocal !== false,
                options.allowRootFallback === true
            );
            if (found) return found;
        }
        return undefined;
    }

    private findIndexedItem(
        type: ProviderItemType,
        lookupName: string,
        lookupNamespace?: string,
        currentNamespace?: string[],
        preferLocal: boolean = true,
        allowRootFallback: boolean = false
    ): VuexAnyItem | undefined {
        const typed = this.toItemType(type);
        if (!typed) return undefined;

        if (lookupNamespace) {
            const exact = this.storeIndexer.getIndexedItem(typed, lookupName, lookupNamespace);
            if (exact) return exact;
        }

        if (preferLocal && currentNamespace && !lookupName.includes('/')) {
            const local = this.storeIndexer.getIndexedItem(typed, lookupName, currentNamespace.join('/'));
            if (local) return local;
        }

        if (allowRootFallback && !preferLocal && !lookupNamespace && !lookupName.includes('/')) {
            const root = this.storeIndexer.getIndexedItem(typed, lookupName, '');
            if (root) return root;
        }

        if (lookupName.includes('/')) {
            const byPath = this.storeIndexer.getIndexedItemByFullPath(typed, lookupName);
            if (byPath) return byPath;
        }

        if (lookupNamespace) {
            return undefined;
        }

        const allItems = this.storeIndexer.getItemsByType(typed);
        return allItems.find((item) => item.name === lookupName);
    }

    private toItemType(type: ProviderItemType): VuexItemType | undefined {
        if (type === 'state') return 'state';
        if (type === 'getter') return 'getter';
        if (type === 'mutation') return 'mutation';
        if (type === 'action') return 'action';
        return undefined;
    }
}
