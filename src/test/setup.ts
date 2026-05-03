import mock = require('mock-require');

const lspVscodeShim = require('../lsp/vscode-shim');

mock('vscode', lspVscodeShim);

after(() => {
    mock.stop('vscode');
});
