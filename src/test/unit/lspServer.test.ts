import * as assert from 'assert';
import * as fs from 'fs';
import * as JSON5 from 'json5';
import * as os from 'os';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

describe('LSP server', () => {
    it('should start over stdio and respond to initialize', async () => {
        const client = startServer();
        const workspaceRoot = path.resolve(__dirname, '../../../test/fixtures/simple-project');

        const response = await client.request(1, 'initialize', {
            processId: process.pid,
            rootUri: fileUri(workspaceRoot),
            capabilities: {
                workspace: {
                    didChangeWatchedFiles: {
                        dynamicRegistration: true,
                    },
                },
            },
            workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'simple-project' }],
        });

        const registration = await client.waitForRequest('client/registerCapability', () => {
            client.notify('initialized', {});
        });

        client.shutdown();

        assert.strictEqual(response.id, 1);
        assert.strictEqual(response.result.capabilities.definitionProvider, true);
        assert.strictEqual(response.result.capabilities.hoverProvider, true);
        assert.ok(response.result.capabilities.completionProvider);
        assert.deepStrictEqual(response.result.capabilities.executeCommandProvider, {
            commands: ['vuexHelper.reindex'],
        });
        assert.strictEqual(registration.message.method, 'client/registerCapability');
        assert.strictEqual(registration.message.params.registrations[0].method, 'workspace/didChangeWatchedFiles');
    });

    it('should prompt once and create Zed settings template when store entry is missing', async () => {
        const client = startServer();
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-missing-entry-'));

        await client.request(1, 'initialize', {
            processId: process.pid,
            rootUri: fileUri(workspaceRoot),
            capabilities: {},
            workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'missing-entry-project' }],
        });

        const prompt = await client.waitForRequest('window/showMessageRequest', () => undefined);
        assert.strictEqual(
            prompt.message.params.message,
            'Vuex Helper: Could not find Vuex store entry automatically. Add vuexHelper.storeEntry to .zed/settings.json.',
        );
        client.respond(prompt.message.id, { title: 'Add Store Entry Setting' });

        const settingsPath = path.join(workspaceRoot, '.zed', 'settings.json');
        await waitForSettingsStoreEntry(settingsPath);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.deepStrictEqual(settings, {
            lsp: {
                'vuex-helper': {
                    settings: {
                        storeEntry: '',
                    },
                },
            },
        });

        client.shutdown();
    });

    it('should add missing store entry to an existing Zed settings file', async () => {
        const client = startServer();
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-existing-settings-'));
        const settingsDir = path.join(workspaceRoot, '.zed');
        const settingsPath = path.join(settingsDir, 'settings.json');
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(settingsPath, `{
  // Existing Zed settings can use JSONC-style syntax.
  "theme": "Ayu Dark",
  "lsp": {
    "vuex-helper": {
      "settings": {
        "serverPath": "/tmp/vuex-helper/out/lsp/server.js",
      },
    },
  },
}\n`);

        await client.request(1, 'initialize', {
            processId: process.pid,
            rootUri: fileUri(workspaceRoot),
            capabilities: {},
            workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'existing-settings-project' }],
        });

        const prompt = await client.waitForRequest('window/showMessageRequest', () => undefined);
        client.respond(prompt.message.id, { title: 'Add Store Entry Setting' });

        await waitForSettingsStoreEntry(settingsPath);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.strictEqual(settings.theme, 'Ayu Dark');
        assert.strictEqual(settings.lsp['vuex-helper'].settings.serverPath, '/tmp/vuex-helper/out/lsp/server.js');
        assert.strictEqual(settings.lsp['vuex-helper'].settings.storeEntry, '');

        client.shutdown();
    });

    it('should not prompt again after a configuration refresh', async () => {
        const client = startServer();
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-helper-zed-single-prompt-'));

        await client.request(1, 'initialize', {
            processId: process.pid,
            rootUri: fileUri(workspaceRoot),
            capabilities: {},
            workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'single-prompt-project' }],
        });

        const prompt = await client.waitForRequest('window/showMessageRequest', () => undefined);
        client.respond(prompt.message.id, { title: 'Add Store Entry Setting' });
        await waitForSettingsStoreEntry(path.join(workspaceRoot, '.zed', 'settings.json'));

        await client.waitForNoRequest('window/showMessageRequest', () => {
            client.notify('workspace/didChangeConfiguration', {
                settings: {
                    vuexHelper: {},
                },
            });
        });

        client.shutdown();
    });

    it('should execute manual reindex command', async () => {
        const client = startServer();
        const workspaceRoot = path.resolve(__dirname, '../../../test/fixtures/simple-project');

        await client.request(1, 'initialize', {
            processId: process.pid,
            rootUri: fileUri(workspaceRoot),
            capabilities: {},
            workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'simple-project' }],
        });

        const response = await client.request(2, 'workspace/executeCommand', {
            command: 'vuexHelper.reindex',
        });

        client.shutdown();

        assert.strictEqual(response.id, 2);
        assert.strictEqual(response.error, undefined);
    });
});

