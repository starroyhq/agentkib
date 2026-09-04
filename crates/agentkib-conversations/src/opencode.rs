use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use agentkib_core::AgentKind;
use agentkib_platform::command;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    ConversationEvent, ConversationEventKind, ConversationEventPage, ConversationProvider,
    HandoffContext, NativeSessionSummary, SessionAttachmentKind, SessionBlock, SessionDocument,
    SessionLossCode, SessionRole, SessionTurn, finish_document,
};

const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

pub struct OpenCodeProvider {
    workspace: Mutex<Option<std::path::PathBuf>>,
}

impl Default for OpenCodeProvider {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ListedSession {
    id: String,
    title: Option<String>,
    updated: Option<i64>,
    created: Option<i64>,
    #[serde(rename = "directory")]
    directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportedSession {
    #[allow(dead_code)]
    info: Value,
    messages: Vec<ExportedMessage>,
}

#[derive(Debug, Deserialize)]
struct ExportedMessage {
    info: ExportedMessageInfo,
    parts: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct ExportedMessageInfo {
    id: String,
    role: String,
    time: Option<ExportedTime>,
}

#[derive(Debug, Deserialize)]
struct ExportedTime {
    created: Option<i64>,
}

impl ConversationProvider for OpenCodeProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::OpenCode
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        if let Ok(mut current) = self.workspace.lock() {
            *current = Some(workspace.to_path_buf());
        }
        let Some(executable) = command::resolve("opencode") else {
            return Ok(Vec::new());
        };
        let output = Command::new(executable)
            .current_dir(workspace)
            .args(["session", "list", "--format", "json"])
            .output()
            .context("Unable to inspect OpenCode sessions")?;
        if !output.status.success() {
            bail!(
                "OpenCode session listing failed: {}",
                stderr(&output.stderr)
            );
        }
        let sessions: Vec<ListedSession> = serde_json::from_slice(&output.stdout)
            .context("OpenCode returned an invalid session list")?;
        Ok(sessions
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.id,
                agent: AgentKind::OpenCode,
                title: clean_title(session.title.as_deref()),
                created_at: timestamp(session.created),
                updated_at: timestamp(session.updated),
                message_count: None,
                git_branch: None,
                archived: false,
                sidechain: false,
                availability: if session.directory.is_some() {
                    crate::SessionAvailability::Readable
                } else {
                    crate::SessionAvailability::MetadataOnly
                },
            })
            .collect())
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let exported = self.export(native_ref)?;
        let mut events = Vec::new();
        for message in exported.messages {
            let timestamp = message
                .info
                .time
                .as_ref()
                .and_then(|time| timestamp(time.created));
            let kind = match message.info.role.as_str() {
                "user" => ConversationEventKind::UserMessage,
                "assistant" => ConversationEventKind::AgentMessage,
                _ => continue,
            };
            let (content, tool_count, attachment_count) = summarize_parts(&message.parts);
            if !content.trim().is_empty() || tool_count > 0 || attachment_count > 0 {
                events.push(ConversationEvent {
                    id: message.info.id,
                    kind,
                    timestamp,
                    content: (!content.trim().is_empty()).then_some(content),
                    tool_name: None,
                    tool_status: None,
                    duration_ms: None,
                    attachment_count,
                    truncated: false,
                });
            }
        }
        Ok(page_events(events, cursor, limit))
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let exported = self.export(native_ref)?;
        let mut messages = Vec::new();
        let mut omitted_tool_count = 0;
        for message in exported.messages {
            let kind = match message.info.role.as_str() {
                "user" => ConversationEventKind::UserMessage,
                "assistant" => ConversationEventKind::AgentMessage,
                _ => continue,
            };
            let timestamp = message
                .info
                .time
                .as_ref()
                .and_then(|time| timestamp(time.created));
            let (content, tool_count, attachment_count) = summarize_parts(&message.parts);
            omitted_tool_count += tool_count;
            if !content.trim().is_empty() || attachment_count > 0 {
                messages.push(ConversationEvent {
                    id: message.info.id,
                    kind,
                    timestamp,
                    content: (!content.trim().is_empty()).then_some(content),
                    tool_name: None,
                    tool_status: None,
                    duration_ms: None,
                    attachment_count,
                    truncated: false,
                });
            }
        }
        Ok(HandoffContext {
            compact_summary: None,
            messages,
            omitted_tool_count,
            warnings: Vec::new(),
        })
    }

    fn read_session_document(
        &self,
        source: &crate::ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        let exported = self.export(native_ref)?;
        parse_exported_session(source, exported, home)
    }
}

