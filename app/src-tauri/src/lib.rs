//! Entry Agents — Tauri 2 shell.
//! Rust stays thin: window + sidecar lifecycle + native pickers.
//! All agent logic lives in the sidecar; all UI logic in the webview.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarChild(Mutex<Option<CommandChild>>);

#[tauri::command]
fn sidecar_stdin(line: String, state: tauri::State<SidecarChild>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(child) => child
            .write(format!("{line}\n").as_bytes())
            .map_err(|e| e.to_string()),
        None => Err("sidecar is not running".into()),
    }
}

#[tauri::command]
fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Choose workspace folder")
        .blocking_pick_folder()
        .map(|path| path.to_string());
    Ok(picked)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

const BRIDGE_JS: &str = r#"
window.desktop = {
  apiBaseUrl: 'https://entry-agents.dev',
  getVersion: () => window.__TAURI__.core.invoke('app_version'),
  openExternal: (u) => window.__TAURI__.core.invoke('open_external', { url: u }),
  pickDirectory: () => window.__TAURI__.core.invoke('pick_directory'),
  rpc: (method, params) => window.__TAURI__.core.invoke('sidecar_stdin', { line: JSON.stringify({ id: crypto.randomUUID(), method, params: params ?? {} }) }),
  onEvent: (cb) => window.__TAURI__.event.listen('sidecar-line', (e) => cb(e.payload)),
};
window.dispatchEvent(new Event('entry-bridge-ready'));
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .on_page_load(|webview, _payload| {
            // Runs after the page (and Tauri's own injection) is ready —
            // deterministic place to define the bridge.
            let _ = webview.eval(BRIDGE_JS);
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                // Belt-and-braces: also try immediately (page may already be up).
                let _ = w.eval(BRIDGE_JS);
            }

            // Spawn the agent sidecar and relay every stdout line as an event.
            let handle = app.handle().clone();
            let sidecar = app.shell().sidecar("agent-sidecar").map_err(|e| e.to_string())?;
            let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;
            app.manage(SidecarChild(Mutex::new(Some(child))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        handle
                            .emit("sidecar-line", String::from_utf8_lossy(&line).to_string())
                            .ok();
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Entry Agents");
}
