use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::Method;
use serde_json::{json, Value};

use crate::agent_api::{AgentApiStateFile, AGENT_API_STATE_RELATIVE_PATH};

const SERVER_NAME: &str = "codex-nn";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run() -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("无法启动 Codex NN MCP：{error}");
            return 1;
        }
    };
    match runtime.block_on(run_mcp()) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Codex NN MCP 已停止：{error}");
            1
        }
    }
}

async fn run_mcp() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_mcp_line(line.trim()).await {
            writeln!(
                stdout,
                "{}",
                serde_json::to_string(&response).map_err(|error| error.to_string())?
            )
            .map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn handle_mcp_line(line: &str) -> Option<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(error) => return Some(mcp_error(Value::Null, -32700, error.to_string())),
    };
    if message.get("method").and_then(Value::as_str) == Some("notifications/initialized") {
        return None;
    }
    let Some(id) = message.get("id").cloned() else {
        return None;
    };
    match handle_mcp_request(&message).await {
        Ok(result) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err(error) => Some(mcp_error(id, -32000, error)),
    }
}

async fn handle_mcp_request(message: &Value) -> Result<Value, String> {
    match message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "initialize" => Ok(json!({
            "protocolVersion": message
                .pointer("/params/protocolVersion")
                .cloned()
                .unwrap_or_else(|| Value::String("2024-11-05".into())),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        })),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少 MCP 工具名称".to_string())?;
            let arguments = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(name, arguments).await {
                Ok(payload) => Ok(tool_result(payload, false)),
                Err(error) => Ok(tool_result(json!({ "error": error }), true)),
            }
        }
        "ping" => Ok(json!({})),
        method => Err(format!("不支持的 MCP 方法：{method}")),
    }
}

async fn call_tool(name: &str, input: Value) -> Result<Value, String> {
    match name {
        "codex_nn_list_themes" => request_json(Method::GET, "/agent/v1/themes", None).await,
        "codex_nn_install_theme" => {
            let package_path = required_absolute_zip(&input)?;
            request_json(
                Method::POST,
                "/agent/v1/themes/install",
                Some(json!({ "packagePath": package_path })),
            )
            .await
        }
        "codex_nn_update_theme" => {
            let package_path = required_absolute_zip(&input)?;
            request_json(
                Method::POST,
                "/agent/v1/themes/update",
                Some(json!({ "packagePath": package_path })),
            )
            .await
        }
        "codex_nn_activate_theme" => {
            request_json(
                Method::POST,
                "/agent/v1/themes/activate",
                Some(json!({ "id": required_id(&input)? })),
            )
            .await
        }
        "codex_nn_delete_theme" => {
            request_json(
                Method::POST,
                "/agent/v1/themes/delete",
                Some(json!({ "id": required_id(&input)? })),
            )
            .await
        }
        "codex_nn_apply_theme" => {
            request_json(Method::POST, "/agent/v1/theme/apply", Some(json!({}))).await
        }
        "codex_nn_launch_codex" => {
            request_json(Method::POST, "/agent/v1/codex/launch", Some(json!({}))).await
        }
        "codex_nn_diagnose" => request_json(Method::GET, "/agent/v1/diagnostics", None).await,
        _ => Err(format!("未知工具：{name}")),
    }
}

async fn request_json(method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let state_path = agent_state_path()?;
    let state = read_agent_state(&state_path)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(70))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{}{path}", state.port);
    let mut request = client.request(method, url).bearer_auth(&state.token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| {
        format!(
            "无法连接 Codex NN App：{error}。请确认 Codex NN 正在运行；若 CDP 异常，请从 App 启动或重启 Codex。"
        )
    })?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    let payload: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).map_err(|error| format!("Agent API 返回无效 JSON：{error}"))?
    };
    if !status.is_success() || payload.get("ok") == Some(&Value::Bool(false)) {
        return Err(api_error_message(&payload));
    }
    Ok(payload.get("data").cloned().unwrap_or(payload))
}