impl OpenCodeProvider {
    fn export(&self, native_ref: &str) -> Result<ExportedSession> {
        let executable = command::resolve("opencode")
            .context("OpenCode CLI is not installed or is not available on PATH")?;
        let mut process = Command::new(executable);
        process.args(["export", native_ref]);
        if let Ok(workspace) = self.workspace.lock()
            && let Some(workspace) = workspace.as_deref()
        {
            process.current_dir(workspace);
        }
        let output = process
            .output()
            .context("Unable to export OpenCode session")?;
        if !output.status.success() {
            bail!("OpenCode session export failed: {}", stderr(&output.stderr));
        }
        if output.stdout.len() > MAX_EXPORT_BYTES {
            bail!("OpenCode session export exceeds the 256 MiB read limit");
        }
        serde_json::from_slice(&output.stdout)
            .context("OpenCode returned an invalid session export")
    }
}

fn parse_exported_session(
    source: &crate::ConversationSessionSummary,
    exported: ExportedSession,
    home: Option<&Path>,
) -> Result<SessionDocument> {
    let mut turns = Vec::new();
    let mut losses = BTreeMap::new();
    for (index, message) in exported.messages.into_iter().enumerate() {
        let role = match message.info.role.as_str() {
            "user" => SessionRole::User,
            "assistant" => SessionRole::Assistant,
            _ => continue,
        };
        let timestamp = message
            .info
            .time
            .as_ref()
            .and_then(|time| timestamp(time.created));
        let mut blocks = Vec::new();
        for part in message.parts {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        blocks.push(SessionBlock::Text { text: text.into() });
                    }
                }
                Some("reasoning") => {
                    *losses
                        .entry(SessionLossCode::ReasoningExcluded)
                        .or_insert(0) += 1;
                }
                Some("tool") => {
                    let call_id = part
                        .get("callID")
                        .and_then(Value::as_str)
                        .unwrap_or("missing-call-id")
                        .to_owned();
                    let name = part
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_owned();
                    let state = part.get("state");
                    let input = state
                        .and_then(|value| value.get("input"))
                        .map(json_text)
                        .unwrap_or_default();
                    blocks.push(SessionBlock::ToolCall {
                        call_id: call_id.clone(),
                        name,
                        input,
                    });
                    if let Some(state) = state
                        && state.get("status").and_then(Value::as_str) == Some("completed")
                    {
                        blocks.push(SessionBlock::ToolResult {
                            call_id,
                            output: state.get("output").map(json_text).unwrap_or_default(),
                            is_error: false,
                        });
                    }
                }
                Some("file") => {
                    let Some(url) = part.get("url").and_then(Value::as_str) else {
                        *losses
                            .entry(SessionLossCode::ExternalAttachment)
                            .or_insert(0) += 1;
                        continue;
                    };
                    if let Some((media_type, data)) = parse_data_url(url) {
                        blocks.push(SessionBlock::Attachment {
                            kind: if media_type.starts_with("image/") {
                                SessionAttachmentKind::Image
                            } else {
                                SessionAttachmentKind::Document
                            },
                            media_type,
                            filename: part
                                .get("filename")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            inline_base64: Some(data),
                        });
                    } else {
                        *losses
                            .entry(SessionLossCode::ExternalAttachment)
                            .or_insert(0) += 1;
                    }
                }
                Some(_) => {
                    *losses.entry(SessionLossCode::DamagedRecord).or_insert(0) += 1;
                }
                None => {
                    *losses.entry(SessionLossCode::DamagedRecord).or_insert(0) += 1;
                }
            }
        }
        if !blocks.is_empty() {
            turns.push(SessionTurn {
                id: format!("turn-{index}"),
                role,
                timestamp,
                blocks,
            });
        }
    }
    finish_document(source, turns, losses, home)
}

