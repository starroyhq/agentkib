#[cfg(any(target_os = "macos", test))]
use crate::method_version;
#[cfg(any(target_os = "macos", test))]
use anyhow::bail;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    WaitingForSnapshot,
    Idle,
    Running,
    AwaitingApproval,
    Unsupported,
    Disconnected,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
pub struct Approval {
    pub request_id: Value,
    pub turn_id: String,
    pub method: String,
    pub details: Value,
}

/// Owns one explicitly selected conversation. Never merges another host/thread's data.
pub struct SessionState {
    pub(crate) conversation: String,
    #[cfg(any(target_os = "macos", test))]
    pub(crate) owner: String,
    pub(crate) revision: Option<u64>,
    pub(crate) snapshot: Option<Value>,
    pub(crate) status: Status,
    #[cfg(any(target_os = "macos", test))]
    valid_stream: bool,
    #[cfg(any(target_os = "macos", test))]
    pub(crate) snapshot_count: u64,
}

impl SessionState {
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn new(conversation: String, owner: String) -> Self {
        Self {
            conversation,
            owner,
            revision: None,
            snapshot: None,
            status: Status::WaitingForSnapshot,
            valid_stream: true,
            snapshot_count: 0,
        }
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }
    pub fn conversation_id(&self) -> &str {
        &self.conversation
    }
    /// Read-only content of the selected conversation, never an input for a wire command.
    pub fn snapshot(&self) -> Option<&Value> {
        self.snapshot.as_ref()
    }
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn invalidate(&mut self, status: Status) {
        self.revision = None;
        self.snapshot = None;
        self.status = status;
        self.valid_stream = false;
    }

    pub fn active_turn(&self) -> Option<&str> {
        let turns = conversation_turns(self.snapshot.as_ref()?).ok()?;
        let active = turns.iter().find(|t| t["status"] == "inProgress")?["turnId"]
            .as_str()
            .filter(|id| !id.is_empty())?;
        // Do not guess when canonical history and live overlays disagree.
        if turns.iter().any(|t| {
            (t["status"] == "inProgress" && t["turnId"] != active)
                || (t["turnId"] == active && t["status"] != "inProgress")
        }) {
            return None;
        }
        Some(active)
    }

