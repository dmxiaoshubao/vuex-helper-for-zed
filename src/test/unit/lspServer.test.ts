import * as assert from 'assert';
import * as path from 'path';
import { spawn } from 'child_process';

describe('LSP server', () => {
    it('should start over stdio and respond to initialize', async () => {
        const serverPath = path.resolve(__dirname, '../../lsp/server.js');
        const workspaceRoot = path.resolve(__dirname, '../../../test/fixtures/simple-project');
        const child = spawn(process.execPath, [serverPath, '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const response = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`LSP initialize timed out. stderr: ${stderr}`));
            }, 5000);

            child.stdout.on('data', () => {
                const parsed = readMessage(stdout);
                if (!parsed) return;
                clearTimeout(timer);
                resolve(parsed.message);
            });

            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });

            sendMessage(child.stdin, {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    processId: process.pid,
                    rootUri: fileUri(workspaceRoot),
                    capabilities: {},
                    workspaceFolders: [{ uri: fileUri(workspaceRoot), name: 'simple-project' }],
                },
            });
        });

        sendMessage(child.stdin, { jsonrpc: '2.0', id: 2, method: 'shutdown' });
        sendMessage(child.stdin, { jsonrpc: '2.0', method: 'exit' });
        child.kill();

        assert.strictEqual(response.id, 1);
        assert.strictEqual(response.result.capabilities.definitionProvider, true);
        assert.strictEqual(response.result.capabilities.hoverProvider, true);
        assert.ok(response.result.capabilities.completionProvider);
    });
});

function sendMessage(stdin: NodeJS.WritableStream, message: unknown): void {
    const body = JSON.stringify(message);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function readMessage(buffer: string): { message: any } | undefined {
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

    return { message: JSON.parse(buffer.slice(bodyStart, bodyEnd)) };
}

function fileUri(filePath: string): string {
    return `file://${filePath}`;
}