fn summarize_parts(parts: &[Value]) -> (String, usize, u64) {
    let mut text = Vec::new();
    let mut tool_count = 0;
    let mut attachment_count = 0;
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    text.push(value);
                }
            }
            Some("tool") => tool_count += 1,
            Some("file") => attachment_count += 1,
            _ => {}
        }
    }
    (text.join("\n"), tool_count, attachment_count)
}

fn page_events(
    events: Vec<ConversationEvent>,
    cursor: Option<&str>,
    limit: usize,
) -> ConversationEventPage {
    let end = cursor
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(events.len())
        .min(events.len());
    let start = end.saturating_sub(limit.clamp(1, 100));
    ConversationEventPage {
        events: events[start..end].to_vec(),
        next_cursor: (start > 0).then(|| start.to_string()),
        warnings: Vec::new(),
    }
}

fn timestamp(value: Option<i64>) -> Option<DateTime<Utc>> {
    value.and_then(|value| Utc.timestamp_millis_opt(value).single())
}

fn clean_title(value: Option<&str>) -> Option<String> {
    let value = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then(|| value.chars().take(200).collect())
}

fn stderr(value: &[u8]) -> String {
    String::from_utf8_lossy(value)
        .trim()
        .chars()
        .take(500)
        .collect()
}

fn json_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn parse_data_url(value: &str) -> Option<(String, String)> {
    let (header, data) = value.strip_prefix("data:")?.split_once(",")?;
    let media_type = header.split(';').next().filter(|value| !value.is_empty())?;
    let data = header
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
        .then(|| data.to_owned())?;
    Some((media_type.to_owned(), data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConversationSessionSummary, SessionAvailability};

    #[test]
    fn parses_sanitizable_opencode_export_into_neutral_document() {
        let source = ConversationSessionSummary {
            id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            agent: AgentKind::OpenCode,
            title: Some("Synthetic OpenCode session".into()),
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: None,
            archived: false,
            sidechain: false,
            availability: SessionAvailability::Readable,
        };
        let exported: ExportedSession = serde_json::from_value(serde_json::json!({
            "info": {"id": "ses_fixture", "title": "fixture"},
            "messages": [
                {
                    "info": {"id": "msg-user", "role": "user", "time": {"created": 1700000000000i64}},
                    "parts": [{"type": "text", "text": "Continue from this fixture."}]
                },
                {
                    "info": {"id": "msg-assistant", "role": "assistant", "time": {"created": 1700000001000i64}},
                    "parts": [
                        {"type": "reasoning", "text": "private reasoning"},
                        {"type": "tool", "callID": "call-1", "tool": "bash", "state": {"status": "completed", "input": {"command": "printf secret=token"}, "output": "secret=token"}},
                        {"type": "file", "url": "data:image/png;base64,ZmFrZQ==", "filename": "diagram.png"},
                        {"type": "snapshot", "snapshot": "opaque"}
                    ]
                }
            ]
        }))
        .unwrap();

        let document = parse_exported_session(&source, exported, None).unwrap();

        assert_eq!(document.turns.len(), 2);
        assert_eq!(document.turns[1].blocks.len(), 3);
        assert_eq!(
            document
                .losses
                .iter()
                .find(|loss| loss.code == SessionLossCode::ReasoningExcluded)
                .map(|loss| loss.count),
            Some(1)
        );
        assert_eq!(
            document
                .losses
                .iter()
                .find(|loss| loss.code == SessionLossCode::DamagedRecord)
                .map(|loss| loss.count),
            Some(1)
        );
    }
}
