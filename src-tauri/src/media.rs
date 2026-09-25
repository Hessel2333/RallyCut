use crate::model::*;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

pub fn command(exe: &str) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c.stdin(Stdio::null());
    c
}

/// Same-directory commit. Windows omits REPLACE_EXISTING and COPY_ALLOWED.
pub fn commit_no_replace(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
        }
        let src: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let dst: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if src[..src.len() - 1].contains(&0) || dst[..dst.len() - 1].contains(&0) {
            return Err("路径包含空字符".into());
        }
        // SAFETY: both buffers are NUL-terminated and remain alive for the synchronous call.
        if unsafe { MoveFileExW(src.as_ptr(), dst.as_ptr(), 8) } == 0 {
            return Err(format!(
                "提交文件失败（请检查重名、权限和磁盘空间）：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target).map_err(|e| e.to_string())?;
        fs::remove_file(source).map_err(|e| e.to_string())
    }
}
pub fn probe(exe: &str, path: &Path) -> Result<Value> {
    let out = command(exe)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe 无法运行：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}
pub fn video(meta: &Value) -> Result<&Value> {
    meta["streams"]
        .as_array()
        .and_then(|s| s.iter().find(|v| v["codec_type"] == "video"))
        .ok_or("没有视频流".into())
}
pub fn duration(meta: &Value) -> Result<i64> {
    let v = video(meta)?;
    if let (Some(ticks), Some(tb)) = (v["duration_ts"].as_i64(), v["time_base"].as_str()) {
        let (n, d) = rational(tb)?;
        return Ok(((ticks as i128 * n as i128 * 1_000_000) / d as i128) as i64);
    }
    decimal_us(
        v["duration"]
            .as_str()
            .or(meta["format"]["duration"].as_str())
            .ok_or("无法确定视频时长")?,
    )
}
pub fn rational(s: &str) -> Result<(i64, i64)> {
    let (n, d) = s.split_once('/').ok_or("无效有理数")?;
    let n = n.parse::<i64>().map_err(|e| e.to_string())?;
    let d = d.parse::<i64>().map_err(|e| e.to_string())?;
    if n <= 0 || d <= 0 {
        return Err("无效帧率或 time_base".into());
    }
    Ok((n, d))
}
pub fn hash_file(
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 1024 * 1024];
    let mut done = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        done += n as u64;
        progress(done);
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Bounded identity hint for local references, NOT an integrity check.
/// The prefix distinguishes it from a complete SHA-256 in existing databases.
pub fn reference_signature(path: &Path, cancel: &AtomicBool) -> Result<String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut hash = Sha256::new();
    hash.update(size.to_le_bytes());
    let mut buffer = vec![0u8; 64 * 1024];
    for offset in [
        0,
        size.saturating_sub(buffer.len() as u64) / 2,
        size.saturating_sub(buffer.len() as u64),
    ] {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let count = (size - offset).min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..count])
            .map_err(|e| e.to_string())?;
        hash.update(offset.to_le_bytes());
        hash.update(&buffer[..count]);
    }
    Ok(format!("sample-v1-{:x}", hash.finalize()))
}

