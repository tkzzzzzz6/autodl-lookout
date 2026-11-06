//! Local SQLite storage: settings, rules, templates, stock history, logs.

use crate::api::StockItem;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub poll_interval_secs: u64,
    pub regions: Vec<String>,
    pub low_balance_yuan: f64,
    pub long_running_hours: f64,
    /// 余额低于此值时，自动抢卡动作不会执行
    pub auto_min_balance_yuan: f64,
    pub history_keep_days: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_secs: 60,
            regions: vec!["westDC3".into(), "beijingDC2".into()],
            low_balance_yuan: 20.0,
            long_running_hours: 8.0,
            auto_min_balance_yuan: 10.0,
            history_keep_days: 14,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub region_sign: String,
    /// 卡型关键字，不区分大小写的子串匹配，如 "4090" 能匹配 "RTX 4090" / "RTX 4090D"
    pub gpu_keyword: String,
    pub min_idle: i64,
    pub cuda_v_from: Option<i64>,
    /// 每卡每小时价格上限（元），会作为库存查询的 price_to 过滤
    pub max_price_yuan: Option<f64>,
    pub cooldown_minutes: i64,
    /// "notify" | "create" | "power_on"
    pub action: String,
    pub template_id: Option<i64>,
    pub instance_uuid: Option<String>,
    pub daily_limit: i64,
    pub last_fired_at: Option<i64>,
    /// 单台机器至少空出几张卡才算（1 = 按区域总数，和以前一样）
    #[serde(default = "one")]
    pub min_per_machine: i64,
}

fn one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: i64,
    pub name: String,
    pub gpu_spec_uuid: String,
    pub gpu_amount: i64,
    pub data_center_list: Vec<String>,
    pub image_uuid: String,
    pub cuda_v_from: i64,
    pub expand_disk_gb: i64,
    pub instance_name: Option<String>,
    pub start_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: i64,
    pub ts: i64,
    pub level: String,
    pub kind: String,
    pub rule_id: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryPoint {
    pub ts: i64,
    pub idle: i64,
    pub total: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
}

type R<T> = Result<T, String>;

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

