pub mod engine;
pub mod media;
pub mod model;
pub mod preview;
pub mod store;

use model::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub db: Mutex<store::Store>,
    pub data: PathBuf,
    pub paused: AtomicBool,
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub granted: Mutex<Vec<PathBuf>>,
    pub hardware: Mutex<Vec<String>>,
    pub hardware_tested: AtomicBool,
}
fn error<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
async fn prepare_preview(
    app: tauri::AppHandle,
    asset_id: String,
    kind: String,
    token: String,
) -> Result<preview::Preview> {
    tauri::async_runtime::spawn_blocking(move||{let s=app.state::<AppState>();let a:Asset=s.db.lock().unwrap().get("asset",&asset_id)?;let c=Arc::new(AtomicBool::new(false));s.cancels.lock().unwrap().insert(token.clone(),c.clone());let t=tools(&s);let result=preview::generate(&a,&kind,&s.data.join("cache"),&t.ffmpeg.path,&t.ffprobe.path,&c,|us,speed|{let _=app.emit("preview-progress",serde_json::json!({"token":token,"asset_id":asset_id,"progress":us as f64/a.duration_us as f64,"speed":speed}));});s.cancels.lock().unwrap().remove(&token);let p=result?;app.asset_protocol_scope().allow_file(&p.path).map_err(error)?;s.db.lock().unwrap().put("preview",&format!("{asset_id}-{kind}"),&p)?;Ok(p)}).await.map_err(error)?
}
#[tauri::command]
fn cached_previews(app: tauri::AppHandle) -> Result<Vec<preview::Preview>> {
    let s = app.state::<AppState>();
    let previews =
        s.db.lock()
            .unwrap()
            .list::<preview::Preview>("preview")?
            .into_iter()
            .filter(|p| Path::new(&p.path).is_file())
            .collect::<Vec<_>>();
    for p in &previews {
        app.asset_protocol_scope()
            .allow_file(&p.path)
            .map_err(error)?;
    }
    Ok(previews)
}
fn settings(s: &AppState) -> Settings {
    s.db.lock()
        .unwrap()
        .get("settings", "main")
        .unwrap_or_default()
}
fn tools(s: &AppState) -> media::Tools {
    let c = settings(s);
    media::Tools {
        ffmpeg: media::discover(&c.ffmpeg, "ffmpeg", &s.data),
        ffprobe: media::discover(&c.ffprobe, "ffprobe", &s.data),
    }
}
fn allowed(s: &AppState, p: &Path) -> Result<PathBuf> {
    let p = p.canonicalize().map_err(error)?;
    if s.granted
        .lock()
        .unwrap()
        .iter()
        .any(|r| p == *r || p.starts_with(r))
    {
        Ok(p)
    } else {
        Err("请先使用选择按钮授权此文件或目录".into())
    }
}