    pub fn approvals(&self) -> Vec<Approval> {
        let Some(snapshot) = &self.snapshot else {
            return vec![];
        };
        let Some(turn) = self.active_turn() else {
            return vec![];
        };
        snapshot["requests"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|request| {
                let method = request["method"].as_str()?;
                let params = &request["params"];
                if !matches!(
                    method,
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                ) || params["threadId"] != self.conversation
                    || params["turnId"] != turn
                    || !(request["id"].is_string() || request["id"].is_i64())
                {
                    return None;
                }
                let mut details = params.clone();
                if method == "item/fileChange/requestApproval"
                    && let Some(item) = conversation_turns(snapshot)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|t| t["turnId"] == turn)
                        .flat_map(|t| t["items"].as_array().into_iter().flatten())
                        .find(|item| item["id"] == params["itemId"] && item["type"] == "fileChange")
                {
                    details["changes"] = item["changes"].clone();
                }
                Some(Approval {
                    request_id: request["id"].clone(),
                    turn_id: turn.to_owned(),
                    method: method.into(),
                    details,
                })
            })
            .collect()
    }

    pub fn questions(&self) -> Vec<Value> {
        let Some(snapshot) = &self.snapshot else {
            return vec![];
        };
        let Some(turn) = self.active_turn() else {
            return vec![];
        };
        snapshot["requests"].as_array().into_iter().flatten().filter_map(|r| {
            let p = &r["params"];
            if r["method"] != "item/tool/requestUserInput" || p["threadId"] != self.conversation || p["turnId"] != turn || !(r["id"].is_string() || r["id"].is_i64()) { return None; }
            let rows = p["questions"].as_array().map(Vec::as_slice).unwrap_or_default();
            let mut ids = std::collections::HashSet::new();
            let supported = !rows.is_empty() && rows.len() <= 16 && rows.iter().all(|q| q["id"].as_str().is_some_and(|id| !id.is_empty() && ids.insert(id)) && q["question"].as_str().is_some_and(|s| !s.is_empty()) && q.get("isSecret").is_none_or(|v| v == false) && q.get("isMultiSelect").is_none_or(|v| v == false) && q["options"].as_array().is_some_and(|opts| { let mut labels = std::collections::HashSet::new(); (!opts.is_empty() || q["isOther"] == true) && opts.iter().all(|o| o["label"].as_str().is_some_and(|label| !label.is_empty() && labels.insert(label))) }));
            let questions: Vec<_> = rows.iter().map(|q| serde_json::json!({"id":q["id"],"header":q["header"],"question":q["question"],"options":q["options"],"multiSelect":false,"allowCustom":q["isOther"] == true})).collect();
            Some(serde_json::json!({"requestId":r["id"],"turnId":turn,"method":r["method"],"supported":supported,"questions":questions}))
        }).collect()
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn notification(&mut self, message: Value) -> Result<()> {
        if !self.valid_stream {
            return Ok(());
        }
        if message["type"] != "broadcast" {
            return Ok(());
        }
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        if method == "client-status-changed"
            && params["clientId"] == self.owner
            && message["sourceClientId"] == self.owner
            && message["version"] == 1
            && params["status"] == "disconnected"
        {
            self.invalidate(Status::Disconnected);
            return Ok(());
        }
        if message["sourceClientId"] != self.owner {
            return Ok(());
        }
        if method == "ipc-connection-reset" {
            self.invalidate(Status::Disconnected);
            return Ok(());
        }
        if method != "thread-stream-state-changed"
            || params["conversationId"] != self.conversation
            || params["hostId"] != "local"
        {
            return Ok(());
        }
        let result = self.apply_change(&message);
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        }
        result
    }

    #[cfg(any(target_os = "macos", test))]
    fn apply_change(&mut self, message: &Value) -> Result<()> {
        ensure!(
            message["version"].as_u64() == method_version("thread-stream-state-changed"),
            "incompatible state version"
        );
        let change = &message["params"]["change"];
        let revision = change["revision"]
            .as_u64()
            .context("missing stream revision")?;
        // The verified owner answers an existing follower's refresh with a full
        // snapshot at its current revision. Only an exact repeat is legitimate;
        // equal-revision patches or changed content remain protocol errors.
        if self.revision == Some(revision) {
            ensure!(
                change["type"] == "snapshot"
                    && self.snapshot.as_ref() == Some(&change["conversationState"]),
                "conflicting stream revision"
            );
            self.snapshot_count += 1;
            return Ok(());
        }
        ensure!(
            self.revision.is_none_or(|old| revision > old),
            "stale stream revision"
        );
        let mut snapshot = match change["type"].as_str() {
            Some("snapshot") => change["conversationState"].clone(),
            Some("patches") => {
                ensure!(
                    self.revision.is_some() && change["baseRevision"].as_u64() == self.revision,
                    "stream revision gap"
                );
                let mut value = self.snapshot.clone().context("snapshot missing")?;
                let patches = change["patches"].as_array().context("invalid patches")?;
                ensure!(patches.len() <= 4096, "patch limit exceeded");
                for patch in patches {
                    apply_patch(&mut value, patch)?;
                }
                value
            }
            _ => bail!("unknown stream change"),
        };
        ensure!(
            snapshot["id"] == self.conversation && snapshot["hostId"] == "local",
            "snapshot identity mismatch"
        );
        ensure!(
            snapshot["turns"].is_array() && snapshot["requests"].is_array(),
            "unsupported conversation schema"
        );
        let turns = conversation_turns(&snapshot)?;
        // Bound accumulated state as well as individual frames; patches can grow it indefinitely.
        ensure!(
            serde_json::to_vec(&snapshot)?.len() <= 8 * 1024 * 1024,
            "snapshot limit exceeded"
        );
        self.status = match snapshot["threadRuntimeStatus"]["type"].as_str() {
            Some("active") => Status::Running,
            Some("idle") => Status::Idle,
            _ => Status::Unsupported,
        };
        if turns.iter().any(|turn| turn["status"] == "inProgress") {
            self.status = Status::Running;
        }
        if snapshot["requests"]
            .as_array()
            .is_some_and(|r| !r.is_empty())
        {
            self.status = Status::AwaitingApproval;
        }
        if snapshot["unconfirmedTurnSubmissions"]
            .as_array()
            .is_some_and(|r| !r.is_empty())
        {
            self.status = Status::OutcomeUnknown;
        }
        self.revision = Some(revision);
        if change["type"] == "snapshot" {
            self.snapshot_count += 1;
        }
        self.snapshot = Some(snapshot.take());
        // Concurrent submissions can leave an in-progress history placeholder
        // without a confirmed turn ID. Do not report it as a controllable run,
        // nor discard it to manufacture idle; later owner updates may resolve it.
        if matches!(self.status, Status::Running | Status::AwaitingApproval)
            && self.active_turn().is_none()
        {
            self.status = Status::OutcomeUnknown;
        }
        Ok(())
    }
}

