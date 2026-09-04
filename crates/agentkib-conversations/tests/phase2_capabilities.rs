use agentkib_conversations::{
    ContinuationCapabilities, ContinuationCapability, ContinuationCapabilityStatus,
};
use agentkib_core::AgentKind;

fn capability(status: ContinuationCapabilityStatus) -> ContinuationCapability {
    ContinuationCapability {
        status,
        reason: None,
    }
}

#[test]
fn continuation_capabilities_serialize_each_independent_state() {
    let capabilities = ContinuationCapabilities {
        source_agent: AgentKind::Codex,
        target_agent: AgentKind::ClaudeCode,
        source_read: capability(ContinuationCapabilityStatus::Supported),
        source_parse: capability(ContinuationCapabilityStatus::Supported),
        native_resume: capability(ContinuationCapabilityStatus::Unverified),
        file_handoff: capability(ContinuationCapabilityStatus::Supported),
        windowed_context: capability(ContinuationCapabilityStatus::Unavailable),
        mcp_setup: capability(ContinuationCapabilityStatus::Supported),
        interactive_launch: capability(ContinuationCapabilityStatus::Unavailable),
    };

    let encoded = serde_json::to_value(capabilities).expect("capabilities should serialize");

    assert_eq!(encoded["source_agent"], "codex");
    assert_eq!(encoded["target_agent"], "claude-code");
    assert_eq!(encoded["source_read"]["status"], "supported");
    assert_eq!(encoded["native_resume"]["status"], "unverified");
    assert_eq!(encoded["windowed_context"]["status"], "unavailable");
}
