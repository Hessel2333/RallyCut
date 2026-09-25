use crate::model::*;
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

pub struct Store {
    conn: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 1 {
            return Err("数据库由更新版本创建，请升级 RallyCut".into());
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        if version == 0 {
            conn.execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT OR IGNORE INTO migrations VALUES(1); PRAGMA user_version=1; COMMIT;").map_err(|e|e.to_string())?;
        }
        let s = Self { conn };
        for mut j in s.list::<Job>("job")? {
            if !["completed", "failed", "cancelled", "interrupted"].contains(&j.status.as_str()) {
                j.status = "interrupted".into();
                j.error = "应用上次退出时任务未完成，可以重试".into();
                s.put("job", &j.id, &j)?;
            }
        }
        Ok(s)
    }
    pub fn put<T: Serialize>(&self, kind: &str, id: &str, value: &T) -> Result<()> {
        self.conn.execute("INSERT INTO records(kind,id,json) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",params![kind,id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    /// Remove only this session. Assets, job snapshots and files remain intact.
    pub fn delete_session(&self, id: &str) -> Result<()> {
        let _: Session = self.get("session", id)?;
        if self.list::<Job>("job")?.iter().any(|j| {
            j.session_id == id
                && !["completed", "failed", "cancelled", "interrupted"].contains(&j.status.as_str())
        }) {
            return Err("此拍摄还有未完成的导出任务，请等待完成或取消任务后再删除".into());
        }
        self.conn
            .execute("DELETE FROM records WHERE kind='session' AND id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn match_numbers(&self) -> Result<std::collections::HashMap<String, usize>> {
        let assets = self.list::<Asset>("asset")?;
        let sessions = self.list::<Session>("session")?;
        let mut entries = vec![];
        for (position, session) in sessions.iter().enumerate() {
            for m in &session.matches {
                let Some(range) = m.ranges.first() else {
                    continue;
                };
                let asset = session
                    .asset_ids
                    .first()
                    .and_then(|id| assets.iter().find(|a| &a.id == id));
                let timestamp = asset
                    .and_then(|a| a.metadata["format"]["tags"]["creation_time"].as_str())
                    .and_then(|t| {
                        self.conn
                            .query_row("SELECT unixepoch(?1)", [t], |r| r.get::<_, Option<i64>>(0))
                            .ok()
                            .flatten()
                    });
                let offset: i64 = session
                    .asset_ids
                    .iter()
                    .take_while(|id| **id != range.asset_id)
                    .filter_map(|id| assets.iter().find(|a| &a.id == id))
                    .map(|a| a.duration_us)
                    .sum();
                entries.push((
                    session.date.clone(),
                    timestamp.is_none(),
                    timestamp
                        .map(|t| t * 1_000_000 + offset + range.start_us)
                        .unwrap_or(position as i64),
                    if timestamp.is_none() {
                        offset + range.start_us
                    } else {
                        0
                    },
                    m.id.clone(),
                ));
            }
        }
        entries.sort();
        let mut counters = std::collections::HashMap::new();
        let mut result = std::collections::HashMap::new();
        for (date, _, _, _, id) in entries {
            let n = counters.entry(date).or_insert(0usize);
            *n += 1;
            result.insert(id, *n);
        }
        Ok(result)
    }
    pub fn list<T: DeserializeOwned>(&self, kind: &str) -> Result<Vec<T>> {
        let mut stmt = self
            .conn
            .prepare("SELECT json FROM records WHERE kind=?1 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([kind], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn get<T: DeserializeOwned>(&self, kind: &str, id: &str) -> Result<T> {
        let json: String = self
            .conn
            .query_row(
                "SELECT json FROM records WHERE kind=?1 AND id=?2",
                [kind, id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_session_preserves_files_shared_assets_and_history() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let s = Store::open(&path).unwrap();
        let source = d.path().join("original.mp4");
        let output = d.path().join("export.mp4");
        std::fs::write(&source, b"original").unwrap();
        std::fs::write(&output, b"export").unwrap();
        let a = serde_json::json!({"id":"a","path":source,"original_path":source,"name":"a","size":8,"sha256":"hash","verification":"verified-copy","duration_us":100,"metadata":{},"available":true});
        s.put("asset", "a", &a).unwrap();
        let mut session = Session {
            id: "s".into(),
            name: "test".into(),
            date: "2026-09-25".into(),
            asset_ids: vec!["a".into()],
            matches: vec![],
        };
        s.put("session", "s", &session).unwrap();
        session.id = "other".into();
        s.put("session", "other", &session).unwrap();
        let mut job = serde_json::json!({"id":"j","session_id":"s","segment":{"id":"m","name":"男双","ranges":[],"note":""},"assets":[],"preset":Preset::default(),"output":output,"status":"waiting","progress":0,"speed":"","error":"","fingerprint":"x","validation":""});
        for status in ["waiting", "preparing", "exporting", "validating"] {
            job["status"] = status.into();
            s.put("job", "j", &job).unwrap();
            assert!(s.delete_session("s").is_err());
            assert!(s.get::<Session>("session", "s").is_ok());
        }
        job["status"] = "completed".into();
        s.put("job", "j", &job).unwrap();
        s.delete_session("s").unwrap();
        assert!(s.delete_session("s").is_err());
        drop(s);
        let s = Store::open(&path).unwrap();
        assert!(s.get::<Session>("session", "s").is_err());
        assert!(s.get::<Session>("session", "other").is_ok());
        assert!(s.get::<Asset>("asset", "a").is_ok());
        assert_eq!(s.get::<Job>("job", "j").unwrap().status, "completed");
        assert_eq!(std::fs::read(source).unwrap(), b"original");
        assert_eq!(std::fs::read(output).unwrap(), b"export");
    }
    #[test]
    fn daily_numbers_follow_capture_time_not_insertion_or_selection() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(&d.path().join("numbers.db")).unwrap();
        for (id, time) in [
            ("late", "2026-09-23T10:00:00Z"),
            ("early", "2026-09-23T09:00:00Z"),
        ] {
            let a = Asset {
                id: id.into(),
                original_path: "x".into(),
                path: "x".into(),
                name: id.into(),
                size: 1,
                sha256: id.into(),
                verification: "sampled-reference".into(),
                duration_us: 60_000_000,
                metadata: serde_json::json!({"format":{"tags":{"creation_time":time}}}),
                available: true,
            };
            s.put("asset", id, &a).unwrap();
            let session = Session {
                id: id.into(),
                name: id.into(),
                date: "2026-09-23".into(),
                asset_ids: vec![id.into()],
                matches: [20_000_000, 0]
                    .into_iter()
                    .map(|start| Match {
                        id: format!("{id}-{start}"),
                        name: "男单".into(),
                        note: "".into(),
                        ranges: vec![Range {
                            asset_id: id.into(),
                            start_us: start,
                            end_us: start + 10_000_000,
                        }],
                    })
                    .collect(),
            };
            s.put("session", id, &session).unwrap();
        }
        let n = s.match_numbers().unwrap();
        assert_eq!(n["early-0"], 1);
        assert_eq!(n["early-20000000"], 2);
        assert_eq!(n["late-0"], 3);
        assert_eq!(n["late-20000000"], 4);
        let mut next: Session = s.get("session", "late").unwrap();
        next.date = "2026-09-24".into();
        s.put("session", "late", &next).unwrap();
        assert_eq!(s.match_numbers().unwrap()["late-0"], 1);
    }
    #[test]
    fn export_presets_survive_restart() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("presets.db");
        let s = Store::open(&p).unwrap();
        let mut pref = ExportPreferences::default();
        pref.current.bitrate_kbps = 15000;
        pref.presets.push(NamedPreset {
            id: "custom".into(),
            name: "我的1080p".into(),
            preset: pref.current.clone(),
        });
        s.put("export_preferences", "main", &pref).unwrap();
        drop(s);
        let loaded: ExportPreferences = Store::open(&p)
            .unwrap()
            .get("export_preferences", "main")
            .unwrap();
        assert_eq!(loaded.current.bitrate_kbps, 15000);
        assert_eq!(loaded.presets[2].name, "我的1080p");
    }
    #[test]
    fn persistence() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("db");
        let s = Store::open(&p).unwrap();
        let v = Session {
            id: "s".into(),
            name: "中文".into(),
            date: "2026-09-23".into(),
            asset_ids: vec!["a".into()],
            matches: vec![Match {
                id: "m".into(),
                name: "第一局".into(),
                ranges: vec![Range {
                    asset_id: "a".into(),
                    start_us: 1,
                    end_us: 2,
                }],
                note: "".into(),
            }],
        };
        s.put("session", "s", &v).unwrap();
        drop(s);
        assert_eq!(
            Store::open(&p)
                .unwrap()
                .get::<Session>("session", "s")
                .unwrap()
                .matches[0]
                .ranges[0]
                .end_us,
            2
        );
    }
    #[test]
    fn interrupted_jobs_recover_without_redoing_completed() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("queue.db");
        let s = Store::open(&p).unwrap();
        let mut job = serde_json::json!({"id":"running","session_id":"s","segment":{"id":"m","name":"m","ranges":[],"note":""},"assets":[],"preset":Preset::default(),"output":"x.mp4","status":"exporting","progress":0.5,"speed":"1x","error":"","fingerprint":"hash","validation":""});
        s.put("job", "running", &job).unwrap();
        job["id"] = "done".into();
        job["status"] = "completed".into();
        s.put("job", "done", &job).unwrap();
        drop(s);
        let reopened = Store::open(&p).unwrap();
        assert_eq!(
            reopened.get::<Job>("job", "running").unwrap().status,
            "interrupted"
        );
        assert_eq!(
            reopened.get::<Job>("job", "done").unwrap().status,
            "completed"
        );
    }
}
