import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LspVuexWorkspace } from '../../lsp/indexing';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

describe('LSP watched files reindex', () => {
    beforeEach(() => {
        (vscode.workspace as any).setConfiguration?.('vuexHelper', {});
    });

    it('should reindex when a watched store file changes', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-watch-'));
        writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
            dependencies: {
                vue: '^2.7.0',
                vuex: '^3.6.2',
            },
        }, null, 2));
        const storeEntry = path.join(workspaceRoot, 'src', 'store', 'index.js');
        writeFile(storeEntry, `
            import Vuex from 'vuex';
            export default new Vuex.Store({ state: { beforeChange: true } });
        `);

        const workspace = new LspVuexWorkspace(workspaceRoot, { storeEntry: 'src/store/index.js' });
        await workspace.index();
        const beforeMap = workspace.storeIndexer.getStoreMap();
        assert.ok(beforeMap?.state.some((item) => item.name === 'beforeChange'));
        assert.ok(!beforeMap?.state.some((item) => item.name === 'afterChange'));

        writeFile(storeEntry, `
            import Vuex from 'vuex';
            export default new Vuex.Store({ state: { afterChange: true } });
        `);

        assert.strictEqual(workspace.shouldReindexForFile(storeEntry), true);
        await workspace.index([storeEntry]);

        const afterMap = workspace.storeIndexer.getStoreMap();
        assert.ok(!afterMap?.state.some((item) => item.name === 'beforeChange'));
        assert.ok(afterMap?.state.some((item) => item.name === 'afterChange'));
        workspace.dispose();
    });
});