function startServer(): LspTestClient {
    const serverPath = path.resolve(__dirname, '../../lsp/server.js');
    const child = spawn(process.execPath, [serverPath, '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new LspTestClient(child);
}

class LspTestClient {
    private stdout = '';
    private stderr = '';

    constructor(private child: ChildProcessWithoutNullStreams) {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            this.stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            this.stderr += chunk;
        });
    }

    request(id: number, method: string, params: unknown): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.child.kill();
                reject(new Error(`LSP ${method} timed out. stderr: ${this.stderr}`));
            }, 5000);

            const onData = () => {
                let parsed: { message: any; endOffset: number } | undefined;
                while ((parsed = readMessage(this.stdout))) {
                    this.stdout = this.stdout.slice(parsed.endOffset);
                    if (parsed.message.id !== id) continue;
                    cleanup();
                    resolve(parsed.message);
                    return;
                }
            };

            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.child.stdout.off('data', onData);
                this.child.off('error', onError);
            };

            this.child.stdout.on('data', onData);
            this.child.on('error', onError);
            sendMessage(this.child.stdin, { jsonrpc: '2.0', id, method, params });
        });
    }

    respond(id: number, result: unknown): void {
        sendMessage(this.child.stdin, { jsonrpc: '2.0', id, result });
    }

    notify(method: string, params: unknown): void {
        sendMessage(this.child.stdin, { jsonrpc: '2.0', method, params });
    }

    waitForRequest(method: string, trigger: () => void): Promise<{ message: any }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.child.kill();
                reject(new Error(`LSP ${method} timed out. stderr: ${this.stderr}`));
            }, 5000);

            const onData = () => {
                let parsed: { message: any; endOffset: number } | undefined;
                while ((parsed = readMessage(this.stdout))) {
                    this.stdout = this.stdout.slice(parsed.endOffset);
                    if (parsed.message.method !== method) continue;
                    cleanup();
                    resolve({ message: parsed.message });
                    return;
                }
            };

            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.child.stdout.off('data', onData);
                this.child.off('error', onError);
            };

            this.child.stdout.on('data', onData);
            this.child.on('error', onError);
            trigger();
        });
    }

    waitForNoRequest(method: string, trigger: () => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, 300);

            const onData = () => {
                let parsed: { message: any; endOffset: number } | undefined;
                while ((parsed = readMessage(this.stdout))) {
                    this.stdout = this.stdout.slice(parsed.endOffset);
                    if (parsed.message.method !== method) continue;
                    cleanup();
                    reject(new Error(`Unexpected LSP ${method} request. stderr: ${this.stderr}`));
                    return;
                }
            };

            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };

            const cleanup = () => {
                clearTimeout(timer);
                this.child.stdout.off('data', onData);
                this.child.off('error', onError);
            };

            this.child.stdout.on('data', onData);
            this.child.on('error', onError);
            trigger();
        });
    }

    shutdown(): void {
        sendMessage(this.child.stdin, { jsonrpc: '2.0', id: 9999, method: 'shutdown' });
        sendMessage(this.child.stdin, { jsonrpc: '2.0', method: 'exit' });
        this.child.kill();
    }
}

function sendMessage(stdin: NodeJS.WritableStream, message: unknown): void {
    const body = JSON.stringify(message);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function readMessage(buffer: string): { message: any; endOffset: number } | undefined {
    const separator = '\r\n\r\n';
    const headerEnd = buffer.indexOf(separator);
    if (headerEnd < 0) return undefined;

    const header = buffer.slice(0, headerEnd);
    const lengthMatch = /Content-Length: (\d+)/i.exec(header);
    if (!lengthMatch) return undefined;

    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + separator.length;
    const bodyEnd = bodyStart + length;
    if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < length) return undefined;

    return { message: JSON.parse(buffer.slice(bodyStart, bodyEnd)), endOffset: bodyEnd };
}

function waitForSettingsStoreEntry(settingsPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON5.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.lsp?.['vuex-helper']?.settings?.storeEntry === '') {
                    resolve();
                    return;
                }
            }
            if (Date.now() - startedAt > 1000) {
                reject(new Error(`Timed out waiting for storeEntry in ${settingsPath}`));
                return;
            }
            setTimeout(check, 10);
        };
        check();
    });
}

function fileUri(filePath: string): string {
    return `file://${filePath}`;
}
