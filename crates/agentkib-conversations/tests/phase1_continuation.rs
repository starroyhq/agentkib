use std::path::Path;

use agentkib_conversations::{
    HandoffFormat, SESSION_DOCUMENT_SCHEMA_VERSION, SessionAttachmentKind, SessionBlock,
    SessionDocument, SessionDocumentSource, SessionRole, SessionTurn, SessionWindowStrategy,
    estimate_document_tokens, fingerprint, plan_session_window, render_claude_native_session,
    render_codex_native_session, render_handoff, sanitize_handoff_export,
    validate_native_roundtrip,
};
use agentkib_core::AgentKind;
use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

fn synthetic_fixture(source_agent: AgentKind) -> SessionDocument {
    SessionDocument {
        schema_version: SESSION_DOCUMENT_SCHEMA_VERSION,
        source: SessionDocumentSource {
            agent: source_agent,
            workspace_id: "phase1-fixture-workspace".into(),
            title: Some("Synthetic continuation fixture".into()),
            created_at: None,
            updated_at: None,
            git_branch: Some("phase1-fixture".into()),
        },
        turns: vec![
            SessionTurn {
                id: "turn-user".into(),
                role: SessionRole::User,
                timestamp: None,
                blocks: vec![SessionBlock::Text {
                    text: "Continue the synthetic task with TOKEN_FIXTURE and ENV_FIXTURE.".into(),
                }],
            },
            SessionTurn {
                id: "turn-assistant".into(),
                role: SessionRole::Assistant,
                timestamp: None,
                blocks: vec![
                    SessionBlock::Text {
                        text: "I inspected /synthetic/workspace and will continue safely.".into(),
                    },
                    SessionBlock::ToolCall {
                        call_id: "call-read-fixture".into(),
                        name: "read_file".into(),
                        input: r#"{"path":"/synthetic/workspace/README.md"}"#.into(),
                    },
                    SessionBlock::ToolResult {
                        call_id: "call-read-fixture".into(),
                        output: "Synthetic README contents".into(),
                        is_error: false,
                    },
                    SessionBlock::ToolResult {
                        call_id: "call-missing-fixture".into(),
                        output: "Synthetic missing file".into(),
                        is_error: true,
                    },
                    SessionBlock::Attachment {
                        kind: SessionAttachmentKind::Image,
                        media_type: "image/png".into(),
                        filename: Some("fixture.png".into()),
                        inline_base64: Some("cGh1bXk=".into()),
                    },
                    SessionBlock::Attachment {
                        kind: SessionAttachmentKind::Document,
                        media_type: "application/pdf".into(),
                        filename: Some("fixture.pdf".into()),
                        inline_base64: Some("cGh1bXktcGRm".into()),
                    },
                ],
            },
        ],
        losses: Vec::new(),
        redaction_count: 0,
    }
}

#[test]
fn phase1_fixture_covers_all_four_continuation_paths() {
    let now = Utc::now();
    let workspace = Path::new("/synthetic/workspace");

    let codex_fixture = synthetic_fixture(AgentKind::Codex);
    let codex_session = render_codex_native_session(&codex_fixture, Uuid::new_v4(), workspace, now)
        .expect("Codex fixture should render");
    validate_native_roundtrip(&codex_session, AgentKind::Codex, &codex_fixture)
        .expect("Codex fixture should survive native round-trip");

    let claude_fixture = synthetic_fixture(AgentKind::ClaudeCode);
    let claude_session =
        render_claude_native_session(&claude_fixture, Uuid::new_v4(), workspace, now)
            .expect("Claude Code fixture should render");
    validate_native_roundtrip(&claude_session, AgentKind::ClaudeCode, &claude_fixture)
        .expect("Claude Code fixture should survive native round-trip");

    let codex_to_claude = render_handoff(
        &codex_fixture,
        AgentKind::ClaudeCode,
        HandoffFormat::Json,
        now,
    )
    .expect("Codex to Claude Code handoff should render");
    let codex_to_claude_json: Value =
        serde_json::from_str(&codex_to_claude).expect("handoff should be valid JSON");
    assert_eq!(
        codex_to_claude_json["session"],
        serde_json::to_value(&codex_fixture).expect("fixture should serialize"),
    );

    let claude_to_codex =
        render_handoff(&claude_fixture, AgentKind::Codex, HandoffFormat::Json, now)
            .expect("Claude Code to Codex handoff should render");
    let claude_to_codex_json: Value =
        serde_json::from_str(&claude_to_codex).expect("handoff should be valid JSON");
    assert_eq!(
        claude_to_codex_json["session"],
        serde_json::to_value(&claude_fixture).expect("fixture should serialize"),
    );
}

#[test]
fn phase1_fixture_rechecks_edits_before_handoff_and_reports_redactions() {
    let fixture = synthetic_fixture(AgentKind::Codex);
    let original_fingerprint = fingerprint(&fixture).expect("fixture should have a fingerprint");
    let mut changed_fixture = fixture.clone();
    changed_fixture.turns[0].blocks[0] = SessionBlock::Text {
        text: "The source changed after preview.".into(),
    };

    assert_ne!(
        original_fingerprint,
        fingerprint(&changed_fixture).expect("changed fixture should have a fingerprint"),
        "a changed source must invalidate the prepared preview"
    );

    let edited_handoff = "Continue from /Users/example/project with API_KEY=private-value";
    let (sanitized, redaction_count) = sanitize_handoff_export(
        edited_handoff,
        HandoffFormat::Markdown,
        Some(Path::new("/Users/example")),
    )
    .expect("edited handoff should be sanitized before writing");

    assert!(redaction_count >= 2);
    assert!(sanitized.contains("$HOME/project"));
    assert!(sanitized.contains("[REDACTED]"));
    assert!(!sanitized.contains("private-value"));
}

#[test]
fn phase1_fixture_windows_long_sessions_without_losing_the_recent_exchange() {
    let mut fixture = synthetic_fixture(AgentKind::Codex);
    fixture.turns.extend((0..40).flat_map(|index| {
        [
            SessionTurn {
                id: format!("long-user-{index}"),
                role: SessionRole::User,
                timestamp: None,
                blocks: vec![SessionBlock::Text {
                    text: format!("Synthetic long-session task {index} {}", "中".repeat(5_000)),
                }],
            },
            SessionTurn {
                id: format!("long-assistant-{index}"),
                role: SessionRole::Assistant,
                timestamp: None,
                blocks: vec![SessionBlock::Text {
                    text: format!(
                        "Synthetic long-session answer {index} {}",
                        "answer ".repeat(2_000)
                    ),
                }],
            },
        ]
    }));
    fixture.turns.push(SessionTurn {
        id: "long-recent-user".into(),
        role: SessionRole::User,
        timestamp: None,
        blocks: vec![SessionBlock::Text {
            text: "The recent exchange must stay active.".into(),
        }],
    });

    assert!(estimate_document_tokens(&fixture) > 64_000);
    let plan = plan_session_window(&fixture, 64_000, &Uuid::new_v4().to_string())
        .expect("long fixture should produce a bounded window");

    assert_eq!(plan.strategy, SessionWindowStrategy::Windowed);
    assert!(plan.stats.estimated_active_tokens <= 64_000);
    assert!(plan.stats.deferred_turn_count > 0);
    assert!(
        serde_json::to_string(&plan.active_document)
            .expect("active fixture should serialize")
            .contains("The recent exchange must stay active.")
    );
}
