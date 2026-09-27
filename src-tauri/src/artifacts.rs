use crate::{media, model::*};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportArtifact {
    pub id: String,
    pub session_id: Option<String>,
    pub match_id: Option<String>,
    pub content_fingerprint: String,
    pub segment: Option<Match>,
    pub preset: Option<Preset>,
    pub path: String,
    pub size: u64,
    pub duration_us: i64,
    pub codec: String,
    pub validation: String,
    pub file_sha256: String,
    pub created_ms: u64,
    pub availability: String,
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn inspect(path: &Path, probe: &str, cancel: &AtomicBool) -> Result<ExportArtifact> {
    let meta = media::probe(probe, path)?;
    if !meta["format"]["format_name"]
        .as_str()
        .is_some_and(|v| v.split(',').any(|n| n == "mp4"))
    {
        return Err("请选择已完成的 MP4 成片；其他容器请先使用导出功能生成 MP4".into());
    }
    let codec = media::video(&meta)?["codec_name"]
        .as_str()
        .ok_or("缺失编码信息")?
        .to_string();
    Ok(ExportArtifact {
        id: id(),
        session_id: None,
        match_id: None,
        content_fingerprint: String::new(),
        segment: None,
        preset: None,
        path: path.to_string_lossy().into(),
        size: path.metadata().map_err(|e| e.to_string())?.len(),
        duration_us: media::duration(&meta)?,
        codec,
        validation: "媒体信息检查 + 完整文件 SHA-256（非完整解码）".into(),
        file_sha256: media::hash_file(path, cancel, |_| {})?,
        created_ms: now_ms(),
        availability: "available".into(),
    })
}
pub fn validate_existing(
    artifact: &ExportArtifact,
    ffmpeg: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    if artifact.duration_us <= 0 {
        return Err("成片时长无效".into());
    }
    for time in [0, (artifact.duration_us - 500_000).max(0)] {
        crate::engine::process(
            ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-nostdin".into(),
                "-xerror".into(),
                "-ss".into(),
                seconds(time),
                "-i".into(),
                artifact.path.clone(),
                "-t".into(),
                "0.5".into(),
                "-f".into(),
                "null".into(),
                "-".into(),
            ],
            cancel,
            |_, _| {},
        )?;
    }
    Ok(())
}
pub fn verify(artifact: &ExportArtifact, cancel: &AtomicBool) -> Result<()> {
    let p = Path::new(&artifact.path);
    if p.metadata().map_err(|e| e.to_string())?.len() != artifact.size
        || media::hash_file(p, cancel, |_| {})? != artifact.file_sha256
    {
        return Err("成片内容已改变，请重新定位原成片或重新生成".into());
    }
    Ok(())
}
fn receipt_path(job: &Job) -> Result<PathBuf> {
    Ok(Path::new(&job.output)
        .parent()
        .ok_or("输出目录无效")?
        .join(format!(".{}.commit.json", job.id)))
}
/// Durable receipt BEFORE filesystem commit. SQLite registration happens afterwards.
pub fn prepare_commit(job: &Job, partial: &Path, probe: &str, cancel: &AtomicBool) -> Result<()> {
    let mut artifact = inspect(partial, probe, cancel)?;
    artifact.id = job.id.clone();
    artifact.path = job.output.clone();
    artifact.session_id = Some(job.session_id.clone());
    artifact.match_id = Some(job.segment.id.clone());
    artifact.segment = Some(job.segment.clone());
    artifact.preset = Some(job.preset.clone());
    artifact.content_fingerprint = job.fingerprint.clone();
    artifact.validation =
        "基本验证 + 首尾及拼接边界抽样解码 + 完整文件 SHA-256（非完整解码）".into();
    let receipt = receipt_path(job)?;
    if receipt.exists() {
        let previous: ExportArtifact =
            serde_json::from_slice(&fs::read(&receipt).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if previous.id != job.id
            || previous.content_fingerprint != job.fingerprint
            || Path::new(&job.output).exists()
        {
            return Err("存在尚待核对的文件提交记录".into());
        }
        fs::remove_file(&receipt).map_err(|e| e.to_string())?;
    }
    let receipt_temp = receipt.with_extension(format!("{}.tmp", id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt_temp)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&artifact).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    media::commit_no_replace(&receipt_temp, &receipt)?;
    fs::OpenOptions::new()
        .write(true)
        .open(partial)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn recover(job: &Job, cancel: &AtomicBool) -> Result<ExportArtifact> {
    let value: ExportArtifact = serde_json::from_slice(
        &fs::read(receipt_path(job)?)
            .map_err(|_| "输出已存在，但缺少提交记录；请显式导入既有成片，禁止覆盖".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if value.id != job.id
        || value.path != job.output
        || value.content_fingerprint != job.fingerprint
    {
        return Err("输出提交记录与任务不一致".into());
    }
    verify(&value, cancel)?;
    Ok(value)
}
