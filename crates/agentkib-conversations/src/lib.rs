use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::WalkDir;

mod archive;
mod continuation;
mod opencode;
pub use archive::*;
pub use continuation::*;
pub use opencode::OpenCodeProvider;

const MAX_TITLE_CHARS: usize = 200;
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CLAUDE_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CLAUDE_HEADER_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLAUDE_HEADER_LINES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionAvailability {
    Readable,
    MetadataOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionIndexFreshness {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationEventKind {
    UserMessage,
    AgentMessage,
    ToolSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSessionSummary {
    #[serde(skip)]
    pub native_ref: String,
    pub agent: AgentKind,
    pub title: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub message_count: Option<u64>,
    pub git_branch: Option<String>,
    pub archived: bool,
    pub sidechain: bool,
    pub availability: SessionAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub agent: AgentKind,
    pub title: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub message_count: Option<u64>,
    pub git_branch: Option<String>,
    pub archived: bool,
    pub sidechain: bool,
    pub availability: SessionAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationIndexStatus {
    pub workspace_id: String,
    pub agent: AgentKind,
    pub freshness: SessionIndexFreshness,
    pub session_count: u64,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub error_key: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationEvent {
    pub id: String,
    pub kind: ConversationEventKind,
    pub timestamp: Option<DateTime<Utc>>,
    pub content: Option<String>,
    pub tool_name: Option<String>,
    pub tool_status: Option<String>,
    pub duration_ms: Option<u64>,
    pub attachment_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationEventPage {
    pub events: Vec<ConversationEvent>,
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffFormat {
    Markdown,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHandoffRequest {
    pub session_id: String,
    pub target_agent: AgentKind,
    pub format: HandoffFormat,
    #[serde(default = "default_history_budget_tokens")]
    pub history_budget_tokens: usize,
}

fn default_history_budget_tokens() -> usize {
    DEFAULT_HISTORY_BUDGET_TOKENS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffContextSource {
    NativeCompaction,
    FullTranscript,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHandoffDraft {
    pub filename: String,
    pub format: HandoffFormat,
    pub content: String,
    pub redaction_count: usize,
    pub included_message_count: usize,
    pub omitted_tool_count: usize,
    pub context_source: HandoffContextSource,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SessionHandoffPreparation {
    Ready { draft: SessionHandoffDraft },
}

#[derive(Debug, Clone)]
pub struct HandoffContext {
    pub compact_summary: Option<String>,
    pub messages: Vec<ConversationEvent>,
    pub omitted_tool_count: usize,
    pub warnings: Vec<String>,
}

const MAX_HANDOFF_BYTES: usize = MAX_TRANSCRIPT_BYTES as usize;

pub fn prepare_handoff(
    source: &ConversationSessionSummary,
    request: &SessionHandoffRequest,
    context: &HandoffContext,
    home: Option<&Path>,
) -> Result<SessionHandoffPreparation> {
    if source.id != request.session_id {
        bail!("Conversation session does not match the handoff request");
    }
    if source.availability != SessionAvailability::Readable {
        bail!("Conversation transcript is not available");
    }
    let sanitized = sanitize_handoff_context(source, context, home);
    if sanitized.messages.is_empty() && sanitized.compact_summary.is_none() {
        bail!("Conversation does not contain readable messages");
    }
    anyhow::ensure!(
        estimate_direct_bytes(&sanitized) <= MAX_HANDOFF_BYTES,
        "Handoff content exceeds 256 MiB"
    );
    let generated_at = Utc::now();
    let context_source = if sanitized.compact_summary.is_some() {
        HandoffContextSource::NativeCompaction
    } else {
        HandoffContextSource::FullTranscript
    };
    let content = render_direct_handoff(
        &sanitized,
        request.target_agent,
        request.format,
        generated_at,
    )?;
    anyhow::ensure!(
        content.len() <= MAX_HANDOFF_BYTES,
        "Handoff content exceeds 256 MiB"
    );
    Ok(SessionHandoffPreparation::Ready {
        draft: SessionHandoffDraft {
            filename: handoff_filename(
                generated_at,
                source.agent,
                request.target_agent,
                request.format,
            ),
            format: request.format,
            content,
            redaction_count: sanitized.redaction_count,
            included_message_count: sanitized.messages.len(),
            omitted_tool_count: sanitized.omitted_tool_count,
            context_source,
            warnings: sanitized.warnings,
        },
    })
}

struct SanitizedHandoffContext {
    source: ConversationSessionSummary,
    compact_summary: Option<String>,
    messages: Vec<SanitizedMessage>,
    omitted_tool_count: usize,
    warnings: Vec<String>,
    redaction_count: usize,
}

#[derive(Serialize)]
struct SanitizedMessage {
    role: &'static str,
    timestamp: Option<DateTime<Utc>>,
    content: String,
    attachment_count: u64,
    truncated: bool,
}

fn sanitize_handoff_context(
    source: &ConversationSessionSummary,
    context: &HandoffContext,
    home: Option<&Path>,
) -> SanitizedHandoffContext {
    let mut redaction_count = 0;
    let mut sanitized_source = source.clone();
    sanitized_source.title = source
        .title
        .as_deref()
        .map(|value| sanitize_handoff_content(value, home, &mut redaction_count));
    sanitized_source.git_branch = source
        .git_branch
        .as_deref()
        .map(|value| sanitize_handoff_content(value, home, &mut redaction_count));
    let compact_summary = context
        .compact_summary
        .as_deref()
        .map(|value| sanitize_handoff_content(value, home, &mut redaction_count));
    let messages = context
        .messages
        .iter()
        .filter_map(|event| {
            let role = match event.kind {
                ConversationEventKind::UserMessage => "user",
                ConversationEventKind::AgentMessage => "agent",
                ConversationEventKind::ToolSummary => return None,
            };
            let content = sanitize_handoff_content(
                event.content.as_deref().unwrap_or_default(),
                home,
                &mut redaction_count,
            );
            (!content.trim().is_empty()).then_some(SanitizedMessage {
                role,
                timestamp: event.timestamp,
                content,
                attachment_count: event.attachment_count,
                truncated: event.truncated,
            })
        })
        .collect::<Vec<_>>();
    let mut warnings = context.warnings.clone();
    if messages.iter().any(|message| message.truncated) {
        warnings.push("source-content-truncated".into());
    }
    warnings.sort();
    warnings.dedup();
    SanitizedHandoffContext {
        source: sanitized_source,
        compact_summary,
        messages,
        omitted_tool_count: context.omitted_tool_count,
        warnings,
        redaction_count,
    }
}

fn estimate_direct_bytes(context: &SanitizedHandoffContext) -> usize {
    context.compact_summary.as_ref().map_or(0, String::len)
        + context
            .messages
            .iter()
            .map(|message| message.content.len().saturating_add(128))
            .sum::<usize>()
        + 2048
}

fn render_direct_handoff(
    context: &SanitizedHandoffContext,
    target_agent: AgentKind,
    format: HandoffFormat,
    generated_at: DateTime<Utc>,
) -> Result<String> {
    match format {
        HandoffFormat::Markdown => Ok(render_direct_markdown(context, target_agent, generated_at)),
        HandoffFormat::Json => render_direct_json(context, target_agent, generated_at),
    }
}

fn render_direct_markdown(
    context: &SanitizedHandoffContext,
    target_agent: AgentKind,
    generated_at: DateTime<Utc>,
) -> String {
    let mut output = markdown_header(&context.source, target_agent, generated_at);
    if let Some(summary) = &context.compact_summary {
        output.push_str("\n## Source Agent compact summary\n\n");
        output.push_str(summary.trim());
        output.push_str("\n\n## Conversation after compact\n");
    } else {
        output.push_str("\n## Conversation\n");
    }
    push_markdown_messages(&mut output, &context.messages);
    output
}

fn render_direct_json(
    context: &SanitizedHandoffContext,
    target_agent: AgentKind,
    generated_at: DateTime<Utc>,
) -> Result<String> {
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": 1,
            "instruction": handoff_instruction(),
            "generated_at": generated_at,
            "source": source_metadata(&context.source),
            "target_agent": target_agent,
            "context": {
                "mode": if context.compact_summary.is_some() { "native-compaction" } else { "full-transcript" },
                "compact_summary": context.compact_summary,
                "messages": context.messages,
            },
        }))?
    ))
}

fn markdown_header(
    source: &ConversationSessionSummary,
    target_agent: AgentKind,
    generated_at: DateTime<Utc>,
) -> String {
    let mut output = format!(
        "# Agent handoff\n\n> {}\n\n## Metadata\n\n- Source Agent: {}\n- Target Agent: {}\n- Session: {}\n- Generated: {}\n",
        handoff_instruction(),
        source.agent.as_str(),
        target_agent.as_str(),
        source.title.as_deref().unwrap_or("Untitled session"),
        generated_at.to_rfc3339(),
    );
    if let Some(branch) = &source.git_branch {
        output.push_str(&format!("- Git branch: {branch}\n"));
    }
    if let Some(updated_at) = source.updated_at.or(source.created_at) {
        output.push_str(&format!("- Session time: {}\n", updated_at.to_rfc3339()));
    }
    output
}

fn handoff_instruction() -> &'static str {
    import_notice()
}

fn source_metadata(source: &ConversationSessionSummary) -> serde_json::Value {
    serde_json::json!({
        "agent": source.agent,
        "title": source.title,
        "git_branch": source.git_branch,
        "updated_at": source.updated_at,
    })
}

fn push_markdown_messages(output: &mut String, messages: &[SanitizedMessage]) {
    for message in messages {
        let label = if message.role == "user" {
            "User"
        } else {
            "Agent"
        };
        output.push_str(&format!("\n### {label}"));
        if let Some(timestamp) = message.timestamp {
            output.push_str(&format!(" · {}", timestamp.to_rfc3339()));
        }
        output.push_str("\n\n");
        output.push_str(&message.content);
        output.push('\n');
        if message.attachment_count > 0 {
            output.push_str(&format!(
                "\n_Attachments omitted: {}_\n",
                message.attachment_count
            ));
        }
        if message.truncated {
            output.push_str("\n_Source content was truncated._\n");
        }
    }
}

fn handoff_filename(
    generated_at: DateTime<Utc>,
    source_agent: AgentKind,
    target_agent: AgentKind,
    format: HandoffFormat,
) -> String {
    let extension = match format {
        HandoffFormat::Markdown => "md",
        HandoffFormat::Json => "json",
    };
    format!(
        "{}-{}-to-{}.{}",
        generated_at.format("%Y%m%d-%H%M%S%3f"),
        source_agent.as_str(),
        target_agent.as_str(),
        extension
    )
}

pub fn sanitize_handoff_content(
    value: &str,
    home: Option<&Path>,
    redaction_count: &mut usize,
) -> String {
    let mut output = value.to_string();
    if let Some(home) = home.and_then(Path::to_str) {
        let count = output.matches(home).count();
        if count > 0 {
            output = output.replace(home, "$HOME");
            *redaction_count += count;
        }
    }
    let mut lines = Vec::new();
    let mut private_key_end: Option<String> = None;
    for line in output.lines() {
        if let Some(end_marker) = private_key_end.as_ref() {
            if line.trim().eq_ignore_ascii_case(end_marker) {
                private_key_end = None;
            }
            continue;
        }
        if let Some(end_marker) = pem_private_key_end_marker(line) {
            lines.push("[REDACTED PRIVATE KEY]".into());
            *redaction_count += 1;
            private_key_end = Some(end_marker);
            continue;
        }
        lines.push(redact_sensitive_line(line, redaction_count));
    }
    lines.join("\n")
}

fn pem_private_key_end_marker(line: &str) -> Option<String> {
    let marker = line.trim().to_ascii_uppercase();
    let label = marker.strip_prefix("-----BEGIN ")?.strip_suffix("-----")?;
    label
        .contains("PRIVATE KEY")
        .then(|| format!("-----END {label}-----"))
}

pub fn sanitize_handoff_export(
    content: &str,
    format: HandoffFormat,
    home: Option<&Path>,
) -> Result<(String, usize)> {
    if content.len() > MAX_HANDOFF_BYTES {
        bail!("Handoff content exceeds 256 MiB");
    }
    let mut redaction_count = 0;
    let sanitized = match format {
        HandoffFormat::Markdown => sanitize_handoff_content(content, home, &mut redaction_count),
        HandoffFormat::Json => {
            let mut value: serde_json::Value = serde_json::from_str(content)?;
            sanitize_json_value(&mut value, None, home, &mut redaction_count);
            format!("{}\n", serde_json::to_string_pretty(&value)?)
        }
    };
    if sanitized.len() > MAX_HANDOFF_BYTES {
        bail!("Handoff content exceeds 256 MiB");
    }
    Ok((sanitized, redaction_count))
}

fn redact_sensitive_line(line: &str, redaction_count: &mut usize) -> String {
    let mut output = redact_cli_credentials(line, redaction_count);
    if let Some(end) = output
        .char_indices()
        .filter(|(_, character)| matches!(character, '=' | ':'))
        .find_map(|(position, character)| {
            let end = position + character.len_utf8();
            let candidate = assignment_key_before(&output, position);
            let already_redacted = output[end..]
                .trim_start()
                .trim_start_matches(['\'', '"'])
                .starts_with("[REDACTED]");
            (is_sensitive_key(candidate) && !already_redacted).then_some(end)
        })
    {
        *redaction_count += 1;
        return format!("{} [REDACTED]", output[..end].trim_end());
    }
    for prefix in ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-"] {
        redact_prefixed_credentials(&mut output, prefix, redaction_count);
    }
    output
}

fn redact_cli_credentials(line: &str, redaction_count: &mut usize) -> String {
    let tokens = cli_tokens(line);
    let curl_command = tokens.iter().any(|(_, _, value)| {
        value.rsplit(['/', '\\']).next().is_some_and(|name| {
            name.eq_ignore_ascii_case("curl") || name.eq_ignore_ascii_case("curl.exe")
        })
    });
    let mut ranges = Vec::new();

    for (index, (start, end, token)) in tokens.iter().enumerate() {
        let Some(option) = token.strip_prefix("--") else {
            if curl_command {
                if token == "-u" {
                    if let Some((value_start, value_end, value)) = tokens.get(index + 1)
                        && !value.starts_with('-')
                    {
                        ranges.push((*value_start, *value_end));
                    }
                } else if let Some(value) = token.strip_prefix("-u=") {
                    if !value.is_empty() {
                        let raw = &line[*start..*end];
                        if let Some(delimiter) = raw.find('=') {
                            ranges.push(cli_inline_value_range(line, *start, *end, delimiter + 1));
                        }
                    }
                } else if token.starts_with("-u") && token.len() > 2 {
                    let raw = &line[*start..*end];
                    if let Some(option_start) = raw.find("-u") {
                        ranges.push(cli_inline_value_range(line, *start, *end, option_start + 2));
                    }
                }
            }
            continue;
        };
        let (name, inline_value) = option
            .split_once('=')
            .map_or((option, None), |(name, value)| (name, Some(value)));
        if !(is_sensitive_key(name) || curl_command && name.eq_ignore_ascii_case("user")) {
            continue;
        }
        if inline_value.is_some_and(|value| !value.is_empty()) {
            let raw = &line[*start..*end];
            if let Some(delimiter) = raw.find('=') {
                let (value_start, value_end) =
                    cli_inline_value_range(line, *start, *end, delimiter + 1);
                if value_start < value_end {
                    ranges.push((value_start, value_end));
                }
            }
        } else if inline_value.is_none()
            && let Some((value_start, value_end, value)) = tokens.get(index + 1)
            && !value.starts_with('-')
        {
            ranges.push((*value_start, *value_end));
        }
    }

    ranges.sort_unstable();
    ranges.dedup();
    let mut output = line.to_string();
    for (start, end) in ranges.iter().rev() {
        output.replace_range(*start..*end, "[REDACTED]");
    }
    *redaction_count += ranges.len();
    output
}

fn cli_tokens(line: &str) -> Vec<(usize, usize, String)> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut value = String::new();
    let mut quote = None;
    let mut escaped = false;

    for (index, character) in line.char_indices() {
        if escaped {
            value.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            start.get_or_insert(index);
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
                continue;
            }
            if quote.is_none() {
                start.get_or_insert(index);
                quote = Some(character);
                continue;
            }
        }
        if character.is_whitespace() && quote.is_none() {
            if let Some(token_start) = start.take() {
                tokens.push((token_start, index, std::mem::take(&mut value)));
            }
            continue;
        }
        start.get_or_insert(index);
        value.push(character);
    }
    if escaped {
        value.push('\\');
    }
    if let Some(token_start) = start {
        tokens.push((token_start, line.len(), value));
    }
    tokens
}

fn cli_inline_value_range(
    line: &str,
    token_start: usize,
    token_end: usize,
    value_offset: usize,
) -> (usize, usize) {
    let raw = &line[token_start..token_end];
    let mut value_start = token_start + value_offset;
    let mut value_end = token_end;
    let closing_quote = raw
        .chars()
        .next_back()
        .filter(|value| matches!(value, '\'' | '"'));
    if let Some(quote) = closing_quote {
        if line[value_start..value_end].starts_with(quote) {
            value_start += quote.len_utf8();
            value_end -= quote.len_utf8();
        } else if raw.starts_with(quote) {
            value_end -= quote.len_utf8();
        }
    }
    (value_start, value_end)
}

fn assignment_key_before(line: &str, delimiter: usize) -> &str {
    line[..delimiter]
        .rsplit(|character: char| {
            matches!(
                character,
                '=' | ':' | '?' | '&' | '/' | '\\' | ',' | ';' | '(' | '[' | '{' | '"' | '\''
            )
        })
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-' | ' ' | '\t')
        })
}

