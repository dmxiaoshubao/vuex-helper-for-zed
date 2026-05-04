use std::{env, path::PathBuf};
use zed_extension_api::{
    self as zed, Command, LanguageServerId, LanguageServerInstallationStatus, Result, Worktree,
};

const SERVER_PACKAGE_NAME: &str = "@dmxiaoshubao/vuex-helper-lsp";
const SERVER_PACKAGE_VERSION: &str = "0.1.0";
const SERVER_PATH_IN_PACKAGE: &[&str] = &["out", "lsp", "server.js"];

struct VuexHelperExtension;

impl zed::Extension for VuexHelperExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let server_path = match configured_server_path(worktree) {
            Some(server_path) => server_path,
            None => installed_server_path(language_server_id)?,
        };

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

fn installed_server_path(language_server_id: &LanguageServerId) -> Result<String> {
    let installed_version = zed::npm_package_installed_version(SERVER_PACKAGE_NAME)?;

    if installed_version.as_deref() != Some(SERVER_PACKAGE_VERSION) {
        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        zed::npm_install_package(SERVER_PACKAGE_NAME, SERVER_PACKAGE_VERSION).map_err(|error| {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Failed(error.clone()),
            );
            error
        })?;
        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
    }

    Ok(installed_package_path()?
        .join(SERVER_PATH_IN_PACKAGE.iter().collect::<PathBuf>())
        .to_string_lossy()
        .into_owned())
}

fn installed_package_path() -> Result<PathBuf> {
    Ok(env::current_dir()
        .map_err(|error| error.to_string())?
        .join("node_modules")
        .join(SERVER_PACKAGE_NAME))
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
