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
}

fn configured_server_path(worktree: &Worktree) -> Option<String> {
    let settings = zed::settings::LspSettings::for_worktree("vuex-helper", worktree).ok()?;
    let value = zed::serde_json::to_value(settings).ok()?;
    value
        .get("settings")
        .and_then(|settings| settings.get("serverPath"))
        .and_then(|server_path| server_path.as_str())
        .filter(|server_path| !server_path.trim().is_empty())
        .map(ToOwned::to_owned)
}

zed::register_extension!(VuexHelperExtension);
