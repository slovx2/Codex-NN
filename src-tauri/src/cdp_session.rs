use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub struct CdpSession {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl CdpSession {
    pub async fn connect(websocket_url: &str, port: u16) -> Result<Self, String> {
        validate_websocket_url(websocket_url, port)?;
        let (socket, _) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connect_async(websocket_url),
        )
        .await
        .map_err(|_| "连接 CDP WebSocket 超时".to_string())?
        .map_err(|error| format!("连接 CDP WebSocket 失败：{error}"))?;
        Ok(Self { socket, next_id: 1 })
    }

    pub async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket
            .send(Message::Text(
                json!({ "id": id, "method": method, "params": params })
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|error| format!("发送 CDP 命令失败：{error}"))?;

        let response = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(message) = self.socket.next().await {
                let message = message.map_err(|error| format!("读取 CDP 响应失败：{error}"))?;
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text)
                    .map_err(|error| format!("CDP 响应格式错误：{error}"))?;
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    return Ok(value);
                }
            }
            Err("CDP WebSocket 已关闭".to_string())
        })
        .await
        .map_err(|_| format!("CDP 命令超时：{method}"))??;

        if let Some(error) = response.get("error") {
            return Err(format!("CDP {method} 失败：{error}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let result = self
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": false
                }),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(format!("注入脚本执行失败：{exception}"));
        }
        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }
}

fn validate_websocket_url(value: &str, port: u16) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|error| format!("CDP WebSocket URL 无效：{error}"))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "ws"
        || !matches!(host, "127.0.0.1" | "localhost" | "::1")
        || url.port() != Some(port)
    {
        return Err(format!("拒绝非回环 CDP WebSocket：{url}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_websocket_url;

    #[test]
    fn only_accepts_expected_loopback_port() {
        assert!(validate_websocket_url("ws://127.0.0.1:9341/devtools/page/1", 9341).is_ok());
        assert!(validate_websocket_url("ws://192.168.1.2:9341/devtools/page/1", 9341).is_err());
        assert!(validate_websocket_url("ws://127.0.0.1:9999/devtools/page/1", 9341).is_err());
    }
}
