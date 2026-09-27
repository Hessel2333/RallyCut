pub(crate) fn transfer_parts(
    db: &Mutex<Store>,
    adapter: &Adapter,
    credentials: &bilibili::Credentials,
    draft: &PublicationDraft,
    cancel: &AtomicBool,
    epoch: &str,
    reupload_unverified: bool,
    mut progress: impl FnMut(&UploadPart),
) -> Result<()> {
    for part in &draft.parts {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消上传".into());
        }
        let artifact: ExportArtifact = db
            .lock()
            .unwrap()
            .get("artifact", part.artifact_id.as_ref().ok_or("成片尚未完成")?)?;
        let key = format!("{}:{}", draft.id, part.id);
        let old = db
            .lock()
            .unwrap()
            .list::<UploadPart>("upload_part")?
            .into_iter()
            .find(|p| p.id == key);
        if let Some(old) = &old {
            if old.account_id != credentials.account_id || old.file_sha256 != artifact.file_sha256 {
                return Err("分 P 的账号或文件身份改变，请重新创建草稿".into());
            }
            if old.status == "uploaded" && old.confirmed_epoch == epoch {
                artifacts::verify(&artifact, cancel)?;
                continue;
            }
            if old.remote.is_some() && !reupload_unverified {
                return Err("远端文件有效性无法确认，请明确选择重新上传待核对分 P".into());
            }
        }
        let mut upload = UploadPart {
            id: key,
            draft_id: draft.id.clone(),
            part_id: part.id.clone(),
            artifact_id: artifact.id.clone(),
            account_id: credentials.account_id.clone(),
            file_sha256: artifact.file_sha256.clone(),
            bytes: 0,
            total: artifact.size,
            status: "uploading".into(),
            remote: None,
            confirmed_epoch: epoch.to_string(),
            error: String::new(),
            attempts: old.map_or(1, |v| v.attempts + 1),
        };
        db.lock().unwrap().put("upload_part", &upload.id, &upload)?;
        progress(&upload);
        let uploaded = adapter.upload(credentials, &artifact, cancel, |bytes| {
            upload.bytes = bytes;
            progress(&upload);
            Ok(())
        });
        match uploaded {
            Ok(remote) => {
                upload.remote = Some(remote);
                upload.status = "uploaded".into();
                upload.bytes = artifact.size;
            }
            Err(error) => {
                upload.status = if cancel.load(Ordering::SeqCst) {
                    "cancelled"
                } else if error.contains("认证") {
                    "auth_expired"
                } else {
                    "failed"
                }
                .into();
                upload.error = error;
            }
        }
        db.lock().unwrap().put("upload_part", &upload.id, &upload)?;
        progress(&upload);
        if !upload.error.is_empty() {
            return Err(upload.error);
        }
    }
    Ok(())
}
use crate::{
    artifacts::{self, ExportArtifact},
    bilibili::{self, Account, Adapter, Category, QrChallenge, UploadedVideo},
    engine,
    model::*,
    store::Store,
    AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

pub struct Runtime {
    pub active: AtomicBool,
    pub challenge: Mutex<Option<QrChallenge>>,
    pub epoch: String,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            challenge: Mutex::new(None),
            epoch: id(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DraftPart {
    pub id: String,
    pub artifact_id: Option<String>,
    pub job_id: Option<String>,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PublicationDraft {
    pub id: String,
    pub revision: u64,
    pub account_id: Option<String>,
    pub title: String,
    pub description: String,
    pub cover_path: String,
    pub category: u64,
    pub tags: String,
    pub visibility: String,
    pub parts: Vec<DraftPart>,
    pub status: String,
    pub error: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UploadPart {
    pub id: String,
    pub draft_id: String,
    pub part_id: String,
    pub artifact_id: String,
    pub account_id: String,
    pub file_sha256: String,
    pub bytes: u64,
    pub total: u64,
    pub status: String,
    pub remote: Option<UploadedVideo>,
    pub confirmed_epoch: String,
    pub error: String,
    pub attempts: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Publication {
    pub id: String,
    pub draft_id: String,
    pub account_id: String,
    pub payload: Value,
    pub status: String,
    pub aid: Option<u64>,
    pub bvid: Option<String>,
    pub error: String,
    pub created_ms: u64,
    pub checked_ms: Option<u64>,
    pub platform_status: String,
}
#[derive(Serialize)]
pub struct PublicationSnapshot {
    drafts: Vec<PublicationDraft>,
    artifacts: Vec<ExportArtifact>,
    uploads: Vec<UploadPart>,
    publications: Vec<Publication>,
    active: bool,
}

pub fn recover_records(db: &Store) -> Result<()> {
    for mut publication in db.list::<Publication>("publication")? {
        if publication.status == "submitting" {
            publication.status = "unknown".into();
            publication.error = "上次提交结果未确认，请先核对稿件，禁止再次提交".into();
            db.put("publication", &publication.id, &publication)?;
        }
    }
    for mut part in db.list::<UploadPart>("upload_part")? {
        if part.status == "uploading" {
            part.status = "interrupted".into();
            part.error = "上传中断，可重试此分 P".into();
        } else if part.status == "uploaded" {
            part.status = "uploaded_unverified".into();
            part.error = "远端文件有效期无法确认，需确认后重新上传此分 P".into();
        }
        db.put("upload_part", &part.id, &part)?;
    }
    for mut draft in db.list::<PublicationDraft>("publication_draft")? {
        if draft.status == "uploading" {
            draft.status = "interrupted".into();
            db.put("publication_draft", &draft.id, &draft)?;
        }
    }
    Ok(())
}
pub fn has_intent(db: &Store, draft_id: &str) -> Result<bool> {
    Ok(db
        .list::<Publication>("publication")?
        .iter()
        .any(|p| p.draft_id == draft_id))
}
pub fn claim_submission(
    db: &Store,
    draft: &PublicationDraft,
    payload: Value,
    account_id: String,
) -> Result<Publication> {
    // Caller holds the Store mutex for the check and insertion. No network inside it.
    if has_intent(db, &draft.id)? {
        return Err("此草稿已经提交或结果待核实，不能重复提交".into());
    }
    let publication = Publication {
        id: id(),
        draft_id: draft.id.clone(),
        account_id,
        payload,
        status: "submitting".into(),
        aid: None,
        bvid: None,
        error: String::new(),
        created_ms: artifacts::now_ms(),
        checked_ms: None,
        platform_status: String::new(),
    };
    db.put("publication", &publication.id, &publication)?;
    Ok(publication)
}
struct Operation {
    app: tauri::AppHandle,
    token: String,
    cancel: Arc<AtomicBool>,
}
impl Operation {
    fn begin(app: &tauri::AppHandle, draft_id: &str) -> Result<Self> {
        let s = app.state::<AppState>();
        if s.update_active.load(Ordering::SeqCst)
            || s.exit_authorized.load(Ordering::SeqCst)
            || s.publication.active.swap(true, Ordering::SeqCst)
        {
            return Err("请等待当前发布操作完成".into());
        }
        if s.update_active.load(Ordering::SeqCst) {
            s.publication.active.store(false, Ordering::SeqCst);
            return Err("更新安装期间不能开始发布操作".into());
        }
        let token = format!("publication:{draft_id}");
        let cancel = Arc::new(AtomicBool::new(false));
        s.cancels
            .lock()
            .unwrap()
            .insert(token.clone(), cancel.clone());
        Ok(Self {
            app: app.clone(),
            token,
            cancel,
        })
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let s = self.app.state::<AppState>();
        s.cancels.lock().unwrap().remove(&self.token);
        s.publication.active.store(false, Ordering::SeqCst);
        let _ = self.app.emit("publication-update", ());
    }
}
fn notify(app: &tauri::AppHandle) {
    let _ = app.emit("publication-update", ());
}

#[tauri::command]
pub fn publication_snapshot(s: tauri::State<AppState>) -> Result<PublicationSnapshot> {
    let db = s.db.lock().unwrap();
    let active = s.publication.active.load(Ordering::SeqCst);
    // A response may have arrived while the final DB write failed. Once the
    // operation has stopped, never leave a durable intent looking in flight.
    if !active {
        for mut publication in db.list::<Publication>("publication")? {
            if publication.status == "submitting" {
                publication.status = "unknown".into();
                publication.error = "提交结果未能持久化，请先核对稿件".into();
                db.put("publication", &publication.id, &publication)?;
            }
        }
    }
    Ok(PublicationSnapshot {
        drafts: db.list("publication_draft")?,
        artifacts: db.list("artifact")?,
        uploads: db.list("upload_part")?,
        publications: db.list("publication")?,
        active,
    })
}
#[tauri::command]
pub async fn publication_login(app: tauri::AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        if s.publication.active.load(Ordering::SeqCst) {
            return Err("发布操作期间不能切换账号".into());
        }
        let (challenge, image) = Adapter::new()?.qr()?;
        *s.publication.challenge.lock().unwrap() = Some(challenge);
        Ok(image)
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_poll_login(app: tauri::AppHandle) -> Result<Option<Account>> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let _operation = Operation::begin(&app, "login")?;
        let mut challenge = s.publication.challenge.lock().unwrap();
        let adapter = Adapter::new()?;
        if let Some(credentials) = adapter.poll_qr(challenge.as_ref().ok_or("请先生成二维码")?)?
        {
            let account = adapter.account(&credentials)?;
            bilibili::save_credentials(&credentials)?;
            *challenge = None;
            return Ok(Some(account));
        }
        Ok(None)
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_account() -> Result<Account> {
    tauri::async_runtime::spawn_blocking(|| Adapter::new()?.account(&bilibili::credentials()?))
        .await
        .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_logout(app: tauri::AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = Operation::begin(&app, "logout")?;
        bilibili::logout()
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_categories() -> Result<Vec<Category>> {
    tauri::async_runtime::spawn_blocking(|| Adapter::new()?.categories(&bilibili::credentials()?))
        .await
        .map_err(crate::error)?
}
#[tauri::command]
pub fn publication_save(
    s: tauri::State<AppState>,
    mut draft: PublicationDraft,
) -> Result<PublicationDraft> {
    let db = s.db.lock().unwrap();
    if s.publication.active.load(Ordering::SeqCst) {
        return Err("请等待发布操作完成后修改草稿".into());
    }
    if draft.visibility != "public" {
        return Err("当前适配器仅支持公开投稿".into());
    }
    let old_drafts = db.list::<PublicationDraft>("publication_draft")?;
    if !draft.cover_path.is_empty()
        && !old_drafts
            .iter()
            .any(|d| d.id == draft.id && d.cover_path == draft.cover_path)
        && !db
            .list::<crate::covers::CoverCandidate>("cover_candidate")?
            .iter()
            .any(|c| c.path == draft.cover_path)
    {
        crate::allowed(&s, Path::new(&draft.cover_path))?;
    }
    if has_intent(&db, &draft.id)? {
        return Err("已提交或待核实的草稿不能改写".into());
    }
    if let Some(old) = db
        .list::<PublicationDraft>("publication_draft")?
        .iter()
        .find(|v| v.id == draft.id)
    {
        if old.revision != draft.revision {
            return Err("草稿已更新，请重新载入".into());
        }
    }
    let all: Vec<ExportArtifact> = db.list("artifact")?;
    let mut ids = std::collections::HashSet::new();
    for part in &draft.parts {
        if !ids.insert(&part.id) {
            return Err("分 P 标识重复".into());
        }
        if let Some(id) = &part.artifact_id {
            if !all.iter().any(|a| &a.id == id) {
                return Err("成片不存在".into());
            }
        }
    }
    draft.revision += 1;
    draft.status = "draft".into();
    draft.error.clear();
    db.put("publication_draft", &draft.id, &draft)?;
    Ok(draft)
}
#[tauri::command]
pub async fn publication_import_artifact(
    app: tauri::AppHandle,
    path: String,
    artifact_id: Option<String>,
) -> Result<ExportArtifact> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let operation = Operation::begin(&app, "artifact")?;
        let path = crate::allowed(&s, Path::new(&path))?;
        let mut artifact =
            artifacts::inspect(&path, &crate::tools(&s).ffprobe.path, &operation.cancel)?;
        artifacts::validate_existing(&artifact, &crate::tools(&s).ffmpeg.path, &operation.cancel)?;
        artifact.validation = "媒体信息 + 首尾抽样解码 + 完整文件 SHA-256（非完整解码）".into();
        if let Some(id) = artifact_id {
            let old: ExportArtifact = s.db.lock().unwrap().get("artifact", &id)?;
            if old.file_sha256 != artifact.file_sha256 || old.size != artifact.size {
                return Err("此文件不是原成片，拒绝重新关联".into());
            }
            artifact = ExportArtifact {
                path: path.to_string_lossy().into(),
                availability: "available".into(),
                ..old
            };
        }
        s.db.lock()
            .unwrap()
            .put("artifact", &artifact.id, &artifact)?;
        notify(&app);
        Ok(artifact)
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_from_matches(
    app: tauri::AppHandle,
    session_id: String,
    match_ids: Vec<String>,
    preset: Preset,
) -> Result<PublicationDraft> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let operation = Operation::begin(&app, "prepare")?;
        let (session, assets, mut artifacts, jobs) = {
            let db = s.db.lock().unwrap();
            (
                db.get::<Session>("session", &session_id)?,
                db.list::<Asset>("asset")?,
                db.list::<ExportArtifact>("artifact")?,
                db.list::<Job>("job")?,
            )
        };
        let matches: Vec<_> = session
            .matches
            .iter()
            .filter(|m| match_ids.contains(&m.id))
            .collect();
        if matches.is_empty() {
            return Err("请选择比赛".into());
        }
        let mut parts = Vec::new();
        for segment in matches {
            let fingerprint = engine::fingerprint(segment, &assets, &preset);
            let mut found = None;
            for a in artifacts
                .iter_mut()
                .filter(|a| a.content_fingerprint == fingerprint)
            {
                match artifacts::verify(a, &operation.cancel) {
                    Ok(()) => {
                        found = Some(a.id.clone());
                        break;
                    }
                    Err(_) => {
                        a.availability = "unavailable".into();
                        s.db.lock().unwrap().put("artifact", &a.id, a)?;
                    }
                }
            }
            // Lazy migration: only selected historical completed jobs; never scan every file at startup.
            if found.is_none() {
                if let Some(job) = jobs
                    .iter()
                    .find(|j| j.fingerprint == fingerprint && j.status == "completed")
                {
                    if let Ok(mut artifact) = artifacts::inspect(
                        Path::new(&job.output),
                        &crate::tools(&s).ffprobe.path,
                        &operation.cancel,
                    ) {
                        let duration: i64 = job
                            .segment
                            .ranges
                            .iter()
                            .map(|r| r.end_us - r.start_us)
                            .sum();
                        if (artifact.duration_us - duration).abs() <= 150_000
                            && artifact.codec == job.preset.codec
                            && !job.validation.is_empty()
                        {
                            artifacts::validate_existing(
                                &artifact,
                                &crate::tools(&s).ffmpeg.path,
                                &operation.cancel,
                            )?;
                            let meta = crate::media::probe(
                                &crate::tools(&s).ffprobe.path,
                                Path::new(&artifact.path),
                            )?;
                            let video = crate::media::video(&meta)?;
                            if video["width"].as_u64() != Some(job.preset.width as u64)
                                || video["height"].as_u64() != Some(job.preset.height as u64)
                            {
                                return Err("旧任务输出规格已改变，请显式导入并核对成片".into());
                            }
                            artifact.id = job.id.clone();
                            artifact.content_fingerprint = job.fingerprint.clone();
                            artifact.session_id = Some(job.session_id.clone());
                            artifact.match_id = Some(job.segment.id.clone());
                            artifact.segment = Some(job.segment.clone());
                            artifact.preset = Some(job.preset.clone());
                            artifact.validation = format!(
                                "历史任务验证记录：{}；本次媒体信息及完整文件哈希核对",
                                job.validation
                            );
                            s.db.lock()
                                .unwrap()
                                .put("artifact", &artifact.id, &artifact)?;
                            found = Some(artifact.id);
                        }
                    }
                }
            }
            let mut job_id = None;
            if found.is_none() {
                if let Some(job) = jobs.iter().find(|j| {
                    j.fingerprint == fingerprint
                        && ["waiting", "preparing", "exporting", "validating"]
                            .contains(&j.status.as_str())
                }) {
                    job_id = Some(job.id.clone());
                } else {
                    crate::enqueue(
                        s.clone(),
                        session_id.clone(),
                        vec![segment.id.clone()],
                        preset.clone(),
                        Some(false),
                    )?;
                    job_id =
                        s.db.lock()
                            .unwrap()
                            .list::<Job>("job")?
                            .iter()
                            .rev()
                            .find(|j| j.fingerprint == fingerprint)
                            .map(|j| j.id.clone());
                }
            }
            parts.push(DraftPart {
                id: id(),
                artifact_id: found,
                job_id,
                name: segment.name.clone(),
            });
        }
        let draft = PublicationDraft {
            id: id(),
            revision: 1,
            account_id: None,
            title: format!("{} {}", session.date, session.name),
            description: String::new(),
            cover_path: String::new(),
            category: 0,
            tags: "羽毛球".into(),
            visibility: "public".into(),
            status: if parts.iter().any(|p| p.artifact_id.is_none()) {
                "waiting_artifacts"
            } else {
                "ready"
            }
            .into(),
            parts,
            error: String::new(),
        };
        s.db.lock()
            .unwrap()
            .put("publication_draft", &draft.id, &draft)?;
        notify(&app);
        Ok(draft)
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_upload(
    app: tauri::AppHandle,
    draft_id: String,
    reupload_unverified: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation = Operation::begin(&app, &draft_id)?;
        let s = app.state::<AppState>();
        let adapter = Adapter::new()?;
        let credentials = bilibili::credentials()?;
        adapter.account(&credentials)?;
        let mut draft: PublicationDraft =
            s.db.lock().unwrap().get("publication_draft", &draft_id)?;
        if has_intent(&s.db.lock().unwrap(), &draft_id)? {
            return Err("已有提交记录，禁止重新上传".into());
        }
        if draft
            .account_id
            .as_ref()
            .is_some_and(|id| id != &credentials.account_id)
        {
            return Err("草稿绑定其他账号，请登录原账号".into());
        }
        draft.account_id = Some(credentials.account_id.clone());
        for part in &mut draft.parts {
            if part.artifact_id.is_none() {
                if let Some(job) = &part.job_id {
                    let mapped = s.db.lock().unwrap().artifact_for_job(job)?;
                    let artifacts: Vec<ExportArtifact> = s.db.lock().unwrap().list("artifact")?;
                    let exported =
                        s.db.lock()
                            .unwrap()
                            .list::<Job>("job")?
                            .into_iter()
                            .find(|j| &j.id == job);
                    part.artifact_id = artifacts
                        .iter()
                        .find(|a| {
                            mapped.as_ref() == Some(&a.id)
                                || &a.id == job
                                || exported.as_ref().is_some_and(|j| {
                                    j.status == "completed"
                                        && a.content_fingerprint == j.fingerprint
                                        && a.path == j.output
                                })
                        })
                        .map(|a| a.id.clone());
                }
            }
            if part.artifact_id.is_none() {
                return Err("请等待成片导出完成，失败的导出可在任务队列重试".into());
            }
        }
        draft.status = "uploading".into();
        draft.error.clear();
        draft.revision += 1;
        s.db.lock()
            .unwrap()
            .put("publication_draft", &draft.id, &draft)?;
        notify(&app);
        let result = transfer_parts(
            &s.db,
            &adapter,
            &credentials,
            &draft,
            &operation.cancel,
            &s.publication.epoch,
            reupload_unverified,
            |upload| {
                let _ = app.emit("upload-progress", upload);
            },
        );
        draft.status = if result.is_ok() {
            "awaiting_confirmation"
        } else if operation.cancel.load(Ordering::SeqCst) {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        draft.error = result.as_ref().err().cloned().unwrap_or_default();
        s.db.lock()
            .unwrap()
            .put("publication_draft", &draft.id, &draft)?;
        result
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub async fn publication_submit(
    app: tauri::AppHandle,
    draft_id: String,
    expected_revision: u64,
    confirmed_account: String,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation = Operation::begin(&app, &draft_id)?; let s = app.state::<AppState>();
        let adapter = Adapter::new()?; let credentials = bilibili::credentials()?; adapter.account(&credentials)?;
        let draft: PublicationDraft = s.db.lock().unwrap().get("publication_draft", &draft_id)?;
        if draft.revision != expected_revision || draft.account_id.as_deref() != Some(confirmed_account.as_str()) || confirmed_account != credentials.account_id { return Err("草稿或账号已改变，请重新确认".into()); }
        if draft.visibility != "public" || draft.title.trim().is_empty() || draft.parts.is_empty() { return Err("请填写标题并添加分 P".into()); }
        if !adapter.categories(&credentials)?.iter().any(|v| v.id == draft.category) { return Err("请选择当前账号可用分区".into()); }
        let mut videos = Vec::new();
        let uploads: Vec<UploadPart> = s.db.lock().unwrap().list("upload_part")?;
        for part in &draft.parts {
            let uploaded = uploads.iter().find(|p| p.draft_id == draft.id && p.part_id == part.id).ok_or("尚有分 P 未上传")?;
            if uploaded.status != "uploaded" || uploaded.confirmed_epoch != s.publication.epoch || uploaded.account_id != confirmed_account || Some(&uploaded.artifact_id) != part.artifact_id.as_ref() { return Err("分 P 上传结果需要重新核对".into()); }
            let artifact: ExportArtifact = s.db.lock().unwrap().get("artifact", &uploaded.artifact_id)?;
            artifacts::verify(&artifact, &operation.cancel)?;
            if artifact.file_sha256 != uploaded.file_sha256 { return Err("上传成片身份已改变".into()); }
            videos.push(json!({"filename":uploaded.remote.as_ref().ok_or("缺少远端文件标识")?.filename,"title":part.name,"desc":""}));
        }
        let cover = if draft.cover_path.is_empty() { String::new() } else {
            // Cover path was explicitly authorized when saving; restored drafts authorize only their own saved path.
            let metadata = std::fs::metadata(&draft.cover_path).map_err(|_| "封面不存在")?;
            if metadata.len() > 10 * 1024 * 1024 { return Err("封面超过本地读取上限 10 MB".into()); }
            let bytes = std::fs::read(&draft.cover_path).map_err(|_| "无法读取封面")?;
            let mime = if bytes.starts_with(&[0xff,0xd8,0xff]) { "image/jpeg" } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" } else { return Err("请选择 JPEG 或 PNG 封面".into()); };
            adapter.cover(&credentials, &bytes, mime)?
        };
        if operation.cancel.load(Ordering::SeqCst) { return Err("已取消，尚未提交稿件".into()); }
        let payload = json!({"copyright":1,"source":"","tid":draft.category,"title":draft.title,"desc":draft.description,"tag":draft.tags,"cover":cover,"videos":videos,"dynamic":"","no_reprint":1});
        let mut publication = claim_submission(&s.db.lock().unwrap(), &draft, payload, credentials.account_id.clone())?;
        notify(&app);
        // Once dispatched, cancellation/exit cannot establish whether the server accepted it.
        match adapter.submit(&credentials, &publication.payload) {
            Ok(data) => {
                publication.aid = data["aid"].as_u64(); publication.bvid = data["bvid"].as_str().map(str::to_string);
                publication.status = if publication.aid.is_some() { "submitted" } else { "unknown" }.into();
                if publication.aid.is_none() { publication.error = "平台未返回稿件标识，请人工核对".into(); }
            }
            Err(error) => { publication.status = "unknown".into(); publication.error = format!("{error}；结果待核实，禁止自动重试投稿"); }
        }
        s.db.lock().unwrap().put("publication", &publication.id, &publication)?;
        Ok(())
    }).await.map_err(crate::error)?
}
#[tauri::command]
pub fn publication_cancel(s: tauri::State<AppState>, draft_id: String) -> Result<()> {
    if has_intent(&s.db.lock().unwrap(), &draft_id)? {
        return Err("稿件已经发出，请等待结果并核对，不能直接标记为已取消".into());
    }
    if let Some(cancel) = s
        .cancels
        .lock()
        .unwrap()
        .get(&format!("publication:{draft_id}"))
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
pub async fn publication_check(app: tauri::AppHandle, publication_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = Operation::begin(&app, "check")?;
        let s = app.state::<AppState>();
        let mut publication: Publication =
            s.db.lock().unwrap().get("publication", &publication_id)?;
        let credentials = bilibili::credentials()?;
        if publication.account_id != credentials.account_id {
            return Err("请登录提交时使用的账号".into());
        }
        let aid = publication
            .aid
            .ok_or("未获得可靠稿件标识，无法自动核对；请打开创作中心人工核对，勿重复提交")?;
        publication.checked_ms = Some(artifacts::now_ms());
        match Adapter::new()?.archive(&credentials, aid) {
            Ok(archive) => {
                publication.platform_status = archive["state_desc"]
                    .as_str()
                    .unwrap_or("平台状态暂不可识别")
                    .into();
                publication.status = if archive["state"] == 0 {
                    "published"
                } else if archive["reject_reason"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty())
                {
                    "returned"
                } else {
                    "processing"
                }
                .into();
                publication.error.clear();
            }
            Err(error) => {
                publication.error = error;
            }
        }
        s.db.lock()
            .unwrap()
            .put("publication", &publication.id, &publication)?;
        Ok(())
    })
    .await
    .map_err(crate::error)?
}
#[tauri::command]
pub fn publication_open(s: tauri::State<AppState>, publication_id: Option<String>) -> Result<()> {
    let url = if let Some(id) = publication_id {
        let publication: Publication = s.db.lock().unwrap().get("publication", &id)?;
        publication
            .aid
            .map(|aid| format!("https://www.bilibili.com/video/av{aid}"))
            .unwrap_or_else(|| "https://member.bilibili.com/platform/upload-manager/article".into())
    } else {
        "https://member.bilibili.com/platform/upload-manager/article".into()
    };
    #[cfg(windows)]
    let mut command = crate::media::command("rundll32.exe");
    #[cfg(windows)]
    command.arg("url.dll,FileProtocolHandler");
    #[cfg(target_os = "macos")]
    let mut command = crate::media::command("open");
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = crate::media::command("xdg-open");
    command.arg(url).spawn().map_err(crate::error)?;
    Ok(())
}

#[tauri::command]
pub async fn publication_resolve(
    app: tauri::AppHandle,
    publication_id: String,
    aid: u64,
    user_confirmed: bool,
) -> Result<()> {
    if !user_confirmed || aid == 0 {
        return Err("请先在创作中心核对实际稿件，再确认关联".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = Operation::begin(&app, "resolve")?;
        let s = app.state::<AppState>();
        let mut publication: Publication =
            s.db.lock().unwrap().get("publication", &publication_id)?;
        if publication.status != "unknown" {
            return Err("此记录不需要人工关联".into());
        }
        let c = bilibili::credentials()?;
        if c.account_id != publication.account_id {
            return Err("请登录提交时使用的账号".into());
        }
        let archive = Adapter::new()?.archive(&c, aid)?;
        publication.aid = Some(aid);
        publication.bvid = archive["bvid"].as_str().map(str::to_string);
        publication.status = "submitted".into();
        publication.error.clear();
        publication.platform_status = "用户已在创作中心核对并关联稿件；可查询最新平台状态".into();
        publication.checked_ms = Some(artifacts::now_ms());
        s.db.lock()
            .unwrap()
            .put("publication", &publication.id, &publication)?;
        Ok(())
    })
    .await
    .map_err(crate::error)?
}

#[tauri::command]
pub async fn publication_capture_cover(
    app: tauri::AppHandle,
    artifact_id: String,
    time_us: i64,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation = Operation::begin(&app, "cover")?;
        let s = app.state::<AppState>();
        let artifact: ExportArtifact = s.db.lock().unwrap().get("artifact", &artifact_id)?;
        if time_us < 0 || time_us >= artifact.duration_us {
            return Err("封面时间超出成片范围".into());
        }
        artifacts::verify(&artifact, &operation.cancel)?;
        let dir = s.data.join("covers");
        std::fs::create_dir_all(&dir).map_err(crate::error)?;
        let path = dir.join(format!("{}.jpg", id()));
        crate::covers::capture(
            &crate::tools(&s).ffmpeg.path,
            &artifact.path,
            time_us,
            &path,
            &operation.cancel,
        )?;
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(crate::error)?;
        s.granted.lock().unwrap().push(path.clone());
        Ok(path.to_string_lossy().into())
    })
    .await
    .map_err(crate::error)?
}