fn redact_prefixed_credentials(output: &mut String, prefix: &str, redaction_count: &mut usize) {
    const MIN_CREDENTIAL_CHARS: usize = 12;

    let mut search_from = 0;
    while search_from < output.len() {
        let lower = output[search_from..].to_ascii_lowercase();
        let Some(relative_start) = lower.find(prefix) else {
            break;
        };
        let start = search_from + relative_start;
        let has_token_boundary = output[..start]
            .chars()
            .next_back()
            .is_none_or(|character| !is_credential_character(character));
        let value_start = start + prefix.len();
        let credential_length = output[value_start..]
            .chars()
            .take_while(|character| is_credential_character(*character))
            .count();
        if !has_token_boundary || credential_length < MIN_CREDENTIAL_CHARS {
            search_from = value_start;
            continue;
        }
        let value_bytes = output[value_start..]
            .char_indices()
            .take(credential_length)
            .map(|(index, character)| index + character.len_utf8())
            .last()
            .unwrap_or(0);
        output.replace_range(start..value_start + value_bytes, "[REDACTED]");
        *redaction_count += 1;
        search_from = start + "[REDACTED]".len();
    }
}

fn is_credential_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn sanitize_json_value(
    value: &mut serde_json::Value,
    key: Option<&str>,
    home: Option<&Path>,
    redaction_count: &mut usize,
) {
    if key.is_some_and(is_sensitive_key) {
        *value = serde_json::Value::String("[REDACTED]".into());
        *redaction_count += 1;
        return;
    }
    match value {
        serde_json::Value::String(content) => {
            *content = sanitize_handoff_content(content, home, redaction_count);
        }
        serde_json::Value::Array(values) => {
            for value in values {
                sanitize_json_value(value, None, home, redaction_count);
            }
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                sanitize_json_value(value, Some(key), home, redaction_count);
            }
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    if [
        "authorization",
        "proxyauthorization",
        "cookie",
        "cookies",
        "setcookie",
        "apikey",
        "apikeys",
        "accesskey",
        "accesskeys",
        "accesskeyid",
        "privatekey",
        "privatekeys",
        "token",
        "tokens",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "authtoken",
        "bearertoken",
        "sessiontoken",
        "tokenvalue",
        "secret",
        "secrets",
        "clientsecret",
        "apisecret",
        "webhooksecret",
        "password",
        "passwords",
        "passwordhash",
        "passwd",
        "credential",
        "credentials",
        "databaseurl",
        "dsn",
    ]
    .contains(&normalized.as_str())
    {
        return true;
    }

    let words = key_words(key);
    matches!(
        words.last().map(String::as_str),
        Some(
            "authorization"
                | "cookie"
                | "cookies"
                | "token"
                | "tokens"
                | "secret"
                | "secrets"
                | "password"
                | "passwords"
                | "passwd"
                | "credential"
                | "credentials"
        )
    ) || [
        &["api", "key"][..],
        &["access", "key"],
        &["access", "key", "id"],
        &["private", "key"],
        &["database", "url"],
        &["set", "cookie"],
    ]
    .iter()
    .any(|suffix| key_words_end_with(&words, suffix))
}

fn key_words_end_with(words: &[String], suffix: &[&str]) -> bool {
    words.len() >= suffix.len()
        && words[words.len() - suffix.len()..]
            .iter()
            .map(String::as_str)
            .eq(suffix.iter().copied())
}

fn key_words(key: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_was_lowercase_or_digit = false;
    for character in key.chars() {
        if !character.is_ascii_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_was_lowercase_or_digit = false;
            continue;
        }
        if character.is_ascii_uppercase() && previous_was_lowercase_or_digit && !current.is_empty()
        {
            words.push(std::mem::take(&mut current));
        }
        current.push(character.to_ascii_lowercase());
        previous_was_lowercase_or_digit =
            character.is_ascii_lowercase() || character.is_ascii_digit();
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

pub trait ConversationProvider {
    fn agent(&self) -> AgentKind;
    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>>;
    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage>;
    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext>;
    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument>;
}

pub fn providers() -> Vec<Box<dyn ConversationProvider + Send + Sync>> {
    vec![
        Box::new(CodexProvider::default()),
        Box::new(ClaudeProvider::default()),
        Box::new(OpenCodeProvider::default()),
    ]
}

pub fn provider(agent: AgentKind) -> Option<Box<dyn ConversationProvider + Send + Sync>> {
    match agent {
        AgentKind::Codex => Some(Box::new(CodexProvider::default())),
        AgentKind::ClaudeCode => Some(Box::new(ClaudeProvider::default())),
        AgentKind::OpenCode => Some(Box::new(OpenCodeProvider::default())),
        _ => None,
    }
}

#[derive(Default)]
pub struct CodexProvider {
    home: Option<PathBuf>,
}

impl CodexProvider {
    #[cfg(test)]
    fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        })
    }

    fn databases(&self) -> Vec<PathBuf> {
        let Some(home) = self.home() else {
            return Vec::new();
        };
        let current = codex_databases_in(&home);
        if !current.is_empty() {
            return current;
        }
        codex_databases_in(&home.join("sqlite"))
    }

    fn native_sessions(&self, workspace: Option<&Path>) -> Result<Vec<CodexNativeSession>> {
        let mut output = BTreeMap::new();
        for database in self.databases() {
            let connection = open_read_only(&database)?;
            let columns = table_columns(&connection, "threads")?;
            if !columns.contains("id")
                || !columns.contains("cwd")
                || !columns.contains("rollout_path")
            {
                continue;
            }
            let title = first_column_expression(&columns, &["name", "title", "preview"], "''");
            let created =
                first_column_expression(&columns, &["created_at_ms", "created_at"], "NULL");
            let updated = first_column_expression(
                &columns,
                &["recency_at_ms", "updated_at_ms", "recency_at", "updated_at"],
                "NULL",
            );
            let branch = if columns.contains("git_branch") {
                "git_branch"
            } else {
                "NULL"
            };
            let archived = if columns.contains("archived") {
                "archived"
            } else {
                "0"
            };
            let sql = format!(
                "SELECT id, rollout_path, cwd, {title}, {created}, {updated}, {branch}, {archived} FROM threads"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map([], |row| {
                Ok(CodexNativeSession {
                    native_ref: row.get(0)?,
                    transcript: PathBuf::from(row.get::<_, String>(1)?),
                    cwd: PathBuf::from(row.get::<_, String>(2)?),
                    title: row.get::<_, Option<String>>(3)?,
                    created_at: row
                        .get::<_, Option<i64>>(4)?
                        .and_then(timestamp_from_integer),
                    updated_at: row
                        .get::<_, Option<i64>>(5)?
                        .and_then(timestamp_from_integer),
                    git_branch: row.get(6)?,
                    archived: row.get::<_, i64>(7).unwrap_or(0) != 0,
                })
            })?;
            for row in rows {
                let mut value = row?;
                if let Some(workspace) = workspace
                    && !workspace_matches(&value.cwd, workspace)
                {
                    continue;
                }
                if value.transcript.is_relative()
                    && let Some(home) = self.home()
                {
                    value.transcript = home.join(&value.transcript);
                }
                output.insert(value.native_ref.clone(), value);
            }
        }
        Ok(output.into_values().collect())
    }
}