#[tauri::command]
fn snapshot(s: State<AppState>) -> Result<Snapshot> {
    let db = s.db.lock().unwrap();
    let mut assets = db.list::<Asset>("asset")?;
    for a in &mut assets {
        a.available = Path::new(&a.path).is_file();
    }
    Ok(Snapshot {
        match_numbers: db.match_numbers()?,
        assets,
        sessions: db.list("session")?,
        jobs: db.list("job")?,
        settings: db.get("settings", "main").unwrap_or_default(),
        paused: s.paused.load(Ordering::Relaxed),
        data_dir: s.data.to_string_lossy().into_owned(),
    })
}
#[tauri::command]
fn export_preferences(s: State<AppState>) -> Result<ExportPreferences> {
    let db = s.db.lock().unwrap();
    let old = db
        .get::<serde_json::Value>("export_preferences", "main")
        .ok();
    let mut value: ExportPreferences = old
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .map_err(error)?
        .unwrap_or_default();
    if old
        .as_ref()
        .is_some_and(|v| v["current"].get("codec").is_none())
    {
        value.current.codec = "hevc".into();
        value.current.encoder = "auto".into();
    }
    for built_in in ExportPreferences::default().presets {
        if !value.presets.iter().any(|p| p.id == built_in.id) {
            value.presets.push(built_in);
        }
    }
    db.put("export_preferences", "main", &value)?;
    Ok(value)
}
#[tauri::command]
fn save_export_preferences(s: State<AppState>, value: ExportPreferences) -> Result<()> {
    for p in std::iter::once(&value.current).chain(value.presets.iter().map(|p| &p.preset)) {
        if !["h264", "hevc"].contains(&p.codec.as_str())
            || (p.encoder != "auto" && !p.accepts_encoder(&p.encoder))
        {
            return Err("视频编码与编码器不匹配".into());
        }
        if p.width < 2
            || p.height < 2
            || p.width % 2 != 0
            || p.height % 2 != 0
            || p.width > 7680
            || p.height > 4320
            || p.bitrate_kbps < 100
            || p.bitrate_kbps > 100000
            || p.audio_kbps < 32
            || p.audio_kbps > 512
        {
            return Err("请检查分辨率、视频码率和音频码率".into());
        }
    }
    if value.presets.iter().any(|p| p.name.trim().is_empty()) {
        return Err("请输入预设名称".into());
    }
    s.db.lock()
        .unwrap()
        .put("export_preferences", "main", &value)
}
#[tauri::command]
async fn choose_path(app: tauri::AppHandle, kind: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let p = if kind == "directory" {
            dialog.blocking_pick_folder()
        } else {
            dialog.blocking_pick_file()
        };
        if let Some(p) = p {
            let p = p
                .into_path()
                .map_err(error)?
                .canonicalize()
                .map_err(error)?;
            app.state::<AppState>()
                .granted
                .lock()
                .unwrap()
                .push(p.clone());
            Ok(Some(p.to_string_lossy().into_owned()))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn choose_video_files(app: tauri::AppHandle) -> Result<Option<Vec<String>>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(files) = app
            .dialog()
            .file()
            .add_filter(
                "视频文件",
                &["mp4", "mov", "mkv", "m4v", "avi", "mts", "m2ts"],
            )
            .blocking_pick_files()
        else {
            return Ok(None);
        };
        let mut paths = files
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(error)?
                    .canonicalize()
                    .map_err(error)
            })
            .collect::<Result<Vec<_>>>()?;
        paths.sort_by_key(|p| media::natural_key(&p.to_string_lossy()));
        paths.dedup();
        let result = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        app.state::<AppState>()
            .granted
            .lock()
            .unwrap()
            .extend(paths);
        Ok(Some(result))
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn scan_directory(app: tauri::AppHandle, path: String) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        media::scan(&allowed(&s, Path::new(&path))?)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn file_modified_ms(app: tauri::AppHandle, path: String) -> Result<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let p = allowed(&s, Path::new(&path))?;
        let modified = std::fs::metadata(p)
            .map_err(error)?
            .modified()
            .map_err(error)?;
        Ok(modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(error)?
            .as_millis() as u64)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn tool_status(app: tauri::AppHandle) -> Result<media::Tools> {
    tauri::async_runtime::spawn_blocking(move || Ok(tools(&app.state::<AppState>())))
        .await
        .map_err(error)?
}
#[tauri::command]
async fn detect_hardware(app: tauri::AppHandle) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let t = tools(&s);
        if !t.ffmpeg.available {
            return Err("请先配置 FFmpeg".into());
        }
        let found = media::hardware(&t.ffmpeg.path);
        *s.hardware.lock().unwrap() = found.clone();
        s.hardware_tested.store(true, Ordering::Relaxed);
        Ok(found)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
