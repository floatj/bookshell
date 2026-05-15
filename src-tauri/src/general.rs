use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SideTabBarMode {
    Split,
    Hover,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralSettings {
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_side_font_size")]
    pub side_font_size: u32,
    /// Git view auto-refresh polling interval in seconds (SSH sessions).
    #[serde(default = "default_git_poll_secs")]
    pub git_poll_secs: u32,
    /// App-wide default shell for new Local connections / side terminal when a
    /// connection has no shell of its own. None falls back to the platform
    /// default (powershell.exe on Windows, $SHELL or /bin/bash elsewhere).
    #[serde(default)]
    pub default_shell: Option<String>,
    /// Whether the left tab bar reserves layout space or floats over the app.
    #[serde(default = "default_side_tab_bar_mode")]
    pub side_tab_bar_mode: SideTabBarMode,
    /// Hide the left tab bar until the pointer enters the left trigger strip.
    #[serde(default = "default_side_tab_bar_auto_hide")]
    pub side_tab_bar_auto_hide: bool,
    /// Width of the left tab bar in CSS pixels.
    #[serde(default = "default_side_tab_bar_width")]
    pub side_tab_bar_width: u32,
    /// Show a hover preview popover with a thumbnail of the tab's terminal
    /// viewport when the pointer lingers over a tab in the side bar.
    #[serde(default = "default_side_tab_bar_preview")]
    pub side_tab_bar_preview: bool,
    /// Enable translucent acrylic background. Requires OS-level window effects
    /// (acrylic on Windows, vibrancy on macOS); the frontend additionally
    /// drives surface alpha via a CSS variable.
    #[serde(default = "default_acrylic_enabled")]
    pub acrylic_enabled: bool,
    /// Opacity of the app's primary background surfaces when acrylic is on.
    /// Clamped to [0.3, 1.0]; 1.0 is fully opaque (acrylic effect invisible).
    #[serde(default = "default_acrylic_opacity")]
    pub acrylic_opacity: f32,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            scrollback: default_scrollback(),
            font_size: default_font_size(),
            side_font_size: default_side_font_size(),
            git_poll_secs: default_git_poll_secs(),
            default_shell: None,
            side_tab_bar_mode: default_side_tab_bar_mode(),
            side_tab_bar_auto_hide: default_side_tab_bar_auto_hide(),
            side_tab_bar_width: default_side_tab_bar_width(),
            side_tab_bar_preview: default_side_tab_bar_preview(),
            acrylic_enabled: default_acrylic_enabled(),
            acrylic_opacity: default_acrylic_opacity(),
        }
    }
}

fn default_scrollback() -> u32 {
    10000
}
fn default_font_size() -> u32 {
    14
}
fn default_side_font_size() -> u32 {
    14
}
fn default_git_poll_secs() -> u32 {
    5
}
fn default_side_tab_bar_mode() -> SideTabBarMode {
    SideTabBarMode::Split
}
fn default_side_tab_bar_auto_hide() -> bool {
    false
}
fn default_side_tab_bar_width() -> u32 {
    190
}
fn default_side_tab_bar_preview() -> bool {
    true
}
fn default_acrylic_enabled() -> bool {
    false
}
fn default_acrylic_opacity() -> f32 {
    0.75
}

pub fn general_path() -> PathBuf {
    config_dir().join("general.toml")
}

pub fn load_general() -> GeneralSettings {
    let path = general_path();
    if !path.exists() {
        return GeneralSettings::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| toml::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_general(settings: &GeneralSettings) -> Result<(), String> {
    let path = general_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let text = toml::to_string_pretty(settings).map_err(|e| format!("serialize: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(())
}

#[tauri::command]
pub async fn general_get() -> Result<GeneralSettings, String> {
    Ok(load_general())
}

#[tauri::command]
pub async fn general_set(settings: GeneralSettings) -> Result<(), String> {
    save_general(&settings)
}