fn codex_databases_in(directory: &Path) -> Vec<PathBuf> {
    let mut output = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return output;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))
        {
            output.push(path);
        }
    }
    output.sort();
    output.dedup();
    output
}

impl ConversationProvider for CodexProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .native_sessions(Some(workspace))?
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.native_ref,
                agent: AgentKind::Codex,
                title: sanitize_title(session.title.as_deref()),
                created_at: session.created_at,
                updated_at: session.updated_at,
                message_count: None,
                git_branch: sanitize_metadata(session.git_branch),
                archived: session.archived,
                sidechain: false,
                availability: if session.transcript.is_file() {
                    SessionAvailability::Readable
                } else {
                    SessionAvailability::MetadataOnly
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
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Codex session is no longer available")?;
        read_codex_events(&session.transcript, cursor, limit)
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Codex session is no longer available")?;
        read_codex_handoff_context(&session.transcript)
    }

    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Codex session is no longer available")?;
        read_codex_document(source, &session.transcript, home)
    }
}

struct CodexNativeSession {
    native_ref: String,
    transcript: PathBuf,
    cwd: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    git_branch: Option<String>,
    archived: bool,
}

#[derive(Default)]
pub struct ClaudeProvider {
    home: Option<PathBuf>,
}

impl ClaudeProvider {
    #[cfg(test)]
    fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".claude")))
        })
    }

    fn native_sessions(&self, workspace: Option<&Path>) -> Result<Vec<ClaudeNativeSession>> {
        let Some(home) = self.home() else {
            return Ok(Vec::new());
        };
        let projects = home.join("projects");
        let mut output = BTreeMap::new();
        let mut relevant_errors = Vec::new();
        let mut index_paths = Vec::new();
        let mut transcript_paths = Vec::new();
        if projects.is_dir() {
            for entry in WalkDir::new(&projects)
                .max_depth(3)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
            {
                let entry = match entry {
                    Ok(value) => value,
                    Err(error) => {
                        relevant_errors.push(error.to_string());
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                if entry.file_name() == "sessions-index.json" {
                    index_paths.push(entry.into_path());
                } else if entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
                {
                    transcript_paths.push(entry.into_path());
                }
            }
        }

        // sessions-index.json is a useful Claude cache, but transcript files are the
        // durable source documented by Claude Code. Parse the cache first only so
        // transcript discovery can enrich it without reading message bodies.
        for index_path in index_paths {
            let value = match read_claude_session_index(&index_path) {
                Ok(value) => value,
                Err(error) => {
                    relevant_errors.push(error.to_string());
                    continue;
                }
            };
            if value.get("version").and_then(Value::as_u64) != Some(1) {
                relevant_errors.push(format!(
                    "Unsupported Claude session index version in {}",
                    index_path.display()
                ));
                continue;
            }
            for item in value
                .get("entries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(project_path) = item
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                else {
                    continue;
                };
                if platform_path::is_known_agent_probe_workspace(&project_path) {
                    continue;
                }
                let Some(native_ref) = item.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                let transcript = item
                    .get("fullPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        index_path
                            .parent()
                            .unwrap_or_else(|| Path::new(""))
                            .join(format!("{native_ref}.jsonl"))
                    });
                let summary = item
                    .get("summary")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                let first_prompt = item.get("firstPrompt").and_then(Value::as_str);
                let session = ClaudeNativeSession {
                    native_ref: native_ref.to_owned(),
                    transcript,
                    project_path,
                    title: sanitize_title(summary.or(first_prompt)),
                    created_at: item.get("created").and_then(parse_json_timestamp),
                    updated_at: item
                        .get("modified")
                        .or_else(|| item.get("fileMtime"))
                        .and_then(parse_json_timestamp),
                    message_count: item.get("messageCount").and_then(Value::as_u64),
                    git_branch: item
                        .get("gitBranch")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    sidechain: item
                        .get("isSidechain")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                };
                output.insert(session.native_ref.clone(), session);
            }
        }

        for transcript_path in transcript_paths {
            let file_ref = transcript_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned);
            if let Some(session) = file_ref.as_ref().and_then(|value| output.get_mut(value)) {
                session.transcript = transcript_path;
                continue;
            }
            match claude_session_from_transcript(&transcript_path) {
                Ok(Some(session)) => {
                    if let Some(indexed) = output.get_mut(&session.native_ref) {
                        indexed.transcript = transcript_path;
                    } else {
                        output.insert(session.native_ref.clone(), session);
                    }
                }
                Ok(None) => {}
                Err(error) => relevant_errors.push(error.to_string()),
            }
        }

        let history_path = home.join("history.jsonl");
        if history_path.is_file() {
            match read_jsonl_snapshot(&history_path) {
                Ok(snapshot) => {
                    for (_, item) in snapshot.records {
                        let Some(native_ref) = item.get("sessionId").and_then(Value::as_str) else {
                            continue;
                        };
                        let timestamp = item.get("timestamp").and_then(parse_json_timestamp);
                        if let Some(session) = output.get_mut(native_ref) {
                            session.created_at = earliest_time(session.created_at, timestamp);
                            session.updated_at = latest_time(session.updated_at, timestamp);
                        }
                    }
                }
                Err(error) => relevant_errors.push(error.to_string()),
            }
        }
        if output.is_empty() && !relevant_errors.is_empty() {
            bail!(relevant_errors.join("; "));
        }
        Ok(output
            .into_values()
            .filter(|session| {
                session.transcript.is_file()
                    && !platform_path::is_known_agent_probe_workspace(&session.project_path)
                    && workspace
                        .is_none_or(|workspace| workspace_matches(&session.project_path, workspace))
            })
            .collect())
    }
}