// The client stream is not an App Server Thread: newer builds store turns in
// indexed canonical history, with optional live overlays in `turns`.
fn conversation_turns(snapshot: &Value) -> Result<Vec<&Value>> {
    let mut turns: Vec<_> = snapshot["turns"]
        .as_array()
        .context("missing live turns")?
        .iter()
        .collect();
    if let Some(history) = snapshot.get("turnHistory").filter(|v| !v.is_null()) {
        ensure!(history["kind"] == "canonical", "unsupported turn history");
        let history = &history["history"];
        let entities = history["entitiesByKey"]
            .as_object()
            .context("missing turn entities")?;
        for island in history["islands"]
            .as_array()
            .context("missing history islands")?
        {
            for entry in island["entries"]
                .as_array()
                .context("missing history entries")?
            {
                let key = entry["value"].as_str().context("invalid turn key")?;
                turns.push(entities.get(key).context("missing canonical turn")?);
            }
        }
    }
    Ok(turns)
}

// Codex stream patches use Immer array paths, not JSON Pointer strings.
#[cfg(any(target_os = "macos", test))]
fn apply_patch(root: &mut Value, patch: &Value) -> Result<()> {
    let path = patch["path"]
        .as_array()
        .context("patch path must be an array")?;
    ensure!(path.len() <= 64, "patch path too deep");
    let op = patch["op"].as_str().context("patch operation missing")?;
    ensure!(
        matches!(op, "add" | "replace" | "remove"),
        "unsupported patch operation"
    );
    ensure!(
        op == "remove" || patch.get("value").is_some(),
        "patch value missing"
    );
    if path.is_empty() {
        ensure!(op == "replace", "unsupported root operation");
        *root = patch["value"].clone();
        return Ok(());
    }
    let mut parent = root;
    for component in &path[..path.len() - 1] {
        parent = match parent {
            Value::Object(object) => object
                .get_mut(component.as_str().context("object key must be a string")?)
                .context("patch path missing")?,
            Value::Array(array) => array
                .get_mut(index(component)?)
                .context("patch index out of bounds")?,
            _ => bail!("patch parent is not a container"),
        };
    }
    let last = path.last().unwrap();
    match parent {
        Value::Object(object) => {
            let key = last.as_str().context("object key must be a string")?;
            ensure!(
                !matches!(key, "__proto__" | "prototype" | "constructor"),
                "unsafe patch key"
            );
            if op != "add" {
                ensure!(object.contains_key(key), "patch key missing");
            }
            if op == "remove" {
                object.remove(key);
            } else {
                object.insert(key.into(), patch["value"].clone());
            }
        }
        Value::Array(array) => {
            let i = index(last)?;
            if op == "add" {
                ensure!(i <= array.len(), "patch index out of bounds");
                array.insert(i, patch["value"].clone());
            } else {
                ensure!(i < array.len(), "patch index out of bounds");
                if op == "remove" {
                    array.remove(i);
                } else {
                    array[i] = patch["value"].clone();
                }
            }
        }
        _ => bail!("patch parent is not a container"),
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn index(value: &Value) -> Result<usize> {
    usize::try_from(
        value
            .as_u64()
            .context("patch index must be a non-negative integer")?,
    )
    .context("patch index overflow")
}

#[cfg(test)]
mod question_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn questions_require_active_identity_and_answerable_contract() {
        let mut state = SessionState::new("thread".into(), "owner".into());
        state.snapshot = Some(
            json!({"turns":[{"turnId":"turn","status":"inProgress","items":[]}],"requests":[{"id":"q","method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","questions":[{"id":"choice","question":"Which?","isOther":true,"options":[{"label":"A"}]}]}}]}),
        );
        assert_eq!(state.questions()[0]["supported"], true);
        state.snapshot.as_mut().unwrap()["requests"][0]["params"]["questions"][0]["options"] =
            json!([]);
        state.snapshot.as_mut().unwrap()["requests"][0]["params"]["questions"][0]["isOther"] =
            json!(false);
        assert_eq!(state.questions()[0]["supported"], false);
        state.snapshot.as_mut().unwrap()["requests"][0]["params"]["turnId"] = json!("old");
        assert!(state.questions().is_empty());
    }
}
