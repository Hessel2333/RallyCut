//! Narrow web/UPOS adapter. Protocol reviewed against biliup commit
//! fbaf2046afd7688fa0ee9f8762734b449d00284c; see THIRD_PARTY_NOTICES.md.
//! No automatic submission, retries, credential logging, or redirects.
use crate::{artifacts::ExportArtifact, model::Result};
use base64::Engine;
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub account_id: String,
    cookie: String,
    csrf: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: u64,
    pub name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct UploadedVideo {
    pub filename: String,
}
pub struct QrChallenge {
    pub key: String,
    pub expires_ms: u64,
}
pub struct Adapter {
    client: Client,
    member: String,
    passport: String,
    api: String,
    #[cfg(test)]
    upload_origin: Option<String>,
}

fn network_error(_: reqwest::Error) -> String {
    "网络请求失败或超时，请检查连接后重试".into()
}
fn response(request: RequestBuilder) -> Result<Response> {
    let response = request.send().map_err(network_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "平台 HTTP {}；已停止请求",
            response.status().as_u16()
        ));
    }
    Ok(response)
}
fn decode(response: Response) -> Result<Value> {
    // Error messages and response bodies may contain authentication data. Never log them.
    response
        .json()
        .map_err(|_| "平台返回了无法识别的响应".into())
}
fn checked(value: Value) -> Result<Value> {
    match value["code"].as_i64() {
        Some(0) => Ok(value["data"].clone()),
        Some(-101 | -111) => Err("认证失效，请重新扫码登录".into()),
        Some(code) => Err(format!(
            "平台拒绝请求（代码 {code}），请在创作中心核对权限或限制"
        )),
        None => Err("平台响应缺少结果代码".into()),
    }
}
impl Adapter {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .user_agent("Mozilla/5.0 RallyCut/0.4")
                .build()
                .map_err(network_error)?,
            member: "https://member.bilibili.com".into(),
            passport: "https://passport.bilibili.com".into(),
            api: "https://api.bilibili.com".into(),
            #[cfg(test)]
            upload_origin: None,
        })
    }
    fn auth(&self, request: RequestBuilder, credentials: &Credentials) -> RequestBuilder {
        request
            .header("Cookie", &credentials.cookie)
            .header("Referer", "https://member.bilibili.com/")
    }
    pub fn qr(&self) -> Result<(QrChallenge, String)> {
        let data = checked(decode(response(
            self.client
                .get(format!(
                    "{}/x/passport-login/web/qrcode/generate",
                    self.passport
                ))
                .timeout(Duration::from_secs(15)),
        )?)?)?;
        let url = data["url"].as_str().ok_or("二维码响应不完整")?;
        let parsed = Url::parse(url).map_err(|_| "二维码地址无效")?;
        let known_endpoint = matches!(
            (parsed.host_str(), parsed.path()),
            (Some("account.bilibili.com"), "/h5/account-h5/auth/scan-web")
                | (Some("passport.bilibili.com"), "/h5-app/passport/login/scan")
        );
        if parsed.scheme() != "https"
            || parsed.port_or_known_default() != Some(443)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || !known_endpoint
        {
            return Err("二维码来源无效".into());
        }
        let key = data["qrcode_key"]
            .as_str()
            .ok_or("二维码响应不完整")?
            .to_string();
        let svg = qrcode::QrCode::new(url)
            .map_err(|_| "二维码生成失败")?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .build();
        Ok((
            QrChallenge {
                key,
                expires_ms: crate::artifacts::now_ms() + 180_000,
            },
            format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg)
            ),
        ))
    }
    pub fn poll_qr(&self, challenge: &QrChallenge) -> Result<Option<Credentials>> {
        if crate::artifacts::now_ms() > challenge.expires_ms {
            return Err("二维码已过期，请重新生成".into());
        }
        let response = response(
            self.client
                .get(format!(
                    "{}/x/passport-login/web/qrcode/poll",
                    self.passport
                ))
                .query(&[("qrcode_key", &challenge.key)]),
        )?;
        let mut cookies = std::collections::BTreeMap::new();
        for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(text) = header.to_str() {
                if let Some((key, value)) = text.split(';').next().and_then(|s| s.split_once('=')) {
                    if ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"].contains(&key) {
                        cookies.insert(key.to_string(), value.to_string());
                    }
                }
            }
        }
        let data = checked(decode(response)?)?;
        match data["code"].as_i64() {
            Some(86101 | 86090) => Ok(None),
            Some(86038) => Err("二维码已过期，请重新生成".into()),
            Some(0) => {
                if !cookies.contains_key("SESSDATA") {
                    return Err("平台未返回登录凭据".into());
                }
                Ok(Some(Credentials {
                    account_id: cookies.get("DedeUserID").ok_or("缺少账号标识")?.clone(),
                    csrf: cookies.get("bili_jct").ok_or("缺少登录校验凭据")?.clone(),
                    cookie: cookies
                        .iter()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join("; "),
                }))
            }
            _ => Err("扫码登录未成功，请重新生成二维码".into()),
        }
    }
    pub fn account(&self, c: &Credentials) -> Result<Account> {
        let data = checked(decode(response(self.auth(
            self.client.get(format!("{}/x/web-interface/nav", self.api)),
            c,
        ))?)?)?;
        let id = data["mid"]
            .as_u64()
            .ok_or("认证失效，请重新登录")?
            .to_string();
        if id != c.account_id {
            return Err("账号身份发生变化，请重新登录".into());
        }
        Ok(Account {
            id,
            name: data["uname"].as_str().ok_or("缺少账号名称")?.into(),
        })
    }
    pub fn categories(&self, c: &Credentials) -> Result<Vec<Category>> {
        let data = checked(decode(response(
            self.auth(
                self.client
                    .get(format!("{}/x/vupre/web/archive/pre", self.member)),
                c,
            ),
        )?)?)?;
        let mut result = Vec::new();
        fn walk(v: &Value, out: &mut Vec<Category>) {
            if let Some(obj) = v.as_object() {
                if let (Some(id), Some(name)) = (
                    obj.get("id")
                        .or_else(|| obj.get("tid"))
                        .and_then(Value::as_u64),
                    obj.get("name").and_then(Value::as_str),
                ) {
                    if !obj.contains_key("children")
                        || obj["children"].as_array().is_some_and(Vec::is_empty)
                    {
                        out.push(Category {
                            id,
                            name: name.into(),
                        });
                    }
                }
                for child in obj.values() {
                    walk(child, out);
                }
            } else if let Some(list) = v.as_array() {
                for child in list {
                    walk(child, out);
                }
            }
        }
        // Do not treat unrelated IDs in account capabilities as category IDs.
        for key in ["typelist", "type_list", "types"] {
            if let Some(v) = data.get(key) {
                walk(v, &mut result);
            }
        }
        result.sort_by_key(|v| v.id);
        result.dedup_by_key(|v| v.id);
        if result.is_empty() {
            return Err("暂时无法读取账号可用分区，投稿已停用；请使用创作中心核对".into());
        }
        Ok(result)
    }
    pub fn upload(
        &self,
        c: &Credentials,
        artifact: &ExportArtifact,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64) -> Result<()>,
    ) -> Result<UploadedVideo> {
        crate::artifacts::verify(artifact, cancel)?;
        self.account(c)?;
        let name = Path::new(&artifact.path)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("文件名称无效")?;
        let bucket = decode(response(
            self.auth(self.client.get(format!("{}/preupload", self.member)), c)
                .query(&[
                    ("name", name.to_string()),
                    ("r", "upos".into()),
                    ("profile", "ugcupos/bup".into()),
                    ("ssl", "1".into()),
                    ("version", "2.14.0".into()),
                    ("build", "2140000".into()),
                    ("size", artifact.size.to_string()),
                ]),
        )?)?;
        if bucket["code"].as_i64().is_some_and(|code| code != 0) {
            checked(bucket.clone())?;
        }
        let endpoint = bucket["endpoint"]
            .as_str()
            .ok_or("平台未返回可用上传线路")?;
        let uri = bucket["upos_uri"]
            .as_str()
            .and_then(|s| s.strip_prefix("upos://"))
            .ok_or("上传路径无效")?;
        let url = format!("https:{endpoint}/{uri}");
        #[cfg(not(test))]
        validate_upload_url(&url)?;
        #[cfg(test)]
        let url = if let Some(origin) = &self.upload_origin {
            format!("{origin}/{uri}")
        } else {
            validate_upload_url(&url)?;
            url
        };
        let auth = bucket["auth"].as_str().ok_or("上传授权缺失")?;
        let chunk_size = bucket["chunk_size"]
            .as_u64()
            .filter(|n| (1..=32 * 1024 * 1024).contains(n))
            .ok_or("上传分块大小不受支持")?;
        let started = decode(response(
            self.client
                .post(&url)
                .query(&[("uploads", ""), ("output", "json")])
                .header("X-Upos-Auth", auth),
        )?)?;
        let upload_id = started["upload_id"].as_str().ok_or("上传会话创建失败")?;
        let mut file = File::open(&artifact.path).map_err(|_| "无法读取成片")?;
        let mut sent = 0;
        let mut parts = Vec::new();
        let mut digest = sha2::Sha256::new();
        use sha2::Digest;
        while sent < artifact.size {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消上传".into());
            }
            let size = chunk_size.min(artifact.size - sent);
            let mut bytes = vec![0; size as usize];
            file.read_exact(&mut bytes)
                .map_err(|_| "成片读取失败或内容已改变")?;
            digest.update(&bytes);
            let index = parts.len();
            response(self.client.put(&url).header("X-Upos-Auth", auth).query(&json!({"uploadId":upload_id,"chunks":artifact.size.div_ceil(chunk_size),"total":artifact.size,"chunk":index,"size":size,"partNumber":index+1,"start":sent,"end":sent+size})).body(bytes))?;
            parts.push(json!({"partNumber":index+1,"eTag":"etag"}));
            sent += size;
            progress(sent)?;
        }
        if format!("{:x}", digest.finalize()) != artifact.file_sha256 {
            return Err("上传过程中成片内容改变，已停止合并".into());
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消上传".into());
        }
        let completed = decode(response(
            self.client
                .post(&url)
                .header("X-Upos-Auth", auth)
                .query(&[
                    ("name", name.to_string()),
                    ("uploadId", upload_id.into()),
                    ("biz_id", bucket["biz_id"].to_string()),
                    ("output", "json".into()),
                    ("profile", "ugcupos/bup".into()),
                ])
                .json(&json!({"parts":parts})),
        )?)?;
        if completed["OK"] != 1 {
            return Err("平台未确认文件上传完成，请重试该分 P".into());
        }
        Ok(UploadedVideo {
            filename: Path::new(uri)
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("远端文件标识无效")?
                .into(),
        })
    }
    pub fn cover(&self, c: &Credentials, bytes: &[u8], mime: &str) -> Result<String> {
        let data = checked(decode(response(self.auth(self.client.post(format!("{}/x/vu/web/cover/up", self.member)), c).json(&json!({"csrf":c.csrf,"cover":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))})))?)?)?;
        let url = data["url"].as_str().ok_or("封面上传未成功")?;
        let normalized = if url.starts_with("//") {
            format!("https:{url}")
        } else {
            url.to_string()
        };
        let parsed = Url::parse(&normalized).map_err(|_| "封面地址无效")?;
        if parsed.scheme() != "https"
            || !parsed.host_str().is_some_and(|h| h.ends_with(".hdslb.com"))
        {
            return Err("平台返回了不受支持的封面地址".into());
        }
        Ok(normalized)
    }
    /// Transport failures are ambiguous: callers must persist an intent BEFORE calling.
    pub fn submit(&self, c: &Credentials, payload: &Value) -> Result<Value> {
        checked(decode(response(
            self.auth(
                self.client.post(format!("{}/x/vu/web/add/v3", self.member)),
                c,
            )
            .query(&[("csrf", &c.csrf)])
            .json(payload),
        )?)?)
    }
    pub fn archive(&self, c: &Credentials, aid: u64) -> Result<Value> {
        for page in 1..=5 {
            let data = checked(decode(response(
                self.auth(
                    self.client.get(format!("{}/x/web/archives", self.member)),
                    c,
                )
                .query(&[
                    ("status", "is_pubing,pubed,not_pubed".to_string()),
                    ("pn", page.to_string()),
                ]),
            )?)?)?;
            let list = data["arc_audits"]
                .as_array()
                .ok_or("稿件列表结构无法识别")?;
            for item in list {
                if item["Archive"]["aid"].as_u64() == Some(aid) {
                    return Ok(item["Archive"].clone());
                }
            }
            let count = data["page"]["count"].as_u64().ok_or("稿件分页信息缺失")?;
            let size = data["page"]["ps"]
                .as_u64()
                .filter(|s| *s > 0)
                .ok_or("稿件分页信息缺失")?;
            if page as u64 * size >= count {
                break;
            }
        }
        Err("最近稿件中未查到此记录，请在创作中心核对；当前状态未改变".into())
    }
}
pub fn validate_upload_url(text: &str) -> Result<()> {
    let u = Url::parse(text).map_err(|_| "上传地址无效")?;
    if u.scheme() != "https"
        || u.port_or_known_default() != Some(443)
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !u
            .host_str()
            .is_some_and(|h| h.ends_with(".bilivideo.com") || h.ends_with(".bilibili.com"))
    {
        return Err("拒绝不受信任的上传地址".into());
    }
    Ok(())
}
fn vault() -> Result<keyring::Entry> {
    if !cfg!(any(target_os = "windows", target_os = "macos")) {
        return Err("此平台尚未配置受保护凭据存储，登录不可用".into());
    }
    keyring::Entry::new("local.rallycut.desktop.bilibili", "single-account")
        .map_err(|_| "无法访问系统凭据存储".into())
}
pub fn credentials() -> Result<Credentials> {
    let secret = vault()?.get_password().map_err(|_| "请先扫码登录 B 站")?;
    serde_json::from_str(&secret).map_err(|_| "本机登录凭据无效，请重新登录".into())
}
pub fn save_credentials(c: &Credentials) -> Result<()> {
    vault()?
        .set_password(&serde_json::to_string(c).map_err(|_| "凭据编码失败")?)
        .map_err(|_| "无法保存到系统凭据存储，登录未保留".into())
}
pub fn logout() -> Result<()> {
    match vault()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除系统凭据，请重试".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    #[ignore = "Writes a unique non-production test entry to the native OS credential store"]
    fn native_credential_store_roundtrip() {
        assert!(
            cfg!(any(target_os = "windows", target_os = "macos")),
            "native vault platform required"
        );
        let name = format!("rallycut-test-{}", crate::model::id());
        let entry = keyring::Entry::new("local.rallycut.test-only", &name).unwrap();
        entry.set_password("synthetic-test-value").unwrap();
        let value = entry.get_password();
        entry.delete_credential().unwrap();
        assert_eq!(value.unwrap(), "synthetic-test-value");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
    fn server(
        replies: Vec<(&'static str, Option<(u16, Value)>)>,
    ) -> (Adapter, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (expected, reply) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut input = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    input.extend_from_slice(&buffer[..n]);
                    if let Some(pos) = input.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&input[..pos]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if input.len() >= pos + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&input).into_owned();
                assert!(
                    request.lines().next().unwrap().contains(expected),
                    "unexpected test request"
                );
                requests.push(request);
                if let Some((status, body)) = reply {
                    let body = body.to_string();
                    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                } else {
                    thread::sleep(Duration::from_millis(350));
                }
            }
            requests
        });
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        (
            Adapter {
                client,
                member: origin.clone(),
                passport: origin.clone(),
                api: origin.clone(),
                upload_origin: Some(origin),
            },
            handle,
        )
    }
    #[test]
    fn qr_accepts_current_account_origin_and_rejects_untrusted_urls() {
        for (url, accepted) in [
            ("https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=test", true),
            ("https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=test", true),
            ("https://account.bilibili.com.evil.example/h5/account-h5/auth/scan-web", false),
            ("http://account.bilibili.com/h5/account-h5/auth/scan-web", false),
            ("https://user@account.bilibili.com/h5/account-h5/auth/scan-web", false),
            ("https://account.bilibili.com:444/h5/account-h5/auth/scan-web", false),
            ("https://account.bilibili.com/unexpected", false),
        ] {
            let (adapter, handle) = server(vec![("/x/passport-login/web/qrcode/generate", Some((200, json!({"code":0,"data":{"url":url,"qrcode_key":"synthetic-test-key"}}))))]);
            let result = adapter.qr();
            handle.join().unwrap();
            assert_eq!(result.is_ok(), accepted, "unexpected QR origin result for {url}");
            if let Ok((challenge, image)) = result {
                assert_eq!(challenge.key, "synthetic-test-key");
                assert!(image.starts_with("data:image/svg+xml;base64,"));
            }
        }
    }
    fn test_credentials() -> Credentials {
        Credentials {
            account_id: "42".into(),
            cookie: "SESSDATA=test-only".into(),
            csrf: "test-only".into(),
        }
    }
    #[test]
    fn rate_limit_and_expired_auth_stop_without_retry_or_secret_disclosure() {
        for reply in [
            (429, json!({"message":"SESSDATA=do-not-expose"})),
            (200, json!({"code":-101,"message":"secret"})),
        ] {
            let (adapter, handle) = server(vec![("/x/web-interface/nav", Some(reply))]);
            let error = adapter.account(&test_credentials()).err().unwrap();
            assert!(!error.contains("SESSDATA"));
            assert!(!error.contains("secret"));
            assert_eq!(handle.join().unwrap().len(), 1);
        }
    }
    #[test]
    fn accepted_submission_lost_response_is_not_retried_after_restart() {
        use crate::{publication::*, store::Store};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drafts.sqlite3");
        let db = Store::open(&path).unwrap();
        let draft = PublicationDraft {
            id: "draft".into(),
            revision: 1,
            account_id: Some("42".into()),
            title: "test".into(),
            description: "".into(),
            cover_path: "".into(),
            category: 1,
            tags: "test".into(),
            visibility: "public".into(),
            parts: vec![],
            status: "awaiting_confirmation".into(),
            error: "".into(),
        };
        db.put("publication_draft", &draft.id, &draft).unwrap();
        let payload = json!({"videos":[{"filename":"second","title":"P1"},{"filename":"first","title":"P2"}]});
        let intent = claim_submission(&db, &draft, payload.clone(), "42".into()).unwrap();
        let (adapter, handle) = server(vec![("/x/vu/web/add/v3", None)]);
        assert!(adapter
            .submit(&test_credentials(), &intent.payload)
            .is_err());
        assert!(claim_submission(&db, &draft, payload.clone(), "42".into()).is_err());
        drop(db);
        let db = Store::open(&path).unwrap();
        assert_eq!(
            db.get::<Publication>("publication", &intent.id)
                .unwrap()
                .status,
            "unknown"
        );
        assert!(claim_submission(&db, &draft, payload, "42".into()).is_err());
        let requests = handle.join().unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["videos"][0]["filename"], "second");
    }
    #[test]
    fn upos_transfer_never_submits_and_reports_acknowledged_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("part.mp4");
        std::fs::write(&file, b"123456").unwrap();
        let artifact: ExportArtifact = serde_json::from_value(json!({"id":"a","session_id":null,"match_id":null,"content_fingerprint":"source","segment":null,"preset":null,"path":file,"size":6,"duration_us":1,"codec":"h264","validation":"fixture","file_sha256":crate::media::hash_file(&file,&AtomicBool::new(false), |_|{}).unwrap(),"created_ms":0,"availability":"available"})).unwrap();
        let (adapter, handle) = server(vec![
            (
                "/x/web-interface/nav",
                Some((200, json!({"code":0,"data":{"mid":42,"uname":"Test"}}))),
            ),
            (
                "/preupload",
                Some((
                    200,
                    json!({"endpoint":"//test.bilivideo.com","upos_uri":"upos://ugc/test.mp4","auth":"test-only","chunk_size":4,"biz_id":7}),
                )),
            ),
            (
                "POST /ugc/test.mp4",
                Some((200, json!({"upload_id":"test-id"}))),
            ),
            ("PUT /ugc/test.mp4", Some((200, json!({})))),
            ("PUT /ugc/test.mp4", Some((200, json!({})))),
            ("POST /ugc/test.mp4", Some((200, json!({"OK":1})))),
        ]);
        let mut bytes = Vec::new();
        let result = adapter
            .upload(
                &test_credentials(),
                &artifact,
                &AtomicBool::new(false),
                |n| {
                    bytes.push(n);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(result.filename, "test");
        assert_eq!(bytes, vec![4, 6]);
        let requests = handle.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests.iter().all(|r| !r.contains("/add/")));
        assert!(!requests[2].contains("SESSDATA"));
    }
    #[test]
    fn upload_targets_are_constrained() {
        assert!(
            validate_upload_url("https://upos-sz-upcdnbda2.bilivideo.com/ugc/file.mp4").is_ok()
        );
        for url in [
            "http://upos.bilivideo.com/f",
            "https://bilibili.com.evil.test/f",
            "https://127.0.0.1/f",
            "https://evil.test/f",
            "https://u:p@upos.bilivideo.com/f",
            "https://upos.bilivideo.com:444/f",
        ] {
            assert!(validate_upload_url(url).is_err());
        }
    }
    #[test]
    fn partial_failure_preserves_success_and_retry_only_transfers_failed_part() {
        use crate::{publication::*, store::Store};
        use std::sync::Mutex;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let db = Mutex::new(Store::open(&path).unwrap());
        let file = dir.path().join("part.mp4");
        std::fs::write(&file, b"1234").unwrap();
        let artifact: ExportArtifact = serde_json::from_value(json!({"id":"a","session_id":null,"match_id":null,"content_fingerprint":"source","segment":null,"preset":null,"path":file,"size":4,"duration_us":1,"codec":"h264","validation":"fixture","file_sha256":crate::media::hash_file(&file,&AtomicBool::new(false), |_|{}).unwrap(),"created_ms":0,"availability":"available"})).unwrap();
        db.lock().unwrap().put("artifact", "a", &artifact).unwrap();
        let draft = PublicationDraft {
            id: "d".into(),
            revision: 1,
            account_id: Some("42".into()),
            title: "test".into(),
            description: "".into(),
            cover_path: "".into(),
            category: 1,
            tags: "".into(),
            visibility: "public".into(),
            status: "draft".into(),
            error: "".into(),
            parts: ["p2", "p1"]
                .map(|id| DraftPart {
                    id: id.into(),
                    artifact_id: Some("a".into()),
                    job_id: None,
                    name: id.into(),
                })
                .to_vec(),
        };
        let success = || {
            vec![
                (
                    "/x/web-interface/nav",
                    Some((200, json!({"code":0,"data":{"mid":42,"uname":"Test"}}))),
                ),
                (
                    "/preupload",
                    Some((
                        200,
                        json!({"endpoint":"//test.bilivideo.com","upos_uri":"upos://ugc/test.mp4","auth":"test","chunk_size":4,"biz_id":7}),
                    )),
                ),
                (
                    "POST /ugc/test.mp4",
                    Some((200, json!({"upload_id":"test"}))),
                ),
                ("PUT /ugc/test.mp4", Some((200, json!({})))),
                ("POST /ugc/test.mp4", Some((200, json!({"OK":1})))),
            ]
        };
        let mut replies = success();
        replies.push(("/x/web-interface/nav", Some((429, json!({})))));
        let (adapter, handle) = server(replies);
        let cancel = AtomicBool::new(false);
        assert!(transfer_parts(
            &db,
            &adapter,
            &test_credentials(),
            &draft,
            &cancel,
            "epoch",
            false,
            |_| {}
        )
        .is_err());
        assert_eq!(handle.join().unwrap().len(), 6);
        assert_eq!(
            db.lock()
                .unwrap()
                .get::<UploadPart>("upload_part", "d:p2")
                .unwrap()
                .status,
            "uploaded"
        );
        assert_eq!(
            db.lock()
                .unwrap()
                .get::<UploadPart>("upload_part", "d:p1")
                .unwrap()
                .status,
            "failed"
        );
        let (adapter, handle) = server(success());
        transfer_parts(
            &db,
            &adapter,
            &test_credentials(),
            &draft,
            &cancel,
            "epoch",
            false,
            |_| {},
        )
        .unwrap();
        assert_eq!(handle.join().unwrap().len(), 5);
        let first: UploadPart = db.lock().unwrap().get("upload_part", "d:p2").unwrap();
        assert_eq!(first.attempts, 1);
        assert_eq!(
            db.lock()
                .unwrap()
                .get::<UploadPart>("upload_part", "d:p1")
                .unwrap()
                .attempts,
            2
        );
        drop(db);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened
                .get::<UploadPart>("upload_part", "d:p2")
                .unwrap()
                .status,
            "uploaded_unverified"
        );
        assert!(reopened.get::<ExportArtifact>("artifact", "a").is_ok());
        drop(reopened);
        let twice = Store::open(&path).unwrap();
        assert_eq!(twice.list::<UploadPart>("upload_part").unwrap().len(), 2);
    }
}
