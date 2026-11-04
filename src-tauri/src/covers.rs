use crate::{engine, model::*, AppState};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize)]
pub struct CoverCandidate {
    pub id: String,
    pub session_id: String,
    pub asset_id: String,
    pub name: String,
    pub time_us: i64,
    pub path: String,
}

#[tauri::command]
pub fn cover_candidates(
    s: State<AppState>,
    session_id: Option<String>,
    session_ids: Option<Vec<String>>,
) -> Result<Vec<CoverCandidate>> {
    let ids = session_ids.unwrap_or_else(|| session_id.into_iter().collect());
    Ok(s.db
        .lock()
        .unwrap()
        .list::<CoverCandidate>("cover_candidate")?
        .into_iter()
        .filter(|c| ids.contains(&c.session_id))
        .collect())
}

pub fn image_data(path: &Path) -> Result<String> {
    let (bytes, mime) = read_image(path)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn read_image(path: &Path) -> Result<(Vec<u8>, &'static str)> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "封面图片不存在，请重新选择")?;
    let mut bytes = Vec::new();
    file.take(10 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(crate::error)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("封面图片超过 10 MB".into());
    }
    let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else {
        return Err("请选择 JPEG 或 PNG 封面".into());
    };
    Ok((bytes, mime))
}

/// Publish a complete image without replacing a previous cover.
fn export_image(source: &Path, directory: &Path) -> Result<PathBuf> {
    use std::io::Write;
    let (bytes, mime) = read_image(source)?;
    let extension = if mime == "image/png" { "png" } else { "jpg" };
    std::fs::create_dir_all(directory).map_err(crate::error)?;
    let temporary = directory.join(format!(".cover-{}.tmp", id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(crate::error)?;
        file.write_all(&bytes).map_err(crate::error)?;
        file.sync_all().map_err(crate::error)?;
        drop(file);
        for number in 1..=9999 {
            let name = if number == 1 {
                format!("封面.{extension}")
            } else {
                format!("封面-{number}.{extension}")
            };
            let destination = directory.join(name);
            if destination.exists() {
                if read_image(&destination).is_ok_and(|(existing, _)| existing == bytes) {
                    return Ok(destination);
                }
                continue;
            }
            match crate::media::commit_no_replace(&temporary, &destination) {
                Ok(()) => return Ok(destination),
                Err(_) if destination.exists() => {
                    if read_image(&destination).is_ok_and(|(existing, _)| existing == bytes) {
                        return Ok(destination);
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Err("日期文件夹中的同名封面过多，请整理后重试".into())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

#[tauri::command]
pub async fn export_cover(
    app: tauri::AppHandle,
    path: String,
    session_id: String,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let known = {
            let db = s.db.lock().unwrap();
            db.list::<CoverCandidate>("cover_candidate")?
                .iter()
                .any(|c| c.path == path)
                || db
                    .list::<crate::publication::PublicationDraft>("publication_draft")?
                    .iter()
                    .any(|d| d.cover_path == path)
        };
        if !known {
            crate::allowed(&s, Path::new(&path))?;
        }
        let directory = session_output(&s, &session_id)?;
        Ok(export_image(Path::new(&path), &directory)?
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(crate::error)?
}

fn session_output(s: &AppState, session_id: &str) -> Result<PathBuf> {
    let session: Session = s.db.lock().unwrap().get("session", session_id)?;
    let config = crate::settings(s);
    if config.output.is_empty() {
        return Err("请先在导出设置中选择输出目录".into());
    }
    Ok(Path::new(&config.output).join(export_folder(
        &config.folder_template,
        &session.date,
        &session.name,
    )?))
}

#[tauri::command]
pub fn open_session_output(s: State<AppState>, session_id: String) -> Result<()> {
    let directory = session_output(&s, &session_id)?;
    if !directory.is_dir() {
        return Err("日期文件夹尚未创建，请先导出封面或视频".into());
    }
    #[cfg(target_os = "windows")]
    let opener = "explorer.exe";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let opener = "xdg-open";
    crate::media::command(opener)
        .arg(directory)
        .spawn()
        .map_err(crate::error)?;
    Ok(())
}

#[tauri::command]
pub async fn cover_preview(app: tauri::AppHandle, path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let known = {
            let db = s.db.lock().unwrap();
            db.list::<CoverCandidate>("cover_candidate")?
                .iter()
                .any(|c| c.path == path)
                || db
                    .list::<crate::publication::PublicationDraft>("publication_draft")?
                    .iter()
                    .any(|d| d.cover_path == path)
        };
        if !known {
            crate::allowed(&s, Path::new(&path))?;
        }
        image_data(Path::new(&path))
    })
    .await
    .map_err(crate::error)?
}

pub fn capture(
    ffmpeg: &str,
    source: &str,
    time_us: i64,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    if path.exists() {
        return Err("封面文件已存在".into());
    }
    let temporary = path.with_file_name(format!("{}.tmp.jpg", id()));
    let result = (|| {
        engine::process(
            ffmpeg,
            &[
                "-v".into(),
                "error".into(),
                "-nostdin".into(),
                "-n".into(),
                "-ss".into(),
                format!("{:.6}", time_us as f64 / 1e6),
                "-i".into(),
                source.into(),
                "-frames:v".into(),
                "1".into(),
                "-vf".into(),
                "scale=1280:-2".into(),
                temporary.to_string_lossy().into(),
            ],
            cancel,
            |_, _| {},
        )?;
        image_data(&temporary)?;
        // A no-replace link publishes only a complete JPEG. FFmpeg's image muxer
        // alone does not reliably enforce -n for an existing single image.
        std::fs::hard_link(&temporary, path).map_err(crate::error)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

#[tauri::command]
pub async fn capture_cover_candidate(
    app: tauri::AppHandle,
    session_id: String,
    asset_id: String,
    time_us: i64,
) -> Result<CoverCandidate> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let asset: Asset = {
            let db = s.db.lock().unwrap();
            let session: Session = db.get("session", &session_id)?;
            if !session.asset_ids.contains(&asset_id) {
                return Err("素材不属于当前拍摄记录".into());
            }
            db.get("asset", &asset_id)?
        };
        if time_us < 0 || time_us >= asset.duration_us {
            return Err("封面时间超出素材范围".into());
        }
        let dir = s.data.join("covers");
        std::fs::create_dir_all(&dir).map_err(crate::error)?;
        let cover_id = id();
        let path = dir.join(format!("{cover_id}.jpg"));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut cancels = s.cancels.lock().unwrap();
            if s.update_active.load(std::sync::atomic::Ordering::SeqCst)
                || s.exit_authorized.load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("应用正在退出或更新，请稍后重试".into());
            }
            cancels.insert(cover_id.clone(), cancel.clone());
        }
        let result = (|| {
            capture(
                &crate::tools(&s).ffmpeg.path,
                &asset.path,
                time_us,
                &path,
                &cancel,
            )?;
            let candidate = CoverCandidate {
                id: cover_id.clone(),
                session_id,
                asset_id,
                name: asset.name,
                time_us,
                path: path.to_string_lossy().into(),
            };
            s.db.lock()
                .unwrap()
                .put("cover_candidate", &candidate.id, &candidate)?;
            Ok(candidate)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        s.cancels.lock().unwrap().remove(&cover_id);
        result
    })
    .await
    .map_err(crate::error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_rejects_missing_non_image_and_oversize_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("cover.jpg");
        assert!(image_data(&p).is_err());
        std::fs::write(&p, b"private data").unwrap();
        assert!(image_data(&p).is_err());
        std::fs::write(&p, [0xff, 0xd8, 0xff, 0]).unwrap();
        assert!(image_data(&p)
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        std::fs::File::create(&p)
            .unwrap()
            .set_len(10 * 1024 * 1024 + 1)
            .unwrap();
        assert!(image_data(&p).is_err());
    }

    #[test]
    fn export_cover_uses_date_folder_and_preserves_existing_images() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("candidate.jpg");
        let first = [0xff, 0xd8, 0xff, 1];
        let second = [0xff, 0xd8, 0xff, 2];
        std::fs::write(&source, first).unwrap();
        let folder = root
            .path()
            .join(export_folder("", "2026-09-26", "练习").unwrap());
        let original = export_image(&source, &folder).unwrap();
        assert_eq!(original, folder.join("封面.jpg"));
        assert_eq!(export_image(&source, &folder).unwrap(), original);
        std::fs::write(&source, second).unwrap();
        let changed = export_image(&source, &folder).unwrap();
        assert_eq!(changed, folder.join("封面-2.jpg"));
        assert_eq!(std::fs::read(original).unwrap(), first);
        assert_eq!(std::fs::read(changed).unwrap(), second);
        assert_eq!(std::fs::read(source).unwrap(), second);
        assert_eq!(std::fs::read_dir(folder).unwrap().count(), 2);
    }

    #[test]
    fn export_detects_image_format_and_rejects_invalid_sources_before_creating_folder() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("misnamed.jpg");
        let folder = root.path().join("date");
        std::fs::write(&source, b"not an image").unwrap();
        assert!(export_image(&source, &folder).is_err());
        assert!(!folder.exists());
        std::fs::write(&source, b"\x89PNG\r\n\x1a\nimage").unwrap();
        assert_eq!(
            export_image(&source, &folder).unwrap().file_name().unwrap(),
            "封面.png"
        );
    }
}
