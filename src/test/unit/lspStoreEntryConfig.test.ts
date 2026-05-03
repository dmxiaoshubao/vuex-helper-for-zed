import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EntryAnalyzer } from '../../services/EntryAnalyzer';
import { LspVuexWorkspace } from '../../lsp/indexing';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

describe('LSP storeEntry configuration', () => {
    beforeEach(() => {
        (vscode.workspace as any).setConfiguration?.('vuexHelper', {});
    });

    it('should resolve configured storeEntry when auto detection cannot find an entry file', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-entry-'));
        const storeEntry = path.join(workspaceRoot, 'config', 'custom-store.js');
        writeFile(storeEntry, `
            export default {
                state: {
                    configuredOnly: true
                }
            }
        `);
        (vscode.workspace as any).setConfiguration('vuexHelper', { storeEntry: 'config/custom-store.js' });

        const analyzer = new EntryAnalyzer(workspaceRoot);
        const resolved = await analyzer.analyze({ interactive: false, forceRefresh: true });

        assert.strictEqual(resolved, storeEntry);
    });

    it('should reindex with a new storeEntry after configuration changes', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-config-change-'));
        const firstStore = path.join(workspaceRoot, 'stores', 'first.js');
        const secondStore = path.join(workspaceRoot, 'stores', 'second.js');
        writeFile(firstStore, `
            import Vuex from 'vuex';
            export default new Vuex.Store({ state: { firstOnly: true } });
        `);
        writeFile(secondStore, `
            import Vuex from 'vuex';
            export default new Vuex.Store({ state: { secondOnly: true } });
        `);

        const workspace = new LspVuexWorkspace(workspaceRoot, { storeEntry: 'stores/first.js' });
        await workspace.index();
        const firstMap = workspace.storeIndexer.getStoreMap();
        assert.ok(firstMap?.state.some((item) => item.name === 'firstOnly'));
        assert.ok(!firstMap?.state.some((item) => item.name === 'secondOnly'));

        await workspace.updateConfiguration({ storeEntry: 'stores/second.js' });

        const secondMap = workspace.storeIndexer.getStoreMap();
        assert.ok(!secondMap?.state.some((item) => item.name === 'firstOnly'));
        assert.ok(secondMap?.state.some((item) => item.name === 'secondOnly'));
        workspace.dispose();
    });
});