fn read_claude_session_index(path: &Path) -> Result<Value> {
    let file = File::open(path)
        .with_context(|| format!("Cannot open Claude session index {}", path.display()))?;
    let length = file.metadata()?.len();
    if length > MAX_CLAUDE_INDEX_BYTES {
        bail!("Claude session index exceeds the 16 MiB read limit");
    }
    serde_json::from_reader(BufReader::new(file.take(length)))
        .with_context(|| format!("Cannot parse Claude session index {}", path.display()))
}

impl ConversationProvider for ClaudeProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .native_sessions(Some(workspace))?
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.native_ref,
                agent: AgentKind::ClaudeCode,
                title: session.title,
                created_at: session.created_at,
                updated_at: session.updated_at,
                message_count: session.message_count,
                git_branch: sanitize_metadata(session.git_branch),
                archived: false,
                sidechain: session.sidechain,
                availability: if session.transcript.is_file() {
                    SessionAvailability::Readable
                } else {
                    SessionAvailability::MetadataOnly
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
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Claude session is no longer available")?;
        read_claude_events(&session.transcript, cursor, limit)
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Claude session is no longer available")?;
        read_claude_handoff_context(&session.transcript, session.sidechain)
    }

    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Claude session is no longer available")?;
        read_claude_document(source, &session.transcript, session.sidechain, home)
    }
}

struct ClaudeNativeSession {
    native_ref: String,
    transcript: PathBuf,
    #[allow(dead_code)]
    project_path: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    message_count: Option<u64>,
    git_branch: Option<String>,
    sidechain: bool,
}

fn claude_session_from_transcript(path: &Path) -> Result<Option<ClaudeNativeSession>> {
    let file = File::open(path)
        .with_context(|| format!("Cannot open Claude transcript {}", path.display()))?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_TRANSCRIPT_BYTES {
        bail!("Claude transcript exceeds the 256 MiB read limit");
    }
    let mut reader = BufReader::new(file.take(metadata.len().min(MAX_CLAUDE_HEADER_BYTES)));
    let mut native_ref = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_owned);
    let mut project_path = None;
    let mut created_at = None;
    let mut updated_at = metadata.modified().ok().map(DateTime::<Utc>::from);
    let mut git_branch = None;
    let mut sidechain_session = None;
    let mut buffer = Vec::new();

    for _ in 0..MAX_CLAUDE_HEADER_LINES {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        if !buffer.ends_with(b"\n") || buffer.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if let Some(value) = value.get("sessionId").and_then(Value::as_str) {
            native_ref = Some(value.to_owned());
        }
        if project_path.is_none() {
            project_path = value
                .get("cwd")
                .or_else(|| value.get("projectPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from);
        }
        if git_branch.is_none() {
            git_branch = value
                .get("gitBranch")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if sidechain_session.is_none()
            && matches!(
                value.get("type").and_then(Value::as_str),
                Some("user" | "assistant")
            )
        {
            // Main transcripts can contain sidechain records. The first conversation record
            // identifies the transcript itself; later record flags must not promote the whole
            // main session to a sidechain and disable handoff filtering.
            sidechain_session = Some(
                value
                    .get("isSidechain")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
        }
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        created_at = earliest_time(created_at, timestamp);
        updated_at = latest_time(updated_at, timestamp);
    }

    let (Some(native_ref), Some(project_path)) = (native_ref, project_path) else {
        return Ok(None);
    };
    if platform_path::is_known_agent_probe_workspace(&project_path) {
        return Ok(None);
    }
    Ok(Some(ClaudeNativeSession {
        native_ref,
        transcript: path.to_path_buf(),
        project_path,
        title: None,
        created_at,
        updated_at,
        message_count: None,
        git_branch,
        sidechain: sidechain_session.unwrap_or(false),
    }))
}

fn earliest_time(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.min(candidate)),
        (current, candidate) => current.or(candidate),
    }
}

fn latest_time(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.max(candidate)),
        (current, candidate) => current.or(candidate),
    }
}

#[derive(Clone)]
struct IndexedEvent {
    line: usize,
    event: ConversationEvent,
}

fn read_codex_events(
    path: &Path,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let parsed = parse_codex_transcript(path)?;
    Ok(page_events(parsed.events, cursor, limit, parsed.warnings))
}

fn read_codex_handoff_context(path: &Path) -> Result<HandoffContext> {
    let parsed = parse_codex_transcript(path)?;
    let boundary = parsed.compact_summary.as_ref().map(|(line, _)| *line);
    let mut omitted_tool_count = 0;
    let messages = parsed
        .events
        .into_iter()
        .filter(|value| boundary.is_none_or(|line| value.line > line))
        .filter_map(|value| {
            if value.event.kind == ConversationEventKind::ToolSummary {
                omitted_tool_count += 1;
                None
            } else {
                Some(value.event)
            }
        })
        .collect();
    Ok(HandoffContext {
        compact_summary: parsed.compact_summary.map(|(_, summary)| summary),
        messages,
        omitted_tool_count,
        warnings: handoff_parse_warnings(&parsed.warnings),
    })
}

struct ParsedTranscript {
    events: Vec<IndexedEvent>,
    compact_summary: Option<(usize, String)>,
    warnings: Vec<String>,
}

fn parse_codex_transcript(path: &Path) -> Result<ParsedTranscript> {
    let snapshot = read_jsonl_snapshot(path)?;
    let injected_context_lines = injected_codex_user_context_lines(&snapshot.records);
    let mut primary = Vec::new();
    let mut fallback = Vec::new();
    let mut primary_messages = BTreeSet::new();
    let mut tools: BTreeMap<String, IndexedEvent> = BTreeMap::new();
    let mut warnings = snapshot.warnings;
    let mut compact_summary = None;
    let mut malformed_compact = false;
    for (line, value) in snapshot.records {
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        if value.get("type").and_then(Value::as_str) == Some("compacted") {
            if let Some(message) = value
                .pointer("/payload/message")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
            {
                compact_summary = Some((line, message.to_owned()));
                malformed_compact = false;
            } else {
                compact_summary = None;
                malformed_compact = true;
            }
            continue;
        }
        match (
            value.get("type").and_then(Value::as_str),
            value.pointer("/payload/type").and_then(Value::as_str),
        ) {
            (Some("event_msg"), Some("user_message")) => {
                if let Some(content) = value.pointer("/payload/message").and_then(Value::as_str) {
                    primary_messages
                        .insert(message_key(ConversationEventKind::UserMessage, content));
                    primary.push(message_event(
                        line,
                        ConversationEventKind::UserMessage,
                        timestamp,
                        content,
                        attachment_count(&value),
                    ));
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                if let Some(content) = value.pointer("/payload/message").and_then(Value::as_str) {
                    primary_messages
                        .insert(message_key(ConversationEventKind::AgentMessage, content));
                    primary.push(message_event(
                        line,
                        ConversationEventKind::AgentMessage,
                        timestamp,
                        content,
                        0,
                    ));
                }
            }
            (Some("response_item"), Some("message")) => {
                let role = value.pointer("/payload/role").and_then(Value::as_str);
                if matches!(role, Some("user" | "assistant"))
                    && !(role == Some("user") && injected_context_lines.contains(&line))
                    && let Some(content) = response_message_text(value.pointer("/payload/content"))
                {
                    fallback.push(message_event(
                        line,
                        if role == Some("user") {
                            ConversationEventKind::UserMessage
                        } else {
                            ConversationEventKind::AgentMessage
                        },
                        timestamp,
                        &content,
                        0,
                    ));
                }
            }
            (Some("event_msg"), Some("exec_command_end")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    "shell",
                    value.pointer("/payload/status").and_then(Value::as_str),
                    value
                        .pointer("/payload/duration")
                        .and_then(Value::as_f64)
                        .map(|value| (value * 1000.0).max(0.0) as u64),
                    timestamp,
                );
            }
            (Some("event_msg"), Some("patch_apply_end")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    "apply_patch",
                    value
                        .pointer("/payload/status")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            value
                                .pointer("/payload/success")
                                .and_then(Value::as_bool)
                                .map(|success| if success { "completed" } else { "failed" })
                        }),
                    None,
                    timestamp,
                );
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = value
                    .pointer("/payload/name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    name,
                    value.pointer("/payload/status").and_then(Value::as_str),
                    None,
                    timestamp,
                );
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(tool) = tools.get_mut(call_id) {
                    tool.event.tool_status = Some("completed".into());
                }
            }
            (Some("response_item"), Some("web_search_call")) => {
                upsert_tool(
                    &mut tools,
                    line,
                    &format!("web-{line}"),
                    "web_search",
                    value.pointer("/payload/status").and_then(Value::as_str),
                    None,
                    timestamp,
                );
            }
            _ => {}
        }
    }
    for value in fallback {
        let content = value.event.content.as_deref().unwrap_or_default();
        if !primary_messages.contains(&message_key(value.event.kind, content)) {
            primary.push(value);
        }
    }
    primary.extend(tools.into_values());
    primary.sort_by_key(|value| value.line);
    if primary.is_empty() && !path.is_file() {
        warnings.push("Transcript is no longer available".into());
    }
    if malformed_compact {
        warnings.push("Native compact summary could not be parsed".into());
    }
    Ok(ParsedTranscript {
        events: primary,
        compact_summary,
        warnings,
    })
}

fn message_key(kind: ConversationEventKind, content: &str) -> String {
    format!("{kind:?}:{}", content.trim())
}

fn read_claude_events(
    path: &Path,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let parsed = parse_claude_transcript(path, true)?;
    Ok(page_events(parsed.events, cursor, limit, parsed.warnings))
}

