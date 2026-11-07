pub mod api;
mod commands;
pub mod heatmap;
pub mod market;
pub mod monitor;
mod notify;
pub mod price;
pub mod regions;
pub mod servers;
pub mod serverstat;
pub mod ssh;
pub mod sshconfig;
pub mod terminal;
mod secret;
pub mod store;
mod tray;

use std::sync::Arc;
use tauri::{Manager, WindowEvent};

pub struct AppState {
    pub store: Arc<store::Store>,
    pub monitor: Arc<monitor::Monitor>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = dir.join("autodl-lookout.sqlite3");
            migrate_legacy_db(&dir, &db);
            let store = Arc::new(store::Store::open(&db).map_err(anyhow_like)?);
            let token = secret::load(&store, secret::Kind::Dev);
            let web_token = secret::load(&store, secret::Kind::Web);
            let monitor = monitor::Monitor::new(store.clone(), token, web_token);
            app.manage(AppState { store, monitor: monitor.clone() });

            tray::build(app.handle())?;
            monitor.spawn(app.handle().clone());
            monitor.spawn_server_watch(app.handle().clone());

            // 开机自启时带 --minimized，直接藏到托盘
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 最小化到托盘，监控继续跑
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_token,
            commands::clear_token,
            commands::set_web_token,
            commands::clear_web_token,
            commands::get_snapshot,
            commands::refresh_now,
            commands::set_paused,
            commands::ref_data,
            commands::query_stock,
            commands::stock_history,
            commands::stock_heatmap,
            commands::history_gpus,
            commands::get_balance,
            commands::get_settings,
            commands::save_settings,
            commands::list_rules,
            commands::save_rule,
            commands::delete_rule,
            commands::list_templates,
            commands::save_template,
            commands::delete_template,
            commands::create_from_template,
            commands::gpu_prices,
            commands::base_images,
            commands::rent_instance,
            commands::list_servers,
            commands::save_server,
            commands::delete_server,
            commands::ssh_config_hosts,
            commands::import_ssh_hosts,
            commands::sync_ssh_config,
            commands::set_ssh_auto_sync,
            commands::open_terminal,
            commands::open_vscode,
            commands::server_password,
            commands::test_server,
            commands::ensure_ssh_key,
            commands::push_ssh_key,
            commands::trust_host_key,
            commands::server_status,
            commands::get_server_watch,
            commands::save_server_watch,
            commands::list_regular_instances,
            commands::regular_instance_password,
            commands::regular_power_on,
            commands::regular_power_off,
            commands::list_instances,
            commands::instance_snapshot,
            commands::instance_status,
            commands::power_on,
            commands::power_off,
            commands::release_instance,
            commands::save_image,
            commands::list_images,
            commands::list_logs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS：点 Dock 图标时重新显示窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
            let _ = (app, event);
        });
}

/// 改名前的数据在 …/dev.local.autodl-manager/autodl-manager.sqlite3，新库不存在时复制过来（旧文件保留不动）
fn migrate_legacy_db(dir: &std::path::Path, db: &std::path::Path) {
    if db.exists() {
        return;
    }
    let Some(parent) = dir.parent() else { return };
    let old_dir = parent.join("dev.local.autodl-manager");
    let old_db = old_dir.join("autodl-manager.sqlite3");
    if !old_db.exists() {
        return;
    }
    if std::fs::copy(&old_db, db).is_ok() {
        for ext in ["-wal", "-shm"] {
            let src = old_dir.join(format!("autodl-manager.sqlite3{ext}"));
            if src.exists() {
                let _ = std::fs::copy(&src, dir.join(format!("autodl-lookout.sqlite3{ext}")));
            }
        }
        log::info!("migrated data from {}", old_db.display());
    }
}

fn anyhow_like(e: String) -> Box<dyn std::error::Error> {
    e.into()
}

#[cfg(test)]
mod tests {
    use super::migrate_legacy_db;

    #[test]
    fn copies_legacy_db_once() {
        let root = std::env::temp_dir().join(format!("lookout-mig-{}", std::process::id()));
        let old = root.join("dev.local.autodl-manager");
        let new = root.join("dev.local.autodl-lookout");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("autodl-manager.sqlite3"), b"old-db").unwrap();
        std::fs::write(old.join("autodl-manager.sqlite3-wal"), b"wal").unwrap();
        let db = new.join("autodl-lookout.sqlite3");
        migrate_legacy_db(&new, &db);
        assert_eq!(std::fs::read(&db).unwrap(), b"old-db");
        assert_eq!(std::fs::read(new.join("autodl-lookout.sqlite3-wal")).unwrap(), b"wal");
        assert!(old.join("autodl-manager.sqlite3").exists(), "legacy file is kept");
        // 新库已存在时不覆盖
        std::fs::write(&db, b"new-db").unwrap();
        migrate_legacy_db(&new, &db);
        assert_eq!(std::fs::read(&db).unwrap(), b"new-db");
        let _ = std::fs::remove_dir_all(&root);
    }
}
