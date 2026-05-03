use std::path::PathBuf;
use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct VuexHelperExtension;

impl zed::Extension for VuexHelperExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let server_path = configured_server_path(worktree).unwrap_or_else(|| {
            PathBuf::from(worktree.root_path())
                .join("out")
                .join("lsp")
                .join("server.js")
                .to_string_lossy()
                .into_owned()
        });

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![server_path, "--stdio".into()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(configured_vuex_helper_settings(worktree))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(configured_vuex_helper_settings(worktree))
    }
}

fn configured_server_path(worktree: &Worktree) -> Option<String> {
    let settings = zed::settings::LspSettings::for_worktree("vuex-helper", worktree).ok()?;
    settings
        .settings
        .as_ref()
        .and_then(|settings| settings.get("serverPath"))
        .and_then(|server_path| server_path.as_str())
        .filter(|server_path| !server_path.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn configured_vuex_helper_settings(worktree: &Worktree) -> Option<zed::serde_json::Value> {
    let settings = zed::settings::LspSettings::for_worktree("vuex-helper", worktree).ok()?;
    let store_entry = settings
        .settings
        .as_ref()
        .and_then(|settings| settings.get("storeEntry"))
        .and_then(|store_entry| store_entry.as_str())
        .filter(|store_entry| !store_entry.trim().is_empty())?;

    Some(zed::serde_json::json!({
        "vuexHelper": {
            "storeEntry": store_entry,
        }
    }))
}

zed::register_extension!(VuexHelperExtension);
