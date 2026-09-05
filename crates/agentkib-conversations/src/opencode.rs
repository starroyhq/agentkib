use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use agentkib_core::AgentKind;
use agentkib_platform::command;
use agentkib_platform::process::{ProcessTree, configure_process_group};
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
const MAX_SESSION_LIST_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const OPENCODE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

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
        let output = run_opencode_command(
            &executable,
            &["session", "list", "--format", "json"],
            Some(workspace),
            MAX_SESSION_LIST_BYTES,
        )
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
        let workspace = self.workspace.lock().ok().and_then(|value| value.clone());
        let output = run_opencode_command(
            &executable,
            &["export", native_ref],
            workspace.as_deref(),
            MAX_EXPORT_BYTES,
        )
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

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

struct OutputMessage {
    stream: OutputStream,
    result: std::result::Result<Vec<u8>, String>,
}

struct OpenCodeOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_opencode_command(
    executable: &Path,
    args: &[&str],
    workspace: Option<&Path>,
    stdout_limit: usize,
) -> Result<OpenCodeOutput> {
    let mut process = Command::new(executable);
    process
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace) = workspace {
        process.current_dir(workspace);
    }
    configure_process_group(&mut process);
    let mut child = process
        .spawn()
        .with_context(|| format!("Could not run {}", executable.display()))?;
    let process_tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).context("Could not supervise OpenCode process tree");
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_process(&mut child, &process_tree);
            bail!("OpenCode stdout was unavailable");
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            stop_process(&mut child, &process_tree);
            bail!("OpenCode stderr was unavailable");
        }
    };

    let (sender, receiver) = mpsc::channel();
    let stdout_thread = spawn_output_reader(stdout, OutputStream::Stdout, stdout_limit, &sender);
    let stderr_thread =
        spawn_output_reader(stderr, OutputStream::Stderr, MAX_STDERR_BYTES, &sender);
    let mut stdout_result = None;
    let mut stderr_result = None;
    let started = Instant::now();
    let status = loop {
        drain_output_messages(&receiver, &mut stdout_result, &mut stderr_result);
        if let Some(error) = output_error(&stdout_result).or_else(|| output_error(&stderr_result)) {
            stop_process(&mut child, &process_tree);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            bail!("{error}");
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                stop_process(&mut child, &process_tree);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(error).context("Unable to wait for OpenCode process");
            }
        }
        if started.elapsed() >= OPENCODE_COMMAND_TIMEOUT {
            stop_process(&mut child, &process_tree);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            bail!("OpenCode command timed out after 30 seconds");
        }
        thread::sleep(Duration::from_millis(10));
    };

    // A wrapper can exit while a descendant still owns stdout or stderr. End the process tree
    // before waiting for the reader threads so a leaked descendant cannot block this call.
    let _ = process_tree.terminate();
    let _ = child.wait();
    receive_output_messages(&receiver, &mut stdout_result, &mut stderr_result);
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    receive_output_messages(&receiver, &mut stdout_result, &mut stderr_result);

    Ok(OpenCodeOutput {
        status,
        stdout: finish_output(stdout_result, "stdout")?,
        stderr: finish_output(stderr_result, "stderr")?,
    })
}

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    stream: OutputStream,
    limit: usize,
    sender: &mpsc::Sender<OutputMessage>,
) -> thread::JoinHandle<()> {
    let sender = sender.clone();
    thread::spawn(move || {
        let result = read_limited(reader, limit);
        let _ = sender.send(OutputMessage { stream, result });
    })
}

fn read_limited(reader: impl Read, limit: usize) -> std::result::Result<Vec<u8>, String> {
    let mut output = Vec::new();
    reader
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut output)
        .map_err(|error| format!("Unable to read OpenCode output: {error}"))?;
    if output.len() > limit {
        return Err(format!("OpenCode output exceeds the {limit}-byte limit"));
    }
    Ok(output)
}

fn drain_output_messages(
    receiver: &Receiver<OutputMessage>,
    stdout: &mut Option<std::result::Result<Vec<u8>, String>>,
    stderr: &mut Option<std::result::Result<Vec<u8>, String>>,
) {
    while let Ok(message) = receiver.try_recv() {
        match message.stream {
            OutputStream::Stdout => *stdout = Some(message.result),
            OutputStream::Stderr => *stderr = Some(message.result),
        }
    }
}

fn receive_output_messages(
    receiver: &Receiver<OutputMessage>,
    stdout: &mut Option<std::result::Result<Vec<u8>, String>>,
    stderr: &mut Option<std::result::Result<Vec<u8>, String>>,
) {
    while stdout.is_none() || stderr.is_none() {
        let Ok(message) = receiver.recv() else { break };
        match message.stream {
            OutputStream::Stdout => *stdout = Some(message.result),
            OutputStream::Stderr => *stderr = Some(message.result),
        }
    }
}

fn output_error(output: &Option<std::result::Result<Vec<u8>, String>>) -> Option<String> {
    output
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .cloned()
}

fn finish_output(
    output: Option<std::result::Result<Vec<u8>, String>>,
    stream: &str,
) -> Result<Vec<u8>> {
    match output {
        Some(Ok(output)) => Ok(output),
        Some(Err(error)) => bail!("OpenCode {stream} {error}"),
        None => bail!("OpenCode {stream} reader did not finish"),
    }
}

fn stop_process(child: &mut Child, process_tree: &ProcessTree) {
    let _ = process_tree.terminate();
    let _ = child.kill();
    let _ = child.wait();
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
                    if let Some(state) = state {
                        let Some(status) = state.get("status").and_then(Value::as_str) else {
                            continue;
                        };
                        let is_error = matches!(status, "error" | "failed");
                        if status == "completed" || is_error {
                            let output = state
                                .get("output")
                                .or_else(|| state.get("error"))
                                .or_else(|| state.get("message"))
                                .map(json_text)
                                .unwrap_or_else(|| {
                                    format!("OpenCode tool result status: {status}")
                                });
                            blocks.push(SessionBlock::ToolResult {
                                call_id,
                                output,
                                is_error,
                            });
                        }
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
