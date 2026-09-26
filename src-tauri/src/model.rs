use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Asset {
    pub id: String,
    pub original_path: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub verification: String,
    pub duration_us: i64,
    pub metadata: Value,
    pub available: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Range {
    pub asset_id: String,
    pub start_us: i64,
    pub end_us: i64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Match {
    pub id: String,
    pub name: String,
    pub ranges: Vec<Range>,
    pub note: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub date: String,
    pub asset_ids: Vec<String>,
    pub matches: Vec<Match>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Preset {
    #[serde(default = "legacy_codec")]
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
    pub audio_kbps: u32,
    pub force_60: bool,
    pub encoder: String,
    pub acknowledge_sdr: bool,
}
fn legacy_codec() -> String {
    "h264".into()
}
#[cfg(test)]
mod codec_tests {
    use super::*;
    #[test]
    fn legacy_jobs_keep_h264_and_new_daily_default_is_hevc() {
        let mut legacy = serde_json::to_value(Preset::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("codec");
        let p: Preset = serde_json::from_value(legacy).unwrap();
        assert_eq!(p.codec, "h264");
        assert!(p.accepts_encoder("h264_videotoolbox"));
        assert!(!p.accepts_encoder("hevc_nvenc"));
        let p = ExportPreferences::default().current;
        assert_eq!(p.codec, "hevc");
        assert_eq!(p.cpu_encoder(), "libx265");
        assert!(p.accepts_encoder("hevc_videotoolbox"));
        assert!(!p.accepts_encoder("libx264"));
    }
}
impl Preset {
    pub fn cpu_encoder(&self) -> &str {
        if self.codec == "hevc" {
            "libx265"
        } else {
            "libx264"
        }
    }
    pub fn accepts_encoder(&self, encoder: &str) -> bool {
        match self.codec.as_str() {
            "h264" => [
                "libx264",
                "h264_nvenc",
                "h264_qsv",
                "h264_amf",
                "h264_videotoolbox",
            ]
            .contains(&encoder),
            "hevc" => [
                "libx265",
                "hevc_nvenc",
                "hevc_qsv",
                "hevc_amf",
                "hevc_videotoolbox",
            ]
            .contains(&encoder),
            _ => false,
        }
    }
}
impl Default for Preset {
    fn default() -> Self {
        Self {
            codec: legacy_codec(),
            width: 3840,
            height: 2160,
            bitrate_kbps: 20000,
            audio_kbps: 192,
            force_60: false,
            encoder: "auto".into(),
            acknowledge_sdr: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Job {
    pub id: String,
    pub session_id: String,
    pub segment: Match,
    pub assets: Vec<Asset>,
    pub preset: Preset,
    pub output: String,
    pub status: String,
    pub progress: f64,
    pub speed: String,
    pub error: String,
    pub fingerprint: String,
    pub validation: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub library: String,
    pub output: String,
    #[serde(default = "default_folder_template")]
    pub folder_template: String,
}
pub fn default_theme() -> String {
    "dark".into()
}
pub fn default_folder_template() -> String {
    "{date}-日常羽毛球".into()
}
#[cfg(test)]
mod folder_tests {
    use super::*;
    #[test]
    fn folder_templates_are_safe_and_compatible() {
        assert_eq!(
            export_folder("", "2026-09-23", "羽毛球").unwrap(),
            "2026.09.23-日常羽毛球"
        );
        assert_eq!(
            export_folder("{date}-{name}", "2026-09-23", "男双/练习").unwrap(),
            "2026.09.23-男双_练习"
        );
        assert!(export_folder("../{date}", "x", "y").is_err());
        assert!(export_folder("{unknown}", "x", "y").is_err());
        let old: Settings = serde_json::from_value(
            serde_json::json!({"ffmpeg":"","ffprobe":"","library":"","output":""}),
        )
        .unwrap();
        assert_eq!(old.folder_template, default_folder_template());
    }
}
pub fn export_folder(template: &str, date: &str, name: &str) -> Result<String> {
    let template = if template.is_empty() {
        default_folder_template()
    } else {
        template.into()
    };
    if template.len() > 240
        || template.contains(['/', '\\'])
        || template
            .replace("{date}", "")
            .replace("{name}", "")
            .contains(['{', '}'])
    {
        return Err("命名规则仅支持 {date}、{name}，不能包含路径分隔符".into());
    }
    Ok(safe_name(
        &template
            .replace("{date}", &date.replace('-', "."))
            .replace("{name}", name),
    ))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub match_numbers: std::collections::HashMap<String, usize>,
    pub assets: Vec<Asset>,
    pub sessions: Vec<Session>,
    pub jobs: Vec<Job>,
    pub settings: Settings,
    pub paused: bool,
    pub data_dir: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NamedPreset {
    pub id: String,
    pub name: String,
    pub preset: Preset,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ExportPreferences {
    pub current: Preset,
    pub presets: Vec<NamedPreset>,
}
impl Default for ExportPreferences {
    fn default() -> Self {
        Self {
            current: Preset {
                codec: "hevc".into(),
                ..Preset::default()
            },
            presets: vec![
                NamedPreset {
                    id: "bilibili-4k-hevc".into(),
                    name: "日常 · 4K H.265".into(),
                    preset: Preset {
                        codec: "hevc".into(),
                        ..Preset::default()
                    },
                },
                NamedPreset {
                    id: "bilibili-4k".into(),
                    name: "兼容 · 4K H.264".into(),
                    preset: Preset::default(),
                },
                NamedPreset {
                    id: "1080p60".into(),
                    name: "1080p · 60fps".into(),
                    preset: Preset {
                        width: 1920,
                        height: 1080,
                        bitrate_kbps: 12000,
                        force_60: true,
                        ..Preset::default()
                    },
                },
            ],
        }
    }
}

pub fn map_range(assets: &[Asset], start: i64, end: i64) -> Result<Vec<Range>> {
    let total: i64 = assets.iter().map(|a| a.duration_us).sum();
    if start < 0 || end <= start || end > total {
        return Err("区间无效：结束必须晚于开始，且位于拍摄范围内".into());
    }
    let mut offset = 0;
    let mut ranges = vec![];
    for a in assets {
        let s = start.max(offset) - offset;
        let e = end.min(offset + a.duration_us) - offset;
        if e > s {
            ranges.push(Range {
                asset_id: a.id.clone(),
                start_us: s,
                end_us: e,
            });
        }
        offset += a.duration_us;
    }
    Ok(ranges)
}
pub fn validate_ranges(ranges: &[Range], assets: &[Asset]) -> Result<()> {
    if ranges.is_empty() {
        return Err("比赛没有素材区间".into());
    }
    for r in ranges {
        let a = assets
            .iter()
            .find(|a| a.id == r.asset_id)
            .ok_or("素材引用不存在")?;
        if r.start_us < 0 || r.end_us <= r.start_us || r.end_us > a.duration_us {
            return Err("素材区间超出范围".into());
        }
    }
    Ok(())
}

pub fn validate_session_change(old: &Session, new: &Session, assets: &[Asset]) -> Result<()> {
    if old.asset_ids != new.asset_ids && !old.matches.is_empty() {
        return Err("已有比赛标记，不能更改素材顺序。请建立新的拍摄记录".into());
    }
    let mut ids = new.asset_ids.clone();
    ids.sort();
    ids.dedup();
    if ids.len() != new.asset_ids.len() {
        return Err("不能重复引用同一素材".into());
    }
    let ordered: Vec<Asset> = new
        .asset_ids
        .iter()
        .map(|id| {
            assets
                .iter()
                .find(|a| &a.id == id)
                .cloned()
                .ok_or("素材不存在".to_string())
        })
        .collect::<Result<_>>()?;
    let mut offsets = std::collections::HashMap::new();
    let mut cursor = 0;
    for a in &ordered {
        offsets.insert(&a.id, cursor);
        cursor += a.duration_us;
    }
    for m in &new.matches {
        validate_ranges(&m.ranges, &ordered)?;
        let first = m.ranges.first().unwrap();
        let last = m.ranges.last().unwrap();
        let start = offsets[&first.asset_id] + first.start_us;
        let end = offsets[&last.asset_id] + last.end_us;
        if map_range(&ordered, start, end)? != m.ranges {
            return Err("比赛源区间必须按拍摄顺序连续排列".into());
        }
    }
    Ok(())
}
pub fn decimal_us(s: &str) -> Result<i64> {
    let negative = s.starts_with('-');
    let s = s.trim_start_matches('-');
    let mut p = s.split('.');
    let whole = p
        .next()
        .unwrap_or("0")
        .parse::<i64>()
        .map_err(|e| e.to_string())?;
    let f = p.next().unwrap_or("");
    if !f.bytes().all(|b| b.is_ascii_digit()) {
        return Err("无效时间".into());
    }
    let padded = format!("{f:0<6}");
    let frac = padded[..6].parse::<i64>().map_err(|e| e.to_string())?;
    Ok((whole * 1_000_000 + frac) * if negative { -1 } else { 1 })
}
pub fn seconds(us: i64) -> String {
    format!("{}.{:06}", us / 1_000_000, us % 1_000_000)
}
pub fn safe_name(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim_matches([' ', '.']);
    if s.is_empty() {
        "比赛".into()
    } else {
        let stem = s.split('.').next().unwrap_or("").to_uppercase();
        if [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
        {
            format!("_{s}")
        } else {
            s.chars().take(80).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assets() -> Vec<Asset> {
        (0..3)
            .map(|i| Asset {
                id: i.to_string(),
                original_path: String::new(),
                path: String::new(),
                name: String::new(),
                size: 0,
                sha256: String::new(),
                verification: String::new(),
                duration_us: 15_000_000,
                metadata: serde_json::json!({"r_frame_rate":"60000/1001"}),
                available: true,
            })
            .collect()
    }
    #[test]
    fn mapping() {
        let a = assets();
        assert_eq!(map_range(&a, 1, 2).unwrap().len(), 1);
        let r = map_range(&a, 12_000_000, 18_000_000).unwrap();
        assert_eq!(
            r,
            vec![
                Range {
                    asset_id: "0".into(),
                    start_us: 12_000_000,
                    end_us: 15_000_000
                },
                Range {
                    asset_id: "1".into(),
                    start_us: 0,
                    end_us: 3_000_000
                }
            ]
        );
        assert_eq!(map_range(&a, 12_000_000, 33_000_000).unwrap().len(), 3);
        assert_eq!(map_range(&a, 15_000_000, 30_000_000).unwrap().len(), 1);
    }
    #[test]
    fn invalid() {
        for (s, e) in [(-1, 1), (1, 1), (2, 1), (0, 46_000_000)] {
            assert!(map_range(&assets(), s, e).is_err())
        }
    }
    #[test]
    fn stable_references() {
        let mut a = assets();
        let r = map_range(&a, 12_000_000, 18_000_000).unwrap();
        a.reverse();
        validate_ranges(&r, &a).unwrap();
        assert_eq!(r[0].asset_id, "0");
    }
    #[test]
    fn exact_time() {
        assert_eq!(decimal_us("15.015000").unwrap(), 15_015_000);
        assert_ne!(60000.0 / 1001.0, 60.0);
        assert_eq!(seconds(15_015_000), "15.015000");
    }
    #[test]
    fn changing_order_rejected_and_empty_order_allowed() {
        let a = assets();
        let original = Session {
            id: "s".into(),
            name: "test".into(),
            date: "2026-09-24".into(),
            asset_ids: a.iter().map(|a| a.id.clone()).collect(),
            matches: vec![Match {
                id: "m".into(),
                name: "m".into(),
                ranges: map_range(&a, 12_000_000, 18_000_000).unwrap(),
                note: "".into(),
            }],
        };
        let mut changed = original.clone();
        changed.asset_ids.reverse();
        assert!(validate_session_change(&original, &changed, &a).is_err());
        let mut empty = original.clone();
        empty.matches.clear();
        changed.matches.clear();
        assert!(validate_session_change(&empty, &changed, &a).is_ok());
        let mut invalid = original.clone();
        invalid.matches[0].ranges.reverse();
        assert!(validate_session_change(&original, &invalid, &a).is_err());
    }
}