pub fn identity_signature(path: &Path, expected: &str, cancel: &AtomicBool) -> Result<String> {
    if expected.starts_with("sample-v1-") {
        reference_signature(path, cancel)
    } else {
        hash_file(path, cancel, |_| {})
    }
}
pub fn verified_copy(
    src: &Path,
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<(PathBuf, String)> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let token = id();
    let partial = dir.join(format!(".{token}.partial"));
    let target = dir.join(format!(
        "{token}_{}",
        src.file_name().unwrap_or_default().to_string_lossy()
    ));
    let result = (|| {
        let mut input = File::open(src).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0; 1024 * 1024];
        let mut hash = Sha256::new();
        let mut done = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            let n = input
                .read(&mut buf)
                .map_err(|e| format!("源文件读取失败，可重新导入：{e}"))?;
            if n == 0 {
                break;
            }
            output
                .write_all(&buf[..n])
                .map_err(|e| format!("复制失败，请检查剩余空间与写入权限：{e}"))?;
            hash.update(&buf[..n]);
            done += n as u64;
            progress("copying", done);
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let source = format!("{:x}", hash.finalize());
        let dest = hash_file(&partial, cancel, |n| progress("verifying", n))?;
        if source != dest {
            return Err("复制校验不一致，请重试".into());
        }
        commit_no_replace(&partial, &target)?;
        Ok((target, source))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}
#[derive(Serialize)]
pub struct Tool {
    pub path: String,
    pub version: String,
    pub available: bool,
}
#[derive(Serialize)]
pub struct Tools {
    pub ffmpeg: Tool,
    pub ffprobe: Tool,
}
pub fn discover(configured: &str, name: &str, data: &Path) -> Tool {
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let mut candidates = vec![];
    if !configured.is_empty() {
        candidates.push(configured.to_string());
    } else {
        candidates.push(
            data.join("tools")
                .join(&executable)
                .to_string_lossy()
                .into(),
        );
        if let Ok(d) = std::env::var("RALLYCUT_FFMPEG_DIR") {
            candidates.push(Path::new(&d).join(&executable).to_string_lossy().into());
        }
        candidates.push(name.into());
        #[cfg(target_os = "macos")]
        for root in ["/opt/homebrew/bin", "/usr/local/bin"] {
            candidates.push(Path::new(root).join(name).to_string_lossy().into());
        }
    }
    for p in &candidates {
        if let Ok(o) = command(p).arg("-version").output() {
            if o.status.success() {
                return Tool {
                    path: p.clone(),
                    version: String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .into(),
                    available: true,
                };
            }
        }
    }
    Tool {
        path: configured.into(),
        version: "未找到，请在设置中选择可执行文件".into(),
        available: false,
    }
}
pub fn hardware(ffmpeg: &str) -> Vec<String> {
    [
        "h264_nvenc",
        "hevc_nvenc",
        "h264_qsv",
        "hevc_qsv",
        "h264_amf",
        "hevc_amf",
        "h264_videotoolbox",
        "hevc_videotoolbox",
    ]
    .into_iter()
    .filter(|encoder| {
        let mut cmd = command(ffmpeg);
        cmd.args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=1280x720:rate=60",
            "-frames:v",
            "3",
            "-an",
            "-c:v",
            encoder,
        ]);
        if encoder.ends_with("_videotoolbox") {
            cmd.args(["-allow_sw", "0"]);
        }
        cmd.args(["-f", "null", "-"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
    .map(str::to_string)
    .collect()
}
pub fn natural_key(s: &str) -> String {
    let mut out = String::new();
    let mut digits = String::new();
    for c in s.to_lowercase().chars().chain(std::iter::once('\0')) {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            if !digits.is_empty() {
                out.push_str(&format!("{:0>20}", digits));
                digits.clear();
            }
            out.push(c);
        }
    }
    out
}

pub fn duplicate(assets: &[Asset], hash: &str, copy: bool) -> Option<Asset> {
    assets
        .iter()
        .find(|a| {
            a.sha256 == hash
                && Path::new(&a.path).is_file()
                && (!copy || a.verification == "verified-copy")
        })
        .cloned()
}
pub fn verify_identity(path: &Path, expected: &str) -> Result<()> {
    if identity_signature(path, expected, &AtomicBool::new(false))? == expected {
        Ok(())
    } else {
        Err("内容校验不匹配，未重新关联".into())
    }
}
pub fn scan(dir: &Path) -> Result<Vec<String>> {
    let mut paths = vec![];
    for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        if p.is_file()
            && p.extension()
                .map(|e| {
                    ["mp4", "mov", "mkv", "m4v", "avi", "mts", "m2ts"]
                        .contains(&e.to_string_lossy().to_lowercase().as_str())
                })
                .unwrap_or(false)
        {
            paths.push(p.to_string_lossy().into_owned());
        }
    }
    paths.sort_by_key(|p| natural_key(p));
    Ok(paths)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_samples_are_bounded_and_not_full_verification() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("本地 视频 ' .mp4");
        fs::write(&path, vec![0u8; 1024 * 1024]).unwrap();
        let cancel = AtomicBool::new(false);
        let signature = reference_signature(&path, &cancel).unwrap();
        assert!(signature.starts_with("sample-v1-"));
        verify_identity(&path, &signature).unwrap();
        let full = hash_file(&path, &cancel, |_| {}).unwrap();
        let mut f = OpenOptions::new().write(true).open(&path).unwrap();
        // Outside the three windows: proves this must never be called full verification.
        f.seek(SeekFrom::Start(128 * 1024)).unwrap();
        f.write_all(b"changed").unwrap();
        assert_eq!(reference_signature(&path, &cancel).unwrap(), signature);
        assert_ne!(hash_file(&path, &cancel, |_| {}).unwrap(), full);
        f.seek(SeekFrom::Start(0)).unwrap();
        f.write_all(b"changed").unwrap();
        assert!(verify_identity(&path, &signature).is_err());
        cancel.store(true, Ordering::Relaxed);
        assert!(reference_signature(&path, &cancel).is_err());
    }
    #[test]
    fn copy_and_cancel() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("中文 空格 ' 文件.mp4");
        fs::write(&src, b"abc").unwrap();
        let c = AtomicBool::new(false);
        let (p, h) = verified_copy(&src, &d.path().join("lib"), &c, |_, _| {}).unwrap();
        assert_eq!(hash_file(&p, &c, |_| {}).unwrap(), h);
        fs::write(&src, b"xyz").unwrap();
        let (p2, h2) = verified_copy(&src, &d.path().join("lib"), &c, |_, _| {}).unwrap();
        assert_ne!(p, p2);
        assert_ne!(h, h2);
        c.store(true, Ordering::Relaxed);
        assert!(verified_copy(&src, &d.path().join("lib"), &c, |_, _| {}).is_err());
        c.store(false, Ordering::Relaxed);
        assert!(verified_copy(&src, &d.path().join("lib"), &c, |_, _| {}).is_ok());
    }
    #[test]
    fn natural() {
        assert!(natural_key("A2.mp4") < natural_key("A10.mp4"));
    }
    #[test]
    fn atomic_commit_never_overwrites() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("partial");
        let b = d.path().join("formal");
        fs::write(&a, b"new").unwrap();
        fs::write(&b, b"existing").unwrap();
        assert!(commit_no_replace(&a, &b).is_err());
        assert_eq!(fs::read(&b).unwrap(), b"existing");
        let c = d.path().join("new-output");
        commit_no_replace(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&c).unwrap(), b"new");
    }
    #[test]
    fn duplicate_identity_and_relocation() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("同名 ' 素材.mp4");
        fs::write(&p, b"original").unwrap();
        let hash = hash_file(&p, &AtomicBool::new(false), |_| {}).unwrap();
        let a = Asset {
            id: id(),
            path: p.to_string_lossy().into(),
            original_path: p.to_string_lossy().into(),
            name: "同名".into(),
            size: 8,
            sha256: hash.clone(),
            verification: "verified-copy".into(),
            duration_us: 1,
            metadata: serde_json::json!({}),
            available: true,
        };
        assert!(duplicate(&[a.clone()], &hash, true).is_some());
        let other = d.path().join("other");
        fs::write(&other, b"changed!").unwrap();
        assert!(verify_identity(&other, &hash).is_err());
        assert!(duplicate(
            &[a.clone()],
            &hash_file(&other, &AtomicBool::new(false), |_| {}).unwrap(),
            true
        )
        .is_none());
        fs::rename(&p, &other).unwrap();
        assert!(duplicate(&[a], &hash, true).is_none());
        verify_identity(&other, &hash).unwrap();
    }
}
