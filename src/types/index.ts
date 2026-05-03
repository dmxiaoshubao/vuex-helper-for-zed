import { CoreLocation } from '../core/types';

export interface VuexStateInfo {
    name: string;
    defLocation: CoreLocation;
    modulePath: string[];
    documentation?: string;
    displayType?: string; // e.g. "string", "number", "Array", "Object"
}

export interface VuexGetterInfo {
    name: string;
    defLocation: CoreLocation;
    modulePath: string[];
    documentation?: string;
}

export interface VuexMutationInfo {
    name: string;
    defLocation: CoreLocation;
    modulePath: string[];
    documentation?: string;
}

export interface VuexActionInfo {
    name: string;
    defLocation: CoreLocation;
    modulePath: string[];
    documentation?: string;
}

export interface VuexStoreMap {
    state: VuexStateInfo[];
    getters: VuexGetterInfo[];
    mutations: VuexMutationInfo[];
    actions: VuexActionInfo[];
}
