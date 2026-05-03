import mock = require('mock-require');

const vscodeMock = require('./unit/vscode-mock');

// Register a single vscode runtime mock for all unit tests.
mock('vscode', vscodeMock);

after(() => {
    mock.stop('vscode');
});