fn save_settings(s: State<AppState>, value: Settings) -> Result<()> {
    export_folder(&value.folder_template, "2026-09-23", "羽毛球")?;
    let old = settings(&s);
    for (new, previous) in [
        (&value.ffmpeg, &old.ffmpeg),
        (&value.ffprobe, &old.ffprobe),
        (&value.library, &old.library),
        (&value.output, &old.output),
    ] {
        if !new.is_empty() && new != previous {
            allowed(&s, Path::new(new))?;
        }
    }
    if value.ffmpeg != old.ffmpeg {
        s.hardware_tested.store(false, Ordering::Relaxed);
        s.hardware.lock().unwrap().clear();
    }
    s.db.lock().unwrap().put("settings", "main", &value)
}
#[tauri::command]
fn set_theme_preference(app: tauri::AppHandle, theme: String) -> Result<()> {
    let native = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        "system" => None,
        _ => return Err("不支持的主题".into()),
    };
    if let Some(window) = app.get_webview_window("main") {
        window.set_theme(native).map_err(error)?;
    }
    let s = app.state::<AppState>();
    let mut value = settings(&s);
    value.theme = theme;
    s.db.lock().unwrap().put("settings", "main", &value)?;
    Ok(())
}
#[tauri::command]
async fn import_session(
    app: tauri::AppHandle,
    paths: Vec<String>,
    copy: bool,
    name: String,
    date: String,
    token: String,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move||{
 let s=app.state::<AppState>();let c=Arc::new(AtomicBool::new(false));s.cancels.lock().unwrap().insert(token.clone(),c.clone());
 let result=(||{let t=tools(&s);if !t.ffprobe.available{return Err("请在设置中配置 ffprobe".into());}if paths.is_empty(){return Err("请选择至少一个视频".into());}let cfg=settings(&s);let mut asset_ids=vec![];
 for (index,path) in paths.iter().enumerate(){let source=allowed(&s,Path::new(path))?;let size=source.metadata().map_err(error)?.len();let mut last=std::time::Instant::now()-Duration::from_secs(1);let mut notify=|phase:&str,bytes:u64|{if last.elapsed()>Duration::from_millis(120)||bytes==size{let _=app.emit("import-progress",serde_json::json!({"token":token,"phase":phase,"bytes":bytes,"total":size,"index":index+1,"count":paths.len(),"name":source.file_name().unwrap_or_default().to_string_lossy()}));last=std::time::Instant::now();}};
 notify(if copy{"hashing"}else{"probing"},0);
 let hash=if copy{media::hash_file(&source,&c,|n|notify("hashing",n))?}else{media::reference_signature(&source,&c)?};
 let assets=s.db.lock().unwrap().list::<Asset>("asset")?;
 let existing=if copy{media::duplicate(&assets,&hash,true)}else{assets.into_iter().find(|a|a.sha256==hash && Path::new(&a.path)==source)};
 if let Some(a)=existing{if !asset_ids.contains(&a.id){asset_ids.push(a.id);}continue;}
 let metadata=media::probe(&t.ffprobe.path,&source)?;let duration_us=media::duration(&metadata)?;if duration_us<=0{return Err("素材时长无效".into());}
 let (target,digest)=if copy{media::verified_copy(&source,Path::new(&cfg.library),&c,&mut notify)?}else{(source.clone(),hash.clone())};if digest!=hash{return Err("导入期间源文件发生改变，请重试".into());}
 let a=Asset{id:id(),original_path:source.to_string_lossy().into(),path:target.to_string_lossy().into(),name:source.file_name().unwrap_or_default().to_string_lossy().into(),size,sha256:digest,verification:if copy{"verified-copy"}else{"sampled-reference"}.into(),duration_us,metadata,available:true};
 app.asset_protocol_scope().allow_file(&target).map_err(error)?;s.db.lock().unwrap().put("asset",&a.id,&a)?;asset_ids.push(a.id);
 }
 let session=Session{id:id(),name:if name.trim().is_empty(){"羽毛球".into()}else{name},date,asset_ids,matches:vec![]};s.db.lock().unwrap().put("session",&session.id,&session)?;Ok(session.id)
 })();s.cancels.lock().unwrap().remove(&token);result
 }).await.map_err(error)?
}
#[tauri::command]
fn save_session(s: State<AppState>, session: Session) -> Result<()> {
    let db = s.db.lock().unwrap();
    let old: Session = db.get("session", &session.id)?;
    let assets: Vec<Asset> = db.list("asset")?;
    validate_session_change(&old, &session, &assets)?;
    if old.asset_ids != session.asset_ids && !old.matches.is_empty() {
        return Err("已有比赛标记，不能更改素材顺序。请建立新的拍摄记录".into());
    }
    let mut unique = session.asset_ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != session.asset_ids.len()
        || unique.iter().any(|id| !assets.iter().any(|a| &a.id == id))
    {
        return Err("素材引用无效".into());
    }
    for m in &session.matches {
        model::validate_ranges(&m.ranges, &assets)?;
        if m.ranges
            .iter()
            .any(|r| !session.asset_ids.contains(&r.asset_id))
        {
            return Err("比赛引用了其他拍摄的素材".into());
        }
    }
    db.put("session", &session.id, &session)
}
#[tauri::command]
async fn relink_asset(app: tauri::AppHandle, asset_id: String, path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let p = allowed(&s, Path::new(&path))?;
        let mut a: Asset = s.db.lock().unwrap().get("asset", &asset_id)?;
        media::verify_identity(&p, &a.sha256)?;
        a.path = p.to_string_lossy().into_owned();
        a.available = true;
        app.asset_protocol_scope().allow_file(&p).map_err(error)?;
        s.db.lock().unwrap().put("asset", &a.id, &a)?;
        Ok(())
    })
    .await
    .map_err(error)?
}
#[tauri::command]
fn delete_session(s: State<AppState>, session_id: String) -> Result<()> {
    s.db.lock().unwrap().delete_session(&session_id)
}
#[tauri::command]
fn remove_session_asset(s: State<AppState>, session_id: String, asset_id: String) -> Result<()> {
    s.db.lock()
        .unwrap()
        .remove_session_asset(&session_id, &asset_id)
}
#[tauri::command]
fn enqueue(
    s: State<AppState>,
    session_id: String,
    match_ids: Vec<String>,
    preset: Preset,
    dry_run: Option<bool>,
) -> Result<Vec<String>> {
    let cfg = settings(&s);
    let db = s.db.lock().unwrap();
    let session: Session = db.get("session", &session_id)?;
    if match_ids.is_empty()
        || match_ids
            .iter()
            .any(|id| !session.matches.iter().any(|m| &m.id == id))
    {
        return Err("请选择当前拍摄中的比赛".into());
    }
    let assets: Vec<Asset> = db.list("asset")?;
    let mut jobs = db.list::<Job>("job")?;
    let mut outputs = vec![];
    let numbers = db.match_numbers()?;
    let mut matches: Vec<_> = session
        .matches
        .iter()
        .filter(|m| match_ids.contains(&m.id))
        .collect();
    matches.sort_by_key(|m| numbers.get(&m.id).copied().unwrap_or(0));
    for m in matches {
        let used: Vec<_> = assets
            .iter()
            .filter(|a| m.ranges.iter().any(|r| r.asset_id == a.id))
            .cloned()
            .collect();
        validate_ranges(&m.ranges, &used)?;
        let fingerprint = engine::fingerprint(m, &used, &preset);
        let base = format!(
            "{}-{}",
            numbers.get(&m.id).copied().unwrap_or(1),
            safe_name(if m.name.trim().is_empty() {
                "未命名"
            } else {
                &m.name
            })
        );
        let mut n = 0;
        let output = loop {
            let suffix = if n == 0 {
                String::new()
            } else {
                format!("_{n}")
            };
            let p = Path::new(&cfg.output)
                .join(export_folder(
                    &cfg.folder_template,
                    &session.date,
                    &session.name,
                )?)
                .join(format!("{base}{suffix}.mp4"));
            if !p.exists() && !jobs.iter().any(|j| Path::new(&j.output) == p) {
                break p.to_string_lossy().into_owned();
            }
            n += 1;
        };
        let job = Job {
            id: id(),
            session_id: session_id.clone(),
            segment: m.clone(),
            assets: used,
            preset: preset.clone(),
            output,
            status: "waiting".into(),
            progress: 0.0,
            speed: String::new(),
            error: String::new(),
            fingerprint,
            validation: String::new(),
        };
        outputs.push(job.output.clone());
        if !dry_run.unwrap_or(false) {
            db.put("job", &job.id, &job)?;
        }
        jobs.push(job);
    }
    Ok(outputs)
}
#[tauri::command]
fn delete_export_jobs(s: State<AppState>, job_ids: Vec<String>) -> Result<()> {
    s.db.lock().unwrap().delete_jobs(&job_ids)
}
#[tauri::command]
fn queue_action(s: State<AppState>, action: String, job_id: Option<String>) -> Result<()> {
    if action == "pause" {
        s.paused.store(true, Ordering::Relaxed);
        s.db.lock().unwrap().put("runtime", "paused", &true)?;
        return Ok(());
    }
    if action == "resume" {
        s.paused.store(false, Ordering::Relaxed);
        s.db.lock().unwrap().put("runtime", "paused", &false)?;
        return Ok(());
    }
    let key = job_id.ok_or("任务不存在")?;
    if action == "cancel" {
        if let Some(c) = s.cancels.lock().unwrap().get(&key) {
            c.store(true, Ordering::Relaxed);
            return Ok(());
        }
    }
    let db = s.db.lock().unwrap();
    let mut j: Job = db.get("job", &key)?;
    if action == "retry" && ["failed", "cancelled", "interrupted"].contains(&j.status.as_str()) {
        if Path::new(&j.output).exists() {
            return Err("目标已存在，请重新导出以创建新名称".into());
        }
        j.status = "waiting".into();
        j.error.clear();
        j.progress = 0.0;
    } else if action == "cancel" && j.status == "waiting" {
        j.status = "cancelled".into();
    } else {
        return Err("此任务当前不能执行该操作".into());
    }
    db.put("job", &j.id, &j)
}
#[tauri::command]
fn open_output(s: State<AppState>) -> Result<()> {
    let p = settings(&s).output;
    std::fs::create_dir_all(&p).map_err(error)?;
    #[cfg(target_os = "windows")]
    let opener = "explorer.exe";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let opener = "xdg-open";
    media::command(opener).arg(p).spawn().map_err(error)?;
    Ok(())
}
#[tauri::command]
fn begin_app_update(s: State<AppState>) -> Result<()> {
    let db = s.db.lock().unwrap();
    let jobs = db.list::<Job>("job")?;
    if jobs
        .iter()
        .any(|j| ["waiting", "preparing", "exporting", "validating"].contains(&j.status.as_str()))
        || !s.cancels.lock().unwrap().is_empty()
    {
        return Err("请等待导入、预览或导出任务结束后再更新".into());
    }
    s.paused.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
fn end_app_update(s: State<AppState>) -> Result<()> {
    let paused =
        s.db.lock()
            .unwrap()
            .get::<bool>("runtime", "paused")
            .unwrap_or(false);
    s.paused.store(paused, Ordering::SeqCst);
    Ok(())
}
fn worker(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let s = app.state::<AppState>();
        if s.paused.load(Ordering::Relaxed) {
            continue;
        }
        let next = {
            let db = s.db.lock().unwrap();
            if s.paused.load(Ordering::SeqCst) {
                continue;
            }
            db.list::<Job>("job")
                .unwrap_or_default()
                .into_iter()
                .find(|j| j.status == "waiting")
                .map(|mut j| {
                    j.status = "preparing".into();
                    let _ = db.put("job", &j.id, &j);
                    j
                })
        };
        if let Some(mut job) = next {
            let c = Arc::new(AtomicBool::new(false));
            s.cancels.lock().unwrap().insert(job.id.clone(), c.clone());
            let t = tools(&s);
            if !s.hardware_tested.swap(true, Ordering::Relaxed) {
                *s.hardware.lock().unwrap() = media::hardware(&t.ffmpeg.path);
            }
            let hw = s.hardware.lock().unwrap().clone();
            let update = |j: &Job| {
                let _ = s.db.lock().unwrap().put("job", &j.id, j);
                let _ = app.emit("job-update", j);
            };
            let result = engine::export(&mut job, &t.ffmpeg.path, &t.ffprobe.path, &hw, &c, update);
            job.status = match result {
                Ok(()) => "completed".into(),
                Err(e) => {
                    job.error = e;
                    if c.load(Ordering::Relaxed) {
                        "cancelled".into()
                    } else {
                        "failed".into()
                    }
                }
            };
            update(&job);
            s.cancels.lock().unwrap().remove(&job.id);
        }
    });
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let mut files: Vec<_> = paths
                        .into_iter()
                        .filter_map(|p| p.canonicalize().ok())
                        .filter(|p| {
                            p.is_file()
                                && p.extension().is_some_and(|e| {
                                    ["mp4", "mov", "mkv", "m4v", "avi", "mts", "m2ts"]
                                        .contains(&e.to_string_lossy().to_lowercase().as_str())
                                })
                        })
                        .collect();
                    files.sort_by_key(|p| media::natural_key(&p.to_string_lossy()));
                    files.dedup();
                    app.state::<AppState>()
                        .granted
                        .lock()
                        .unwrap()
                        .extend(files.clone());
                    let files: Vec<String> = files
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    let _ = app.emit("media-dropped", files);
                });
            }
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let db = store::Store::open(&data.join("rallycut.sqlite3"))?;
            if db.get::<Settings>("settings", "main").is_err() {
                let library = data.join("library");
                let output = app
                    .path()
                    .video_dir()
                    .unwrap_or(data.clone())
                    .join("RallyCut");
                std::fs::create_dir_all(&library)?;
                std::fs::create_dir_all(&output)?;
                db.put(
                    "settings",
                    "main",
                    &Settings {
                        library: library.to_string_lossy().into(),
                        output: output.to_string_lossy().into(),
                        ..Default::default()
                    },
                )?;
            }
            for a in db.list::<Asset>("asset")? {
                if Path::new(&a.path).is_file() {
                    app.asset_protocol_scope().allow_file(&a.path)?;
                }
            }
            let paused = db.get::<bool>("runtime", "paused").unwrap_or(false);
            app.manage(AppState {
                db: Mutex::new(db),
                data,
                paused: AtomicBool::new(paused),
                cancels: Mutex::new(HashMap::new()),
                granted: Mutex::new(vec![]),
                hardware: Mutex::new(vec![]),
                hardware_tested: AtomicBool::new(false),
            });
            worker(app.handle().clone());
            let preference = settings(&app.state::<AppState>()).theme;
            set_theme_preference(
                app.handle().clone(),
                if preference.is_empty() {
                    "dark".into()
                } else {
                    preference
                },
            )
            .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            begin_app_update,
            end_app_update,
            snapshot,
            prepare_preview,
            cached_previews,
            choose_path,
            choose_video_files,
            scan_directory,
            tool_status,
            file_modified_ms,
            detect_hardware,
            save_settings,
            set_theme_preference,
            import_session,
            save_session,
            delete_session,
            remove_session_asset,
            relink_asset,
            enqueue,
            export_preferences,
            save_export_preferences,
            queue_action,
            delete_export_jobs,
            open_output
        ])
        .build(tauri::generate_context!())
        .expect("RallyCut 启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let s = app.state::<AppState>();
                s.paused.store(true, Ordering::Relaxed);
                let cancels = s.cancels.lock().unwrap();
                if !cancels.is_empty() {
                    api.prevent_exit();
                    for c in cancels.values() {
                        c.store(true, Ordering::Relaxed);
                    }
                    let handle = app.clone();
                    std::thread::spawn(move || loop {
                        std::thread::sleep(Duration::from_millis(100));
                        if handle
                            .state::<AppState>()
                            .cancels
                            .lock()
                            .unwrap()
                            .is_empty()
                        {
                            handle.exit(0);
                            break;
                        }
                    });
                }
            }
        });
}
