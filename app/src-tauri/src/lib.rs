//! Entry Desktop — Tauri 2 shell.
//! Rust stays thin: window + sidecar lifecycle + native pickers.
//! All agent logic lives in the sidecar; all UI logic in the webview.

use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

struct SidecarStdin(Mutex<Option<std::process::ChildStdin>>);

#[tauri::command]
fn sidecar_stdin(line: String, state: tauri::State<SidecarStdin>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(stdin) => {
            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err("sidecar is not running".into()),
    }
}

#[tauri::command]
fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose workspace folder")
        .blocking_pick_folder()
        .map(|path| {
            let s = path.to_string();
            tx.send(Some(s)).ok();
        });
    Ok(rx.recv().ok().flatten())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Bridge consumed by the React app (see src/lib/bridge.ts).
            let api_base = "https://entry-agents.dev";
            let init = format!(
                r#"window.desktop = {{
                  apiBaseUrl: '{api_base}',
                  getVersion: () => window.__TAURI__.core.invoke('app_version'),
                  openExternal: (u) => window.__TAURI__.core.invoke('open_external', {{ url: u }}),
                  pickDirectory: () => window.__TAURI__.core.invoke('pick_directory'),
                  rpc: (method, params) => window.__TAURI__.core.invoke('sidecar_stdin', {{ line: JSON.stringify({{ id: crypto.randomUUID(), method, params: params ?? {{}} }}) }}),
                  onEvent: (cb) => window.__TAURI__.event.listen('sidecar-line', (e) => cb(e.payload)),
                }};"#
            );
            app.webview_windows().values().for_each(|w| w.eval(&init).ok());
            if let Some(w) = app.get_webview_window("main") {
                w.eval(&init).ok();
            }

            // Spawn the agent sidecar and relay every stdout line as an event.
            let handle = app.handle().clone();
            let sidecar = app.shell().sidecar("agent-sidecar").map_err(|e| e.to_string())?;
            let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;
            let stdin = child.stdin.ok_or("sidecar has no stdin")?;
            app.manage(SidecarStdin(Mutex::new(Some(stdin))));
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        handle.emit("sidecar-line", String::from_utf8_lossy(&line).to_string()).ok();
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Entry Desktop");
}