fn read_claude_handoff_context(path: &Path, sidechain_session: bool) -> Result<HandoffContext> {
    let parsed = parse_claude_transcript(path, sidechain_session)?;
    let boundary = parsed.compact_summary.as_ref().map(|(line, _)| *line);
    let mut omitted_tool_count = 0;
    let messages = parsed
        .events
        .into_iter()
        .filter(|value| boundary.is_none_or(|line| value.line > line))
        .filter_map(|value| {
            if value.event.kind == ConversationEventKind::ToolSummary {
                omitted_tool_count += 1;
                None
            } else {
                Some(value.event)
            }
        })
        .collect();
    Ok(HandoffContext {
        compact_summary: parsed.compact_summary.map(|(_, summary)| summary),
        messages,
        omitted_tool_count,
        warnings: handoff_parse_warnings(&parsed.warnings),
    })
}

fn parse_claude_transcript(path: &Path, include_sidechain: bool) -> Result<ParsedTranscript> {
    let snapshot = read_jsonl_snapshot(path)?;
    let mut events = Vec::new();
    let mut tools: BTreeMap<String, IndexedEvent> = BTreeMap::new();
    let mut compact_summary = None;
    let mut malformed_compact = false;
    for (line, value) in snapshot.records {
        if !include_sidechain
            && value
                .get("isSidechain")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            continue;
        }
        let record_type = value.get("type").and_then(Value::as_str);
        if !matches!(record_type, Some("user" | "assistant")) {
            continue;
        }
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        let role = value
            .pointer("/message/role")
            .and_then(Value::as_str)
            .unwrap_or_else(|| record_type.unwrap_or(""));
        let Some(content) = value.pointer("/message/content") else {
            continue;
        };
        if value
            .get("isCompactSummary")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(text) =
                response_message_text(Some(content)).filter(|text| !text.trim().is_empty())
            {
                compact_summary = Some((line, text));
                malformed_compact = false;
            } else {
                compact_summary = None;
                malformed_compact = true;
            }
            continue;
        }
        if let Some(text) = response_message_text(Some(content))
            && !text.trim().is_empty()
            && !is_claude_command_echo(&text)
        {
            events.push(message_event(
                line,
                if role == "assistant" {
                    ConversationEventKind::AgentMessage
                } else {
                    ConversationEventKind::UserMessage
                },
                timestamp,
                &text,
                claude_attachment_count(content),
            ));
        }
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let call_id = block.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        upsert_tool(
                            &mut tools,
                            line,
                            call_id,
                            name,
                            Some("started"),
                            None,
                            timestamp,
                        );
                    }
                    Some("tool_result") => {
                        let call_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if let Some(tool) = tools.get_mut(call_id) {
                            tool.event.tool_status = Some(
                                if block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                                {
                                    "failed"
                                } else {
                                    "completed"
                                }
                                .into(),
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    events.extend(tools.into_values());
    events.sort_by_key(|value| value.line);
    let mut warnings = snapshot.warnings;
    if malformed_compact {
        warnings.push("Native compact summary could not be parsed".into());
    }
    Ok(ParsedTranscript {
        events,
        compact_summary,
        warnings,
    })
}

fn is_claude_command_echo(content: &str) -> bool {
    let content = content.trim_start();
    content.starts_with("<local-command-")
        || content.starts_with("<command-name>")
        || content.starts_with("<command-message>")
}

fn handoff_parse_warnings(warnings: &[String]) -> Vec<String> {
    let mut output = Vec::new();
    if warnings
        .iter()
        .any(|warning| warning.contains("compact summary"))
    {
        output.push("compact-fallback".into());
    }
    if warnings
        .iter()
        .any(|warning| warning.contains("damaged transcript"))
    {
        output.push("damaged-transcript".into());
    }
    output
}

struct JsonlSnapshot {
    records: Vec<(usize, Value)>,
    warnings: Vec<String>,
}

fn read_jsonl_snapshot(path: &Path) -> Result<JsonlSnapshot> {
    let file =
        File::open(path).with_context(|| format!("Cannot open transcript {}", path.display()))?;
    let length = file.metadata()?.len();
    if length > MAX_TRANSCRIPT_BYTES {
        bail!("Transcript exceeds the 256 MiB read limit");
    }
    let mut reader = BufReader::new(file.take(length));
    let mut output = Vec::new();
    let mut damaged_lines = 0_u64;
    let mut buffer = Vec::new();
    let mut line = 0_usize;
    loop {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        line += 1;
        if !buffer.ends_with(b"\n") {
            break;
        }
        if buffer.len() > MAX_LINE_BYTES {
            damaged_lines += 1;
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&buffer) {
            output.push((line, value));
        } else {
            damaged_lines += 1;
        }
    }
    Ok(JsonlSnapshot {
        records: output,
        warnings: (damaged_lines > 0)
            .then(|| format!("Skipped {damaged_lines} damaged transcript line(s)"))
            .into_iter()
            .collect(),
    })
}

fn workspace_matches(candidate: &Path, workspace: &Path) -> bool {
    platform_path::equivalent(candidate, workspace)
        || platform_path::starts_with(candidate, workspace)
}

fn page_events(
    values: Vec<IndexedEvent>,
    cursor: Option<&str>,
    limit: usize,
    warnings: Vec<String>,
) -> ConversationEventPage {
    let end = cursor
        .and_then(decode_cursor)
        .unwrap_or(values.len())
        .min(values.len());
    let limit = limit.clamp(1, 100);
    let mut start = end.saturating_sub(limit);
    let mut bytes = 0_usize;
    for index in (start..end).rev() {
        bytes = bytes.saturating_add(values[index].event.content.as_ref().map_or(0, String::len));
        if bytes > MAX_PAGE_BYTES {
            start = index.saturating_add(1);
            break;
        }
    }
    ConversationEventPage {
        events: values[start..end]
            .iter()
            .map(|value| value.event.clone())
            .collect(),
        next_cursor: (start > 0).then(|| encode_cursor(start)),
        warnings,
    }
}

fn message_event(
    line: usize,
    kind: ConversationEventKind,
    timestamp: Option<DateTime<Utc>>,
    content: &str,
    attachment_count: u64,
) -> IndexedEvent {
    let (content, truncated) = truncate_utf8(content, MAX_MESSAGE_BYTES);
    IndexedEvent {
        line,
        event: ConversationEvent {
            id: format!("event-{line}"),
            kind,
            timestamp,
            content: Some(content),
            tool_name: None,
            tool_status: None,
            duration_ms: None,
            attachment_count,
            truncated,
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn upsert_tool(
    tools: &mut BTreeMap<String, IndexedEvent>,
    line: usize,
    call_id: &str,
    name: &str,
    status: Option<&str>,
    duration_ms: Option<u64>,
    timestamp: Option<DateTime<Utc>>,
) {
    let key = if call_id.is_empty() {
        format!("line-{line}")
    } else {
        call_id.to_owned()
    };
    let event_id = format!("tool-{line}-{}", tools.len());
    let entry = tools.entry(key.clone()).or_insert_with(|| IndexedEvent {
        line,
        event: ConversationEvent {
            id: event_id,
            kind: ConversationEventKind::ToolSummary,
            timestamp,
            content: None,
            tool_name: Some(sanitize_tool_name(name)),
            tool_status: None,
            duration_ms: None,
            attachment_count: 0,
            truncated: false,
        },
    });
    entry.line = entry.line.min(line);
    if let Some(status) = status {
        entry.event.tool_status = Some(sanitize_tool_status(status));
    }
    if duration_ms.is_some() {
        entry.event.duration_ms = duration_ms;
    }
}

fn response_message_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let text = value
        .as_array()?
        .iter()
        .filter(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

pub(crate) fn injected_codex_user_context_lines(records: &[(usize, Value)]) -> BTreeSet<usize> {
    let mut user_messages_by_turn = BTreeMap::<String, Vec<(usize, bool)>>::new();
    for (line, value) in records {
        if !matches!(
            (
                value.get("type").and_then(Value::as_str),
                value.pointer("/payload/type").and_then(Value::as_str),
                value.pointer("/payload/role").and_then(Value::as_str),
            ),
            (Some("response_item"), Some("message"), Some("user"))
        ) {
            continue;
        }
        let Some(turn_id) = value
            .pointer("/payload/internal_chat_message_metadata_passthrough/turn_id")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(content) = value.pointer("/payload/content") else {
            continue;
        };
        user_messages_by_turn
            .entry(turn_id.into())
            .or_default()
            .push((*line, is_injected_codex_context_content(content)));
    }
    user_messages_by_turn
        .into_values()
        .filter(|messages| messages.iter().any(|(_, is_context)| !is_context))
        .flat_map(|messages| {
            messages
                .into_iter()
                .filter_map(|(line, is_context)| is_context.then_some(line))
        })
        .collect()
}

fn is_injected_codex_context_content(value: &Value) -> bool {
    let Some(blocks) = value.as_array() else {
        return false;
    };
    !blocks.is_empty()
        && blocks.iter().all(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("text" | "input_text")
            ) && block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(looks_like_internal_context)
        })
}

fn attachment_count(value: &Value) -> u64 {
    value
        .pointer("/payload/images")
        .and_then(Value::as_array)
        .map_or(0, |values| values.len() as u64)
        + value
            .pointer("/payload/local_images")
            .and_then(Value::as_array)
            .map_or(0, |values| values.len() as u64)
}

fn claude_attachment_count(content: &Value) -> u64 {
    content.as_array().map_or(0, |blocks| {
        blocks
            .iter()
            .filter(|block| {
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("image" | "document")
                )
            })
            .count() as u64
    })
}

fn sanitize_title(value: Option<&str>) -> Option<String> {
    let normalized = value?
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = normalized.chars().take(MAX_TITLE_CHARS).collect::<String>();
    if title.is_empty() || looks_like_internal_context(&title) {
        None
    } else {
        Some(title)
    }
}

fn looks_like_internal_context(value: &str) -> bool {
    let value = value.trim_start();
    [
        "<path>",
        "<content>",
        "<recommended_plugins>",
        "<available_skills>",
        "<app-context>",
        "<skills_instructions>",
        "<environment_context>",
        "# AGENTS.md instructions",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}

fn sanitize_metadata(value: Option<String>) -> Option<String> {
    value.and_then(|value| sanitize_title(Some(&value)))
}

fn sanitize_tool_name(value: &str) -> String {
    sanitize_title(Some(value)).unwrap_or_else(|| "tool".into())
}

fn sanitize_tool_status(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "completed" | "success" | "succeeded" => "completed",
        "failed" | "error" => "failed",
        "started" | "running" | "in_progress" => "running",
        _ => "unknown",
    }
    .into()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

fn encode_cursor(index: usize) -> String {
    format!("p{index:x}")
}

fn decode_cursor(value: &str) -> Option<usize> {
    usize::from_str_radix(value.strip_prefix('p')?, 16).ok()
}

fn open_read_only(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {} read-only", path.display()))
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

fn first_column_expression(
    columns: &BTreeSet<String>,
    candidates: &[&str],
    fallback: &str,
) -> String {
    let existing = candidates
        .iter()
        .filter(|column| columns.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    match existing.as_slice() {
        [] => fallback.into(),
        [only] => (*only).into(),
        values => format!("COALESCE({})", values.join(", ")),
    }
}

fn timestamp_from_integer(value: i64) -> Option<DateTime<Utc>> {
    if value.abs() >= 10_000_000_000 {
        Utc.timestamp_millis_opt(value).single()
    } else {
        Utc.timestamp_opt(value, 0).single()
    }
}

fn parse_json_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(value) = value.as_i64() {
        return timestamp_from_integer(value);
    }
    value
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::tempdir;

    use super::*;

    fn write_codex_database(path: &Path, rows: &[(&str, &Path, &Path, &str, bool)]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let database = Connection::open(path).unwrap();
        database.execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, git_branch TEXT, archived INTEGER);").unwrap();
        for (id, transcript, workspace, title, archived) in rows {
            database
                .execute(
                    "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 1, 2, 'main', ?5)",
                    rusqlite::params![
                        id,
                        transcript.display().to_string(),
                        workspace.display().to_string(),
                        title,
                        i64::from(*archived),
                    ],
                )
                .unwrap();
        }
    }

    #[test]
    fn codex_lists_active_archived_and_missing_transcripts() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let transcript = dir.path().join("session.jsonl");
        fs::write(&transcript, "{}\n").unwrap();
        let database = Connection::open(dir.path().join("state_1.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, git_branch TEXT, archived INTEGER);").unwrap();
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 1, 2, 'main', 0)",
                rusqlite::params![
                    "private-id",
                    transcript.display().to_string(),
                    workspace.display().to_string(),
                    "Active"
                ],
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 1, 3, NULL, 1)",
                rusqlite::params![
                    "archived-id",
                    dir.path().join("missing.jsonl").display().to_string(),
                    workspace.display().to_string(),
                    "Archived\nTitle"
                ],
            )
            .unwrap();
        drop(database);

        let sessions = CodexProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|value| value.native_ref == "private-id"
            && value.availability == SessionAvailability::Readable));
        assert!(sessions.iter().any(|value| value.archived
            && value.availability == SessionAvailability::MetadataOnly
            && value.title.as_deref() == Some("Archived Title")));
    }

    #[test]
    fn codex_prefers_all_current_databases_without_reviving_legacy_sessions() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let current_a = dir.path().join("current-a.jsonl");
        let current_b = dir.path().join("current-b.jsonl");
        let deleted = dir.path().join("deleted.jsonl");
        fs::write(&current_a, "{}\n").unwrap();
        fs::write(&current_b, "{}\n").unwrap();
        write_codex_database(
            &dir.path().join("state_1.sqlite"),
            &[("current-a", &current_a, &workspace, "Current A", false)],
        );
        write_codex_database(
            &dir.path().join("state_2.sqlite"),
            &[("current-b", &current_b, &workspace, "Current B", true)],
        );
        write_codex_database(
            &dir.path().join("sqlite/state_1.sqlite"),
            &[("deleted", &deleted, &workspace, "Deleted", false)],
        );

        let sessions = CodexProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();

        assert_eq!(sessions.len(), 2);
        assert!(
            sessions
                .iter()
                .any(|session| session.native_ref == "current-a")
        );
        assert!(
            sessions
                .iter()
                .any(|session| session.native_ref == "current-b" && session.archived)
        );
        assert!(
            !sessions
                .iter()
                .any(|session| session.native_ref == "deleted")
        );
    }

    #[test]
    fn codex_uses_legacy_database_only_when_current_database_is_absent() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let transcript = dir.path().join("legacy.jsonl");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&transcript, "{}\n").unwrap();
        write_codex_database(
            &dir.path().join("sqlite/state_1.sqlite"),
            &[("legacy", &transcript, &workspace, "Legacy", false)],
        );

        let sessions = CodexProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_ref, "legacy");
    }

    #[test]
    fn codex_does_not_hide_an_unreadable_current_database_with_legacy_data() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let transcript = dir.path().join("legacy.jsonl");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&transcript, "{}\n").unwrap();
        fs::write(dir.path().join("state_1.sqlite"), "not sqlite").unwrap();
        write_codex_database(
            &dir.path().join("sqlite/state_1.sqlite"),
            &[("legacy", &transcript, &workspace, "Legacy", false)],
        );

        let error = CodexProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap_err();

        assert!(error.to_string().contains("database"));
    }

    #[test]
    fn codex_keeps_visible_context_like_messages_and_skips_only_injected_context() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let records = [
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"},"content":[{"type":"input_text","text":"<environment_context>injected context</environment_context>"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"},"content":[{"type":"input_text","text":"continue the real task"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<path>visible assistant output</path>"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"turn_id":"turn-2"},"content":[{"type":"input_text","text":"<path>the user intentionally used this prefix</path>"}]}}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(|record| format!("{}\n", serde_json::to_string(record).unwrap()))
                .collect::<String>(),
        )
        .unwrap();

        let page = read_codex_events(&path, None, 100).unwrap();
        let contents = page
            .events
            .iter()
            .filter_map(|event| event.content.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            contents,
            [
                "continue the real task",
                "<path>visible assistant output</path>",
                "<path>the user intentionally used this prefix</path>",
            ]
        );
    }

    #[test]
    fn codex_excludes_private_event_types_and_tool_payloads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        for value in [
            serde_json::json!({"timestamp":"2026-08-13T10:00:00Z","type":"turn_context","payload":{"developer_instructions":"private developer"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"hello","images":["private-image"]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"answer"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:03Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"private reasoning"}]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:04Z","type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"secret_tool","arguments":"private argument"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:05Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"private output"}}),
        ] {
            writeln!(file, "{value}").unwrap();
        }
        write!(file, "{{\"type\":").unwrap();
        drop(file);

        let page = read_codex_events(&path, None, 100).unwrap();
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.events[0].content.as_deref(), Some("hello"));
        assert_eq!(page.events[0].attachment_count, 1);
        let debug = format!("{page:?}");
        for secret in [
            "private developer",
            "private reasoning",
            "private argument",
            "private output",
            "private-image",
        ] {
            assert!(!debug.contains(secret));
        }
    }

    #[test]
    fn claude_indexes_v1_and_reads_messages_and_tool_summaries() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("private-session.jsonl");
        let mut file = File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"system","message":{"content":"private system"}})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"user","timestamp":"2026-08-13T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"question"}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"assistant","timestamp":"2026-08-13T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"private"}}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"user","timestamp":"2026-08-13T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"private result"}]}})).unwrap();
        fs::write(projects.join("sessions-index.json"), serde_json::to_vec(&serde_json::json!({"version":1,"entries":[{"sessionId":"private-session","fullPath":transcript,"projectPath":workspace,"summary":"Summary\nTitle","created":1_700_000_000_000_i64,"modified":1_700_000_001_000_i64,"messageCount":3,"isSidechain":true}]})).unwrap()).unwrap();

        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Summary Title"));
        assert!(sessions[0].sidechain);
        let page = provider.read_events("private-session", None, 100).unwrap();
        assert_eq!(page.events.len(), 3);
        let debug = format!("{page:?}");
        assert!(!debug.contains("private system"));
        assert!(!debug.contains("private result"));
        assert!(!debug.contains("file_path"));
    }

    #[test]
    fn claude_discovers_readable_transcript_without_index_or_history() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("transcript-only.jsonl");
        let mut file = File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"user",
                "sessionId":"transcript-only",
                "cwd":workspace,
                "gitBranch":"feature/session-browser",
                "timestamp":"2026-08-13T10:00:00Z",
                "message":{"role":"user","content":"question"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"assistant",
                "sessionId":"transcript-only",
                "cwd":workspace,
                "timestamp":"2026-08-13T10:00:01Z",
                "message":{"role":"assistant","content":"answer"}
            })
        )
        .unwrap();
        drop(file);
        // Keep history newer than the fixture file mtime so the assertion is deterministic.
        fs::write(
            dir.path().join("history.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "project":workspace,
                    "sessionId":"transcript-only",
                    "timestamp":"2099-08-21T10:00:00Z",
                    "display":"private prompt"
                })
            ),
        )
        .unwrap();

        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_ref, "transcript-only");
        assert_eq!(sessions[0].availability, SessionAvailability::Readable);
        assert_eq!(
            sessions[0].git_branch.as_deref(),
            Some("feature/session-browser")
        );
        assert_eq!(
            sessions[0].updated_at.unwrap().to_rfc3339(),
            "2099-08-21T10:00:00+00:00"
        );
        let page = provider.read_events("transcript-only", None, 100).unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].content.as_deref(), Some("question"));
        assert_eq!(page.events[1].content.as_deref(), Some("answer"));
    }

    #[test]
    fn claude_ignores_oversized_index_and_discovers_transcript() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("transcript-only.jsonl");
        writeln!(
            File::create(&transcript).unwrap(),
            "{}",
            serde_json::json!({
                "type":"user",
                "sessionId":"transcript-only",
                "cwd":workspace,
                "message":{"role":"user","content":"question"}
            })
        )
        .unwrap();
        File::create(projects.join("sessions-index.json"))
            .unwrap()
            .set_len(MAX_CLAUDE_INDEX_BYTES + 1)
            .unwrap();

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_ref, "transcript-only");
        assert_eq!(sessions[0].availability, SessionAvailability::Readable);
    }

    #[test]
    fn claude_indexless_main_handoff_filters_mixed_sidechain_records() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("mixed-session.jsonl");
        let mut file = File::create(&transcript).unwrap();
        for value in [
            serde_json::json!({
                "type":"user",
                "sessionId":"mixed-session",
                "cwd":workspace,
                "message":{"role":"user","content":"main question"}
            }),
            serde_json::json!({
                "type":"assistant",
                "sessionId":"mixed-session",
                "cwd":workspace,
                "isSidechain":true,
                "message":{"role":"assistant","content":"private sidechain"}
            }),
            serde_json::json!({
                "type":"assistant",
                "sessionId":"mixed-session",
                "cwd":workspace,
                "message":{"role":"assistant","content":"main answer"}
            }),
        ] {
            writeln!(file, "{value}").unwrap();
        }
        drop(file);

        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(!sessions[0].sidechain);

        let context = provider.read_handoff_context("mixed-session").unwrap();
        assert_eq!(context.messages.len(), 2);
        assert_eq!(
            context.messages[0].content.as_deref(),
            Some("main question")
        );
        assert_eq!(context.messages[1].content.as_deref(), Some("main answer"));
        assert!(
            context
                .messages
                .iter()
                .all(|message| message.content.as_deref() != Some("private sidechain"))
        );
    }

    #[test]
    fn claude_does_not_create_sessions_from_history_without_transcripts() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut history = File::create(dir.path().join("history.jsonl")).unwrap();
        for value in [
            serde_json::json!({"project":workspace,"sessionId":"private-session","timestamp":1_700_000_002_000_i64,"display":"private latest prompt","pastedContents":{"private":"content"}}),
            serde_json::json!({"project":workspace,"sessionId":"private-session","timestamp":1_700_000_001_000_i64,"display":"private first prompt"}),
            serde_json::json!({"project":dir.path().join("other"),"sessionId":"other-session","timestamp":1_700_000_003_000_i64,"display":"other prompt"}),
        ] {
            writeln!(history, "{value}").unwrap();
        }
        drop(history);

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn claude_does_not_create_sessions_from_an_index_with_a_missing_transcript() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(projects.join("sessions-index.json"), serde_json::to_vec(&serde_json::json!({"version":1,"entries":[{"sessionId":"deleted-session","fullPath":projects.join("deleted-session.jsonl"),"projectPath":workspace,"summary":"Deleted","created":1_700_000_000_000_i64,"modified":1_700_000_001_000_i64}]})).unwrap()).unwrap();

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();

        assert!(sessions.is_empty());
    }

    #[test]
    fn claude_excludes_codexbar_probe_artifacts() {
        let dir = tempdir().unwrap();
        let probe = dir.path().join("ClaudeProbe");
        let projects = dir.path().join("projects/probe");
        fs::create_dir_all(&probe).unwrap();
        fs::create_dir_all(&projects).unwrap();
        fs::write(probe.join(".codexbar-session-id"), "probe-session").unwrap();
        let transcript = projects.join("probe-session.jsonl");
        fs::write(
            &transcript,
            format!(
                "{}\n",
                serde_json::json!({
                    "type":"user",
                    "sessionId":"probe-session",
                    "cwd":probe,
                    "message":{"role":"user","content":"/usage"}
                })
            ),
        )
        .unwrap();
        fs::write(
            dir.path().join("history.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::json!({"project":probe,"sessionId":"probe-session"}),
                serde_json::json!({"project":probe,"sessionId":"old-probe-session"})
            ),
        )
        .unwrap();

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&probe)
            .unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn title_and_message_limits_are_utf8_safe() {
        let title = "中".repeat(250);
        assert_eq!(sanitize_title(Some(&title)).unwrap().chars().count(), 200);
        let message = "中".repeat(MAX_MESSAGE_BYTES);
        let (truncated, was_truncated) = truncate_utf8(&message, MAX_MESSAGE_BYTES);
        assert!(was_truncated);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn internal_context_is_not_used_as_a_session_title() {
        assert_eq!(
            sanitize_title(Some("<path>SKILL.md</path>\n<content>rules")),
            None
        );
        assert_eq!(
            sanitize_title(Some("<recommended_plugins>...</recommended_plugins>")),
            None
        );
        assert_eq!(
            sanitize_title(Some("# AGENTS.md instructions\nprivate")),
            None
        );
        assert_eq!(
            sanitize_title(Some("Fix the <path> label")),
            Some("Fix the <path> label".into())
        );
    }

    fn handoff_source(agent: AgentKind) -> ConversationSessionSummary {
        ConversationSessionSummary {
            id: "hashed-session".into(),
            workspace_id: "workspace".into(),
            agent,
            title: Some("Fix auth".into()),
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: Some("feature/auth".into()),
            archived: false,
            sidechain: false,
            availability: SessionAvailability::Readable,
        }
    }

    fn handoff_request(
        source: &ConversationSessionSummary,
        format: HandoffFormat,
    ) -> SessionHandoffRequest {
        SessionHandoffRequest {
            session_id: source.id.clone(),
            target_agent: AgentKind::ClaudeCode,
            format,
            history_budget_tokens: DEFAULT_HISTORY_BUDGET_TOKENS,
        }
    }

    fn handoff_message(
        kind: ConversationEventKind,
        content: impl Into<String>,
    ) -> ConversationEvent {
        ConversationEvent {
            id: "event".into(),
            kind,
            timestamp: None,
            content: Some(content.into()),
            tool_name: None,
            tool_status: None,
            duration_ms: None,
            attachment_count: 0,
            truncated: false,
        }
    }

    #[test]
    fn codex_handoff_uses_latest_native_compaction_and_post_compact_messages() {
        let dir = tempdir().unwrap();
        let transcript = dir.path().join("codex.jsonl");
        let records = [
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"before compact"}}),
            serde_json::json!({"type":"compacted","payload":{"message":"first summary"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"between summaries"}}),
            serde_json::json!({"type":"compacted","payload":{"message":"latest summary"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"exec"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"continue here"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"work resumed"}}),
        ];
        fs::write(
            &transcript,
            format!(
                "{}\n",
                records
                    .iter()
                    .map(serde_json::Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        )
        .unwrap();

        let context = read_codex_handoff_context(&transcript).unwrap();
        assert_eq!(context.compact_summary.as_deref(), Some("latest summary"));
        assert_eq!(context.messages.len(), 2);
        assert_eq!(
            context.messages[0].content.as_deref(),
            Some("continue here")
        );
        assert_eq!(context.messages[1].content.as_deref(), Some("work resumed"));
        assert_eq!(context.omitted_tool_count, 1);
    }

    #[test]
    fn claude_handoff_uses_compact_summary_and_skips_echoes_tools_and_sidechains() {
        let dir = tempdir().unwrap();
        let transcript = dir.path().join("claude.jsonl");
        let records = [
            serde_json::json!({"type":"user","message":{"role":"user","content":"before compact"}}),
            serde_json::json!({"type":"system","subtype":"compact_boundary"}),
            serde_json::json!({"type":"user","isCompactSummary":true,"message":{"role":"user","content":"native summary"}}),
            serde_json::json!({"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>"}}),
            serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Read"}]}}),
            serde_json::json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"sidechain detail"}}),
            serde_json::json!({"type":"user","message":{"role":"user","content":"continue here"}}),
            serde_json::json!({"type":"assistant","message":{"role":"assistant","content":"work resumed"}}),
        ];
        fs::write(
            &transcript,
            format!(
                "{}\n",
                records
                    .iter()
                    .map(serde_json::Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        )
        .unwrap();

        let context = read_claude_handoff_context(&transcript, false).unwrap();
        assert_eq!(context.compact_summary.as_deref(), Some("native summary"));
        assert_eq!(context.messages.len(), 2);
        assert_eq!(
            context.messages[0].content.as_deref(),
            Some("continue here")
        );
        assert_eq!(context.messages[1].content.as_deref(), Some("work resumed"));
        assert_eq!(context.omitted_tool_count, 1);
    }

    #[test]
    fn damaged_native_compaction_falls_back_to_the_full_transcript() {
        let dir = tempdir().unwrap();
        let transcript = dir.path().join("codex.jsonl");
        fs::write(
            &transcript,
            format!(
                "{}\n",
                [
                    serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"before"}}),
                    serde_json::json!({"type":"compacted","payload":{"message":"stale valid summary"}}),
                    serde_json::json!({"type":"compacted","payload":{}}),
                    serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"after"}}),
                ]
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
            ),
        )
        .unwrap();

        let context = read_codex_handoff_context(&transcript).unwrap();
        assert!(context.compact_summary.is_none());
        assert_eq!(context.messages.len(), 2);
        assert_eq!(context.warnings, vec!["compact-fallback"]);
    }

    #[test]
    fn handoff_redacts_native_context_without_persisting_session_id() {
        let source = handoff_source(AgentKind::Codex);
        let request = handoff_request(&source, HandoffFormat::Markdown);
        let context = HandoffContext {
            compact_summary: Some("Continue from /Users/example/project".into()),
            messages: vec![ConversationEvent {
                attachment_count: 1,
                ..handoff_message(
                    ConversationEventKind::UserMessage,
                    "Authorization: Bearer private\nAuthorization=Bearer opaque-value\nAPI_KEY=private\nToken budget: 8000\nuse sk-secret-value",
                )
            }],
            omitted_tool_count: 2,
            warnings: Vec::new(),
        };

        let preparation = prepare_handoff(
            &source,
            &request,
            &context,
            Some(Path::new("/Users/example")),
        )
        .unwrap();
        let SessionHandoffPreparation::Ready { draft } = preparation;
        assert!(draft.content.contains("$HOME/project"));
        assert!(draft.content.contains("[REDACTED]"));
        assert!(!draft.content.contains("private"));
        assert!(!draft.content.contains("opaque-value"));
        assert!(draft.content.contains("Token budget: 8000"));
        assert!(!draft.content.contains("hashed-session"));
        assert_eq!(draft.included_message_count, 1);
        assert_eq!(draft.omitted_tool_count, 2);
        assert_eq!(draft.context_source, HandoffContextSource::NativeCompaction);
        assert!(draft.redaction_count >= 5);
    }

    #[test]
    fn json_handoff_has_a_versioned_neutral_context_schema() {
        let source = handoff_source(AgentKind::ClaudeCode);
        let mut request = handoff_request(&source, HandoffFormat::Json);
        request.target_agent = AgentKind::Cursor;
        let context = HandoffContext {
            compact_summary: None,
            messages: vec![handoff_message(ConversationEventKind::AgentMessage, "done")],
            omitted_tool_count: 0,
            warnings: Vec::new(),
        };

        let SessionHandoffPreparation::Ready { draft } =
            prepare_handoff(&source, &request, &context, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(&draft.content).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["target_agent"], "cursor");
        assert_eq!(value["context"]["mode"], "full-transcript");
        assert_eq!(value["context"]["messages"].as_array().unwrap().len(), 1);
        assert!(value.get("session_id").is_none());
        assert!(value["context"].get("events").is_none());
    }

    #[test]
    fn edited_handoff_is_redacted_again_before_save() {
        let (markdown, markdown_count) = sanitize_handoff_export(
            "# Handoff\n\nDATABASE_URL=postgres://private\n/Users/example/project\n",
            HandoffFormat::Markdown,
            Some(Path::new("/Users/example")),
        )
        .unwrap();
        assert!(markdown.contains("DATABASE_URL= [REDACTED]"));
        assert!(markdown.contains("$HOME/project"));
        assert!(!markdown.contains("private"));
        assert_eq!(markdown_count, 2);

        let (json, json_count) = sanitize_handoff_export(
            r#"{"schema_version":1,"context":{"messages":[]},"credentials":"private"}"#,
            HandoffFormat::Json,
            None,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["credentials"], "[REDACTED]");
        assert_eq!(json_count, 1);
    }

    #[test]
    fn sensitive_json_containers_are_redacted_as_a_whole() {
        let content = serde_json::json!({
            "schema_version": 1,
            "context": {"messages": []},
            "tokens": ["first-secret", {"value": "second-secret"}],
            "credentials": {"username": "agent", "password": "third-secret"},
            "api-key": "fourth-secret",
            "access-key": {"id": "fifth-secret"},
            "privateKey": "sixth-secret",
            "databaseUrl": "seventh-secret",
            "accessKey": "eighth-secret"
        })
        .to_string();

        let (json, redaction_count) =
            sanitize_handoff_export(&content, HandoffFormat::Json, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["tokens"], "[REDACTED]");
        assert_eq!(value["credentials"], "[REDACTED]");
        assert_eq!(value["api-key"], "[REDACTED]");
        assert_eq!(value["access-key"], "[REDACTED]");
        assert_eq!(value["privateKey"], "[REDACTED]");
        assert_eq!(value["databaseUrl"], "[REDACTED]");
        assert_eq!(value["accessKey"], "[REDACTED]");
        assert!(!json.contains("first-secret"));
        assert!(!json.contains("second-secret"));
        assert!(!json.contains("third-secret"));
        assert!(!json.contains("fourth-secret"));
        assert!(!json.contains("fifth-secret"));
        assert!(!json.contains("sixth-secret"));
        assert!(!json.contains("seventh-secret"));
        assert!(!json.contains("eighth-secret"));
        assert_eq!(redaction_count, 7);
    }

    #[test]
    fn json_redaction_preserves_noncredential_key_names() {
        let content = serde_json::json!({
            "schema_version": 1,
            "context": {"messages": []},
            "token_budget": 4096,
            "password_policy": "rotate quarterly",
            "secretary": "Ada",
            "github_token": "github-secret",
            "authToken": "auth-secret",
            "AWS_ACCESS_KEY_ID": "aws-secret"
        })
        .to_string();

        let (json, redaction_count) =
            sanitize_handoff_export(&content, HandoffFormat::Json, None).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(value["token_budget"], 4096);
        assert_eq!(value["password_policy"], "rotate quarterly");
        assert_eq!(value["secretary"], "Ada");
        assert_eq!(value["github_token"], "[REDACTED]");
        assert_eq!(value["authToken"], "[REDACTED]");
        assert_eq!(value["AWS_ACCESS_KEY_ID"], "[REDACTED]");
        assert_eq!(redaction_count, 3);
    }

    #[test]
    fn line_redaction_uses_complete_assignment_keys() {
        let mut redaction_count = 0;
        let content = sanitize_handoff_content(
            "token_budget: 4096\npassword_policy=quarterly\nsecretary: Ada\nGITHUB_TOKEN=private",
            None,
            &mut redaction_count,
        );

        assert!(content.contains("token_budget: 4096"));
        assert!(content.contains("password_policy=quarterly"));
        assert!(content.contains("secretary: Ada"));
        assert!(content.contains("GITHUB_TOKEN= [REDACTED]"));
        assert!(!content.contains("private"));
        assert_eq!(redaction_count, 1);
    }

    #[test]
    fn credential_prefix_redaction_requires_a_boundary_and_plausible_value() {
        let mut redaction_count = 0;
        let content = sanitize_handoff_content(
            "task-runner risk-based disk-backed sk-short risk-sk-abcdefghijkl actual=sk-abcdefghijkl",
            None,
            &mut redaction_count,
        );

        assert!(content.contains("task-runner risk-based disk-backed sk-short"));
        assert!(content.contains("risk-sk-abcdefghijkl"));
        assert!(content.contains("actual=[REDACTED]"));
        assert_eq!(redaction_count, 1);
    }

    #[test]
    fn line_redaction_scans_assignments_after_url_delimiters() {
        let mut redaction_count = 0;
        let content = sanitize_handoff_content(
            "callback=https://host/path?mode=plain&token=plain-secret-value\nurl=https://host/path?mode=plain",
            None,
            &mut redaction_count,
        );

        assert_eq!(
            content,
            "callback=https://host/path?mode=plain&token= [REDACTED]\nurl=https://host/path?mode=plain"
        );
        assert_eq!(redaction_count, 1);
    }

    #[test]
    fn line_redaction_covers_space_separated_cli_credentials() {
        let mut redaction_count = 0;
        let content = sanitize_handoff_content(
            "mysql --password hunter2 --host localhost\n\
             tool --token \"opaque value\" --verbose\n\
             tool --api-key=inline-secret --verbose\n\
             tool --secret='inline private' --verbose\n\
             curl -u alice:hunter2 https://example.test\n\
             curl --user 'bob:private value' https://example.test\n\
             curl -ualice:attached https://example.test\n\
             curl -u=carol:equals https://example.test",
            None,
            &mut redaction_count,
        );

        assert_eq!(
            content,
            "mysql --password [REDACTED] --host localhost\n\
             tool --token [REDACTED] --verbose\n\
             tool --api-key=[REDACTED] --verbose\n\
             tool --secret='[REDACTED]' --verbose\n\
             curl -u [REDACTED] https://example.test\n\
             curl --user [REDACTED] https://example.test\n\
             curl -u[REDACTED] https://example.test\n\
             curl -u=[REDACTED] https://example.test"
        );
        assert_eq!(redaction_count, 8);
    }

    #[test]
    fn cli_redaction_preserves_noncredential_options_and_missing_values() {
        let mut redaction_count = 0;
        let content = sanitize_handoff_content(
            "tool --token-budget 4096 --password-policy strict\n\
             tool --token --verbose\n\
             other -u alice:hunter2",
            None,
            &mut redaction_count,
        );

        assert_eq!(
            content,
            "tool --token-budget 4096 --password-policy strict\n\
             tool --token --verbose\n\
             other -u alice:hunter2"
        );
        assert_eq!(redaction_count, 0);
    }

    #[test]
    fn pem_private_key_blocks_are_fully_redacted_from_exports() {
        let (markdown, markdown_count) = sanitize_handoff_export(
            "# Handoff\n\n-----BEGIN RSA PRIVATE KEY-----\nbase64-secret-material\n-----END RSA PRIVATE KEY-----\nkeep this line\n",
            HandoffFormat::Markdown,
            None,
        )
        .unwrap();
        assert!(markdown.contains("[REDACTED PRIVATE KEY]"));
        assert!(markdown.contains("keep this line"));
        assert!(!markdown.contains("BEGIN RSA PRIVATE KEY"));
        assert!(!markdown.contains("base64-secret-material"));
        assert!(!markdown.contains("END RSA PRIVATE KEY"));
        assert_eq!(markdown_count, 1);

        let json_input = serde_json::json!({
            "schema_version": 1,
            "context": {
                "messages": [{
                    "role": "user",
                    "content": "-----BEGIN OPENSSH PRIVATE KEY-----\njson-secret-material\n-----END OPENSSH PRIVATE KEY-----"
                }]
            }
        })
        .to_string();
        let (json, json_count) =
            sanitize_handoff_export(&json_input, HandoffFormat::Json, None).unwrap();
        assert!(json.contains("[REDACTED PRIVATE KEY]"));
        assert!(!json.contains("json-secret-material"));
        assert!(!json.contains("OPENSSH PRIVATE KEY"));
        assert_eq!(json_count, 1);
    }

    #[test]
    fn handoff_filenames_use_millisecond_precision() {
        let first = "2026-08-18T08:31:58.123Z".parse::<DateTime<Utc>>().unwrap();
        let second = "2026-08-18T08:31:58.124Z".parse::<DateTime<Utc>>().unwrap();

        let first = handoff_filename(
            first,
            AgentKind::Codex,
            AgentKind::ClaudeCode,
            HandoffFormat::Markdown,
        );
        let second = handoff_filename(
            second,
            AgentKind::Codex,
            AgentKind::ClaudeCode,
            HandoffFormat::Markdown,
        );
        assert_eq!(first, "20260818-083158123-codex-to-claude-code.md");
        assert_ne!(first, second);
    }

    #[test]
    fn edited_handoff_accepts_more_than_two_hundred_messages_without_summarizing() {
        let messages = vec![serde_json::json!({"role": "user"}); 201];
        let content = serde_json::json!({
            "schema_version": 1,
            "context": {"messages": messages}
        })
        .to_string();
        assert!(sanitize_handoff_export(&content, HandoffFormat::Json, None).is_ok());

        let markdown = std::iter::repeat_n("### User\n\nmessage", 201)
            .collect::<Vec<_>>()
            .join("\n\n");
        assert!(sanitize_handoff_export(&markdown, HandoffFormat::Markdown, None).is_ok());
    }
}
