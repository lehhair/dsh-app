//! remote-gateway auth, unchanged from the Electron app: POST
//! `/_gateway/login` (form `key=…&next=/`), read the `dsh_gateway_key`
//! Set-Cookie from the 302, and hand it to the webview cookie store.
//! Bare dsh web has no auth at all (200 without credentials).

use cookie::Cookie;
use std::time::Duration;
use url::Url;

pub const GATEWAY_LOGIN_PATH: &str = "/_gateway/login";
pub const GATEWAY_COOKIE_NAME: &str = "dsh_gateway_key";

/// POST the gateway login endpoint; returns the raw cookie value on success.
pub async fn ensure_gateway_session(base: &str, key: &str) -> Result<String, String> {
  let client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .timeout(Duration::from_secs(8))
    .build()
    .map_err(|e| e.to_string())?;

  let login_url = format!("{}/_gateway/login", base.trim_end_matches('/'));
  let body = url::form_urlencoded::Serializer::new(String::new())
    .append_pair("key", key)
    .append_pair("next", "/")
    .finish();

  let response = client
    .post(&login_url)
    .header("content-type", "application/x-www-form-urlencoded")
    .body(body)
    .send()
    .await
    .map_err(|e| format!("无法连接网关：{e}"))?;

  let status = response.status();
  let set_cookies: Vec<String> = response
    .headers()
    .get_all(reqwest::header::SET_COOKIE)
    .iter()
    .filter_map(|value| value.to_str().ok())
    .map(str::to_string)
    .collect();

  if status == reqwest::StatusCode::FOUND {
    for header in &set_cookies {
      let pair = header.split(';').next().unwrap_or("");
      if let Some(value) = pair.strip_prefix(&format!("{GATEWAY_COOKIE_NAME}=")) {
        return Ok(value.to_string());
      }
    }
  }

  if status == reqwest::StatusCode::UNAUTHORIZED {
    return Err("访问密钥无效".into());
  }
  Err(format!("网关响应异常（{}）", status.as_u16()))
}

/// Build the session cookie to set on the webview for `url`.
pub fn build_cookie(base: &str, value: &str) -> Result<Cookie<'static>, String> {
  let parsed = Url::parse(base).map_err(|_| "地址无效".to_string())?;
  let host = parsed.host_str().ok_or("地址无效")?.to_string();
  let secure = parsed.scheme() == "https";
  Ok(
    Cookie::build((GATEWAY_COOKIE_NAME, value.to_string()))
      .domain(host)
      .path("/")
      .http_only(true)
      .same_site(cookie::SameSite::Strict)
      .secure(secure)
      .build(),
  )
}

/// Probe a node root: 200 = online, 401 = needs a (valid) key, else offline.
pub async fn check_remote_health(base: &str, key: Option<&str>) -> String {
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(5))
    .build()
    .unwrap_or_default();
  let mut request = client.get(base);
  if let Some(key) = key {
    request = request.header("authorization", format!("Bearer {key}"));
  }
  match request.send().await {
    Ok(response) => match response.status().as_u16() {
      200 => "online".into(),
      401 => "unauthorized".into(),
      _ => "offline".into(),
    },
    Err(_) => "offline".into(),
  }
}
