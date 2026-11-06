use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn send(app: &AppHandle, title: &str, body: &str) {
    let r = app.notification().builder().title(title).body(body).sound("default").show();
    if let Err(e) = r {
        log::warn!("notification failed: {e}");
    }
}
