use crate::{engine, media, model::*};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Preview {
    pub asset_id: String,
    pub source_sha256: String,
    pub path: String,
    pub duration_us: i64,
    pub time_offset_us: i64,
    pub kind: String,
}
pub fn generate(
    asset: &Asset,
    kind: &str,
    cache: &Path,
    ffmpeg: &str,
    ffprobe: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(i64, String),
) -> Result<Preview> {
    if kind != "proxy" && kind != "thumbnail" {
        return Err("无效预览类型".into());
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let v = media::video(&asset.metadata)?;
    if ["smpte2084", "arib-std-b67"].contains(&v["color_transfer"].as_str().unwrap_or("")) {
        return Err("暂不支持 HDR 代理，请使用原片预览".into());
    }
    let ext = if kind == "proxy" { "mp4" } else { "jpg" };
    let path = cache.join(format!("{}-{}-{kind}-v1.{ext}", asset.id, asset.sha256));
    let partial = cache.join(format!("{}.partial.{ext}", id()));
    let result = (|| {
        if !path.is_file() {
            let mut args: Vec<String> = ["-v", "error", "-nostdin", "-n", "-i", &asset.path]
                .map(str::to_string)
                .to_vec();
            if kind == "proxy" {
                args.extend(["-map","0:v:0","-map","0:a:0?","-vf","scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p","-c:v","libx264","-preset","veryfast","-crf","26","-c:a","aac","-b:a","96k","-movflags","+faststart","-progress","pipe:1"].map(str::to_string));
            } else {
                args.extend(
                    [
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=240:135:force_original_aspect_ratio=decrease",
                        "-update",
                        "1",
                    ]
                    .map(str::to_string),
                );
            }
            args.push(partial.to_string_lossy().into_owned());
            engine::process(ffmpeg, &args, cancel, &mut progress)?;
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            if kind == "proxy" {
                let meta = media::probe(ffprobe, &partial)?;
                if (media::duration(&meta)? - asset.duration_us).abs() > 100_000 {
                    return Err("代理时长与原片不一致，未采用此代理".into());
                }
            }
            if !path.exists() {
                media::commit_no_replace(&partial, &path)?;
            } else {
                std::fs::remove_file(&partial).map_err(|e| e.to_string())?;
            }
        }
        Ok(Preview {
            asset_id: asset.id.clone(),
            source_sha256: asset.sha256.clone(),
            path: path.to_string_lossy().into(),
            duration_us: asset.duration_us,
            time_offset_us: 0,
            kind: kind.into(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    result
}