fn agent_state_path() -> Result<PathBuf, String> {
    let root = std::env::var_os("CODEX_NN_APP_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|path| path.join("com.slovx2.codexnn")))
        .ok_or_else(|| "无法定位 Codex NN 应用数据目录".to_string())?;
    Ok(root.join(AGENT_API_STATE_RELATIVE_PATH))
}

fn read_agent_state(path: &Path) -> Result<AgentApiStateFile, String> {
    let bytes = fs::read(path).map_err(|_| {
        format!(
            "Codex NN Agent API 未运行。请先打开 Codex NN。状态文件：{}",
            path.display()
        )
    })?;
    let state: AgentApiStateFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Codex NN Agent API 状态损坏：{error}"))?;
    if state.schema_version != 1 || state.port == 0 || state.token.len() < 32 {
        return Err("Codex NN Agent API 状态无效，请重启 Codex NN".into());
    }
    Ok(state)
}

fn required_absolute_zip(input: &Value) -> Result<String, String> {
    let value = input
        .get("package_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "package_path 必填".to_string())?;
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("zip"))
    {
        return Err("package_path 必须是绝对 ZIP 路径".into());
    }
    Ok(value.to_string())
}

fn required_id(input: &Value) -> Result<&str, String> {
    input
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "id 必填".to_string())
}

fn api_error_message(payload: &Value) -> String {
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Codex NN 操作失败");
    match payload
        .pointer("/error/recovery")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        Some(recovery) => format!("{message}\n处理方法：{recovery}"),
        None => message.to_string(),
    }
}

fn tool_result(payload: Value, is_error: bool) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string()),
        }],
        "isError": is_error,
    })
}

fn mcp_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "codex_nn_list_themes",
            "description": "列出 Codex NN 主题、当前主题和会话状态。",
            "inputSchema": empty_schema(),
            "annotations": { "readOnlyHint": true, "destructiveHint": false }
        },
        {
            "name": "codex_nn_install_theme",
            "description": "安装新的 Codex NN schema v1 主题 ZIP；同 ID 已存在时返回更新确认信息。",
            "inputSchema": package_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": false }
        },
        {
            "name": "codex_nn_update_theme",
            "description": "用 schema v1 主题 ZIP 更新同 ID 主题，并在当前主题活动时热更新。",
            "inputSchema": package_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "codex_nn_activate_theme",
            "description": "切换当前主题；活动会话会立即热切换。",
            "inputSchema": id_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": false }
        },
        {
            "name": "codex_nn_delete_theme",
            "description": "删除一个已安装的自定义主题；内置主题受保护。",
            "inputSchema": id_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "codex_nn_apply_theme",
            "description": "向当前由 Codex NN 管理的 Codex CDP 会话重新应用主题。",
            "inputSchema": empty_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": false }
        },
        {
            "name": "codex_nn_launch_codex",
            "description": "从 Codex NN 启动或重启 Codex，并建立受管理的 CDP 主题会话。",
            "inputSchema": empty_schema(),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "codex_nn_diagnose",
            "description": "返回 App、Codex、CDP、当前主题、主题列表、恢复建议和日志路径。",
            "inputSchema": empty_schema(),
            "annotations": { "readOnlyHint": true, "destructiveHint": false }
        }
    ])
}

fn empty_schema() -> Value {
    json!({ "type": "object", "additionalProperties": false, "properties": {} })
}

fn package_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["package_path"],
        "properties": {
            "package_path": {
                "type": "string",
                "description": "Codex NN schema v1 主题 ZIP 的绝对路径。"
            }
        }
    })
}

fn id_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["id"],
        "properties": {
            "id": { "type": "string", "description": "主题 ID。" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_all_theme_and_diagnostic_tools() {
        let response =
            handle_mcp_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
                .await
                .unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().any(|tool| tool["name"] == "codex_nn_diagnose"));
    }

    #[tokio::test]
    async fn initialize_reports_server_identity() {
        let response = handle_mcp_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        )
        .await
        .unwrap();
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn rejects_relative_package_paths() {
        let error = required_absolute_zip(&json!({ "package_path": "theme.zip" })).unwrap_err();
        assert!(error.contains("绝对 ZIP 路径"));
    }

    #[test]
    fn joins_api_recovery_with_error() {
        let message = api_error_message(&json!({
            "error": { "message": "CDP 不可用", "recovery": "从 App 重启 Codex" }
        }));
        assert!(message.contains("处理方法"));
    }
}
