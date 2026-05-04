# Vuex Helper for Zed Extension

This directory contains the Zed extension shell for Vuex Helper for Zed.

The extension installs and starts the Vuex Helper language server, then provides Vuex-related editor features in Zed.

## Features

- Go to Definition
- Code Completion
- Hover Information
- Diagnostics

## Requirements

- Zed editor.
- A Vue 2 project using Vuex 2.
- Node.js support provided by Zed for running the language server.

## Configuration

The extension installs `@dmxiaoshubao/vuex-helper-lsp` automatically. The first install requires access to the npm registry.

If the Vuex store entry cannot be discovered automatically, configure the target project's `.zed/settings.json`:

```json
{
  "lsp": {
    "vuex-helper": {
      "settings": {
        "storeEntry": "src/store/index.js"
      }
    }
  }
}
```

## Local Development

For local extension development, `lsp.vuex-helper.settings.serverPath` can override the automatically installed language server path.

## Current Scope

This extension focuses on Vuex State, Getters, Mutations, and Actions support through the language server.

## Not Included Yet

- Rename
- References
- Workspace Symbol
- Code Action
- Zed-specific configuration UI
