use crate::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main-tray";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即刷新库存", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停 / 恢复监控", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &pause, &sep, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("AutoDL Lookout")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "refresh" => app.state::<AppState>().monitor.trigger(),
            "pause" => {
                let m = &app.state::<AppState>().monitor;
                m.set_paused(!m.snapshot().paused);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 托盘上显示当前命中的规则数（macOS 菜单栏会显示文字，Windows 显示在提示里）
pub fn set_hits(app: &AppHandle, hits: usize) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tip = if hits > 0 { format!("AutoDL Lookout · {hits} 条规则有卡") } else { "AutoDL Lookout · 暂无可用".into() };
        let _ = tray.set_tooltip(Some(tip));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(if hits > 0 { Some(format!("{hits}")) } else { None::<String> });
    }
}