impl Store {
    pub fn open(path: &Path) -> R<Self> {
        let conn = Connection::open(path).map_err(e)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> R<Self> {
        Self::init(Connection::open_in_memory().map_err(e)?)
    }

    fn init(conn: Connection) -> R<Self> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, enabled INTEGER NOT NULL, region_sign TEXT NOT NULL,
                gpu_keyword TEXT NOT NULL, min_idle INTEGER NOT NULL, cuda_v_from INTEGER,
                max_price_yuan REAL, cooldown_minutes INTEGER NOT NULL, action TEXT NOT NULL,
                template_id INTEGER, instance_uuid TEXT, daily_limit INTEGER NOT NULL,
                last_fired_at INTEGER, min_per_machine INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, gpu_spec_uuid TEXT NOT NULL, gpu_amount INTEGER NOT NULL,
                data_center_list TEXT NOT NULL, image_uuid TEXT NOT NULL, cuda_v_from INTEGER NOT NULL,
                expand_disk_gb INTEGER NOT NULL, instance_name TEXT, start_command TEXT
            );
            CREATE TABLE IF NOT EXISTS stock_history (
                ts INTEGER NOT NULL, region TEXT NOT NULL, gpu_name TEXT NOT NULL,
                idle INTEGER NOT NULL, total INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_hist ON stock_history(region, gpu_name, ts);
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
                kind TEXT NOT NULL, rule_id INTEGER, message TEXT NOT NULL
            );
            "#,
        )
        .map_err(e)?;
        migrate(&conn)?;
        let s = Self { conn: Mutex::new(conn) };
        s.seed_defaults()?;
        Ok(s)
    }

    fn seed_defaults(&self) -> R<()> {
        if self.kv_get("seeded")?.is_some() {
            return Ok(());
        }
        for region in ["westDC3", "beijingDC2"] {
            for gpu in ["4090", "5090"] {
                self.save_rule(Rule {
                    id: 0,
                    name: format!("{} {}", crate::regions::region_name(region), gpu),
                    enabled: true,
                    region_sign: region.into(),
                    gpu_keyword: gpu.into(),
                    min_idle: 1,
                    cuda_v_from: None,
                    max_price_yuan: None,
                    cooldown_minutes: 15,
                    action: "notify".into(),
                    template_id: None,
                    instance_uuid: None,
                    daily_limit: 1,
                    last_fired_at: None,
                    min_per_machine: 1,
                })?;
            }
        }
        self.save_template(Template {
            id: 0,
            name: "4090D · PyTorch 2.0 / CUDA 11.8".into(),
            gpu_spec_uuid: "4090D".into(),
            gpu_amount: 1,
            data_center_list: vec![],
            image_uuid: "base-image-l2t43iu6uk".into(),
            cuda_v_from: 118,
            expand_disk_gb: 0,
            instance_name: Some("autodl-lookout".into()),
            start_command: None,
        })?;
        self.kv_set("seeded", "1")
    }

    // ---------- kv / settings ----------

    pub fn kv_get(&self, k: &str) -> R<Option<String>> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT v FROM kv WHERE k=?1", [k], |r| r.get(0)).optional().map_err(e)
    }

    pub fn kv_set(&self, k: &str, v: &str) -> R<()> {
        let c = self.conn.lock().unwrap();
        c.execute("INSERT INTO kv(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v])
            .map_err(e)?;
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        self.kv_get("settings")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, s: &Settings) -> R<()> {
        let mut s = s.clone();
        s.poll_interval_secs = s.poll_interval_secs.max(30);
        self.kv_set("settings", &serde_json::to_string(&s).map_err(|x| x.to_string())?)
    }

    // ---------- rules ----------

    pub fn rules(&self) -> R<Vec<Rule>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare(
                "SELECT id,name,enabled,region_sign,gpu_keyword,min_idle,cuda_v_from,max_price_yuan,
                 cooldown_minutes,action,template_id,instance_uuid,daily_limit,last_fired_at,min_per_machine
                 FROM rules ORDER BY id",
            )
            .map_err(e)?;
        let rows = st
            .query_map([], |r| {
                Ok(Rule {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    enabled: r.get::<_, i64>(2)? != 0,
                    region_sign: r.get(3)?,
                    gpu_keyword: r.get(4)?,
                    min_idle: r.get(5)?,
                    cuda_v_from: r.get(6)?,
                    max_price_yuan: r.get(7)?,
                    cooldown_minutes: r.get(8)?,
                    action: r.get(9)?,
                    template_id: r.get(10)?,
                    instance_uuid: r.get(11)?,
                    daily_limit: r.get(12)?,
                    last_fired_at: r.get(13)?,
                    min_per_machine: r.get(14)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn save_rule(&self, r: Rule) -> R<i64> {
        let c = self.conn.lock().unwrap();
        if r.id > 0 {
            c.execute(
                "UPDATE rules SET name=?1,enabled=?2,region_sign=?3,gpu_keyword=?4,min_idle=?5,cuda_v_from=?6,
                 max_price_yuan=?7,cooldown_minutes=?8,action=?9,template_id=?10,instance_uuid=?11,daily_limit=?12,
                 min_per_machine=?14 WHERE id=?13",
                params![
                    r.name, r.enabled as i64, r.region_sign, r.gpu_keyword, r.min_idle, r.cuda_v_from,
                    r.max_price_yuan, r.cooldown_minutes, r.action, r.template_id, r.instance_uuid,
                    r.daily_limit, r.id, r.min_per_machine.max(1)
                ],
            )
            .map_err(e)?;
            Ok(r.id)
        } else {
            c.execute(
                "INSERT INTO rules(name,enabled,region_sign,gpu_keyword,min_idle,cuda_v_from,max_price_yuan,
                 cooldown_minutes,action,template_id,instance_uuid,daily_limit,min_per_machine)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    r.name, r.enabled as i64, r.region_sign, r.gpu_keyword, r.min_idle, r.cuda_v_from,
                    r.max_price_yuan, r.cooldown_minutes, r.action, r.template_id, r.instance_uuid,
                    r.daily_limit, r.min_per_machine.max(1)
                ],
            )
            .map_err(e)?;
            Ok(c.last_insert_rowid())
        }
    }

    pub fn delete_rule(&self, id: i64) -> R<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM rules WHERE id=?1", [id]).map_err(e)?;
        Ok(())
    }

    pub fn mark_rule_fired(&self, id: i64, ts: i64) -> R<()> {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE rules SET last_fired_at=?1 WHERE id=?2", [ts, id]).map_err(e)?;
        Ok(())
    }

    // ---------- templates ----------

    pub fn templates(&self) -> R<Vec<Template>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare(
                "SELECT id,name,gpu_spec_uuid,gpu_amount,data_center_list,image_uuid,cuda_v_from,expand_disk_gb,
                 instance_name,start_command FROM templates ORDER BY id",
            )
            .map_err(e)?;
        let rows = st
            .query_map([], |r| {
                let dcl: String = r.get(4)?;
                Ok(Template {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    gpu_spec_uuid: r.get(2)?,
                    gpu_amount: r.get(3)?,
                    data_center_list: serde_json::from_str(&dcl).unwrap_or_default(),
                    image_uuid: r.get(5)?,
                    cuda_v_from: r.get(6)?,
                    expand_disk_gb: r.get(7)?,
                    instance_name: r.get(8)?,
                    start_command: r.get(9)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn template(&self, id: i64) -> R<Option<Template>> {
        Ok(self.templates()?.into_iter().find(|t| t.id == id))
    }

    pub fn save_template(&self, t: Template) -> R<i64> {
        let dcl = serde_json::to_string(&t.data_center_list).unwrap();
        let c = self.conn.lock().unwrap();
        if t.id > 0 {
            c.execute(
                "UPDATE templates SET name=?1,gpu_spec_uuid=?2,gpu_amount=?3,data_center_list=?4,image_uuid=?5,
                 cuda_v_from=?6,expand_disk_gb=?7,instance_name=?8,start_command=?9 WHERE id=?10",
                params![
                    t.name, t.gpu_spec_uuid, t.gpu_amount, dcl, t.image_uuid, t.cuda_v_from, t.expand_disk_gb,
                    t.instance_name, t.start_command, t.id
                ],
            )
            .map_err(e)?;
            Ok(t.id)
        } else {
            c.execute(
                "INSERT INTO templates(name,gpu_spec_uuid,gpu_amount,data_center_list,image_uuid,cuda_v_from,
                 expand_disk_gb,instance_name,start_command) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    t.name, t.gpu_spec_uuid, t.gpu_amount, dcl, t.image_uuid, t.cuda_v_from, t.expand_disk_gb,
                    t.instance_name, t.start_command
                ],
            )
            .map_err(e)?;
            Ok(c.last_insert_rowid())
        }
    }

    pub fn delete_template(&self, id: i64) -> R<()> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM templates WHERE id=?1", [id]).map_err(e)?;
        Ok(())
    }

    // ---------- history ----------

    pub fn insert_history(&self, ts: i64, region: &str, items: &[StockItem]) -> R<()> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction().map_err(e)?;
        for it in items {
            tx.execute(
                "INSERT INTO stock_history(ts,region,gpu_name,idle,total) VALUES(?1,?2,?3,?4,?5)",
                params![ts, region, it.gpu_name, it.idle, it.total],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    pub fn history(&self, region: &str, gpu_name: &str, since_ts: i64) -> R<Vec<HistoryPoint>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare(
                "SELECT ts,idle,total FROM stock_history WHERE region=?1 AND gpu_name=?2 AND ts>=?3 ORDER BY ts",
            )
            .map_err(e)?;
        let rows = st
            .query_map(params![region, gpu_name, since_ts], |r| {
                Ok(HistoryPoint { ts: r.get(0)?, idle: r.get(1)?, total: r.get(2)? })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// 某区域里名字包含关键字（不区分大小写）的卡型，每个采样时刻的空闲数之和。
    /// 用于时段分析：「4090」会把 RTX 4090 和 RTX 4090D 加在一起，和提醒规则的口径一致。
    pub fn idle_series(&self, region: &str, keyword: &str, since_ts: i64) -> R<Vec<(i64, i64)>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare(
                "SELECT ts, SUM(idle) FROM stock_history
                 WHERE region=?1 AND ts>=?2 AND instr(lower(gpu_name), lower(?3)) > 0
                 GROUP BY ts ORDER BY ts",
            )
            .map_err(e)?;
        let rows = st.query_map(params![region, since_ts, keyword.trim()], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// 某区域历史里出现过的卡型（按出现次数排序），给时段分析的下拉框用
    pub fn history_gpus(&self, region: &str) -> R<Vec<String>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare("SELECT gpu_name FROM stock_history WHERE region=?1 GROUP BY gpu_name ORDER BY COUNT(*) DESC, gpu_name")
            .map_err(e)?;
        let rows = st.query_map([region], |r| r.get(0)).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn prune(&self, keep_days: i64, now: i64) -> R<()> {
        let cutoff = now - keep_days.max(1) * 86400;
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM stock_history WHERE ts<?1", [cutoff]).map_err(e)?;
        c.execute("DELETE FROM logs WHERE ts<?1", [now - 30 * 86400]).map_err(e)?;
        Ok(())
    }

    // ---------- logs ----------

    pub fn log(&self, ts: i64, level: &str, kind: &str, rule_id: Option<i64>, msg: &str) -> R<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO logs(ts,level,kind,rule_id,message) VALUES(?1,?2,?3,?4,?5)",
            params![ts, level, kind, rule_id, msg],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn logs(&self, limit: i64) -> R<Vec<LogEntry>> {
        let c = self.conn.lock().unwrap();
        let mut st = c
            .prepare("SELECT id,ts,level,kind,rule_id,message FROM logs ORDER BY id DESC LIMIT ?1")
            .map_err(e)?;
        let rows = st
            .query_map([limit], |r| {
                Ok(LogEntry {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    level: r.get(2)?,
                    kind: r.get(3)?,
                    rule_id: r.get(4)?,
                    message: r.get(5)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// 某规则自 since_ts 起已执行的自动动作次数（成功或失败都计入，防止反复重试扣费）
    pub fn auto_actions_since(&self, rule_id: i64, since_ts: i64) -> R<i64> {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM logs WHERE kind='auto' AND rule_id=?1 AND ts>=?2",
            [rule_id, since_ts],
            |r| r.get(0),
        )
        .map_err(e)
    }
}

/// 给老数据库补上后来新增的列（新增列都有默认值，老规则行为不变）
fn migrate(conn: &Connection) -> R<()> {
    let has = |table: &str, col: &str| -> R<bool> {
        let mut st = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(e)?;
        let cols: Vec<String> = st.query_map([], |r| r.get::<_, String>(1)).map_err(e)?.filter_map(Result::ok).collect();
        Ok(cols.iter().any(|c| c == col))
    };
    if !has("rules", "min_per_machine")? {
        conn.execute("ALTER TABLE rules ADD COLUMN min_per_machine INTEGER NOT NULL DEFAULT 1", []).map_err(e)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_and_crud() {
        let s = Store::open_in_memory().unwrap();
        let rules = s.rules().unwrap();
        assert_eq!(rules.len(), 4);
        assert_eq!(s.templates().unwrap().len(), 1);
        let mut r = rules[0].clone();
        r.min_idle = 3;
        s.save_rule(r).unwrap();
        assert_eq!(s.rules().unwrap()[0].min_idle, 3);
        s.delete_rule(rules[1].id).unwrap();
        assert_eq!(s.rules().unwrap().len(), 3);

        let mut st = s.settings();
        assert_eq!(st.poll_interval_secs, 60);
        st.poll_interval_secs = 5;
        s.save_settings(&st).unwrap();
        assert_eq!(s.settings().poll_interval_secs, 30, "clamped to >= 30s");

        s.insert_history(100, "westDC3", &[StockItem { gpu_name: "RTX 4090".into(), idle: 2, total: 9, machines: None }])
            .unwrap();
        assert_eq!(s.history("westDC3", "RTX 4090", 0).unwrap().len(), 1);

        s.insert_history(100, "westDC3", &[StockItem { gpu_name: "RTX 4090D".into(), idle: 3, total: 9 }]).unwrap();
        s.insert_history(200, "westDC3", &[StockItem { gpu_name: "RTX 4090".into(), idle: 0, total: 9 }]).unwrap();
        s.insert_history(200, "beijingDC2", &[StockItem { gpu_name: "RTX 4090".into(), idle: 7, total: 9 }]).unwrap();
        // 同一时刻 4090 + 4090D 相加；不同区域不混
        assert_eq!(s.idle_series("westDC3", "4090", 0).unwrap(), vec![(100, 5), (200, 0)]);
        assert_eq!(s.idle_series("westDC3", "4090d", 0).unwrap(), vec![(100, 3)]);
        assert_eq!(s.idle_series("westDC3", "4090", 150).unwrap(), vec![(200, 0)]);
        assert_eq!(s.history_gpus("westDC3").unwrap(), vec!["RTX 4090".to_string(), "RTX 4090D".to_string()]);

        s.log(10, "info", "auto", Some(7), "x").unwrap();
        assert_eq!(s.auto_actions_since(7, 0).unwrap(), 1);
        assert_eq!(s.auto_actions_since(7, 11).unwrap(), 0);
    }

    #[test]
    fn old_database_gets_min_per_machine_default_1() {
        // 模拟升级前的库：rules 表没有 min_per_machine 列
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, enabled INTEGER NOT NULL, region_sign TEXT NOT NULL,
                gpu_keyword TEXT NOT NULL, min_idle INTEGER NOT NULL, cuda_v_from INTEGER,
                max_price_yuan REAL, cooldown_minutes INTEGER NOT NULL, action TEXT NOT NULL,
                template_id INTEGER, instance_uuid TEXT, daily_limit INTEGER NOT NULL,
                last_fired_at INTEGER
            );
            INSERT INTO rules(name,enabled,region_sign,gpu_keyword,min_idle,cooldown_minutes,action,daily_limit)
            VALUES('老规则',1,'westDC3','4090',1,15,'notify',1);
            CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            INSERT INTO kv VALUES('seeded','1');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let rules = s.rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].min_per_machine, 1);
        let mut r = rules[0].clone();
        r.min_per_machine = 4;
        s.save_rule(r).unwrap();
        assert_eq!(s.rules().unwrap()[0].min_per_machine, 4);
    }
}
