//! Trusted-host entry point. Browser authentication is performed by the Electron HTTP host;
//! this layer independently restricts operations, source identity and control freshness.
use super::*;
use agentkib_remote::Source;

pub(super) struct Worker {
    sender: Option<mpsc::SyncSender<RpcRequest>>,
    pending: Arc<AtomicU64>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new(events: Sender<RuntimeEvent>) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<RpcRequest>(32);
        let pending = Arc::new(AtomicU64::new(0));
        let finished = pending.clone();
        let handle = std::thread::spawn(move || {
            let mut service = Service::default();
            while let Ok(request) = receiver.recv() {
                let result = service.request(request.params);
                finished.fetch_sub(1, Ordering::SeqCst);
                let _ = events.send(RuntimeEvent::RemoteFinished {
                    request_id: request.id,
                    result: Box::new(result),
                });
            }
        });
        Self {
            sender: Some(sender),
            pending,
            handle: Some(handle),
        }
    }
    pub fn submit(&self, request: RpcRequest) -> Option<RpcResponse> {
        let id = request.id.clone();
        // Opening a page starts history, live and SSE reads together. Bound and serialize
        // those reads; mutations must still acquire an entirely idle worker, never queue.
        let read = matches!(
            request.params["operation"].as_str(),
            Some("catalog" | "events" | "live")
        );
        let claimed = self
            .pending
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                if (read && n < 32) || n == 0 {
                    Some(n + 1)
                } else {
                    None
                }
            });
        if claimed.is_err() {
            return Some(RpcResponse::error(id, -32000, "web-busy", None));
        }
        if self
            .sender
            .as_ref()
            .is_none_or(|sender| sender.try_send(request).is_err())
        {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return Some(RpcResponse::error(id, -32000, "web-unavailable", None));
        }
        None
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    session_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    request_id: Option<String>,
    expected_revision: Option<u64>,
    runtime_boot_id: Option<String>,
    text: Option<String>,
    turn_id: Option<String>,
    approval_id: Option<Value>,
    question_id: Option<Value>,
    answers: Option<Value>,
    decision: Option<String>,
    #[serde(default)]
    experimental_enabled: bool,
}
struct Service {
    boot: String,
    used: BTreeSet<String>,
    // Independent of the bridge cache: reconnect/eviction must not turn a lost
    // control acknowledgement into permission to submit a second operation.
    unresolved: BTreeSet<String>,
    claude: BTreeMap<String, crate::claude_runner::Runner>,
    claude_identity: BTreeMap<String, (PathBuf, String)>,
    claude_available: Option<bool>,
    #[cfg(target_os = "macos")]
    bridges: BTreeMap<String, agentkib_codex_bridge::Bridge>,
    #[cfg(target_os = "macos")]
    recency: Vec<String>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            boot: uuid::Uuid::new_v4().to_string(),
            used: BTreeSet::new(),
            unresolved: BTreeSet::new(),
            claude: BTreeMap::new(),
            claude_identity: BTreeMap::new(),
            claude_available: None,
            #[cfg(target_os = "macos")]
            bridges: BTreeMap::new(),
            #[cfg(target_os = "macos")]
            recency: Vec::new(),
        }
    }
}
impl Service {
    fn request(&mut self, value: Value) -> anyhow::Result<Value> {
        let request: Request = serde_json::from_value(value)?;
        // Reject known-invalid input before claiming a request or installing a
        // control fence. The bridge shares this exact UTF-8 byte validation.
        if request.operation == "send" {
            agentkib_codex_bridge::validate_send_text(
                request.text.as_deref().context("missing-text")?,
            )?;
        }
        anyhow::ensure!(
            matches!(
                request.operation.as_str(),
                "catalog" | "events" | "live" | "send" | "approve" | "answer"
            ),
            "web-operation-unsupported"
        );
        let source = RemoteSessionSource {
            data_dir: agentkib_store::default_data_dir()?,
        };
        if request.operation == "catalog" {
            return web_catalog(&source);
        }
        let epoch = source.availability_epoch()?;
        let id = request
            .session_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("invalid-session")?;
        if request.operation == "events" {
            return source.events(id, request.cursor.as_deref(), request.limit.unwrap_or(50));
        }
        // Validate registry even for live state; no caller-supplied filesystem or native UUID.
        let store = Store::open_default()?;
        let session = store
            .get_conversation_session(id)?
            .context("session-unavailable")?;
        let workspace = store.workspace_path(&session.workspace_id)?;
        if self.unresolved.contains(id) {
            anyhow::ensure!(request.operation == "live", "control-outcome-unconfirmed");
            return Ok(json!({"sessionId":id,"runtimeBootId":self.boot,
                "status":"outcome-unknown","revision":null,"turnId":null,
                "sendEnabled":false,"approvals":[],"reason":"control-outcome-unconfirmed"}));
        }
        if request.operation != "live" {
            self.claim(&request)?;
        }
        if session.agent == AgentKind::ClaudeCode {
            if !cfg!(target_os = "macos") {
                return self.unsupported(&request, "platform-unsupported");
            }
            if !*self
                .claude_available
                .get_or_insert_with(crate::claude_runner::Runner::installation_supported)
            {
                return self.unsupported(&request, "unverified-installation");
            }
            let adapter = provider(session.agent).context("provider-unavailable")?;
            let native = adapter
                .list_sessions(&workspace)?
                .into_iter()
                .find(|candidate| {
                    store
                        .conversation_id(session.agent, &candidate.native_ref)
                        .is_ok_and(|found| found == id)
                })
                .context("session-unavailable")?;
            let uuid = adapter
                .verified_control_id(&native.native_ref)?
                .context("unverified-session-identity")?;
            let cwd = adapter
                .verified_control_workspace(&native.native_ref)?
                .context("unverified-session-workspace")?;
            anyhow::ensure!(
                cwd.starts_with(fs::canonicalize(&workspace)?),
                "session-workspace-mismatch"
            );
            if let Some(previous) = self.claude_identity.get(id) {
                anyhow::ensure!(
                    previous == &(cwd.clone(), uuid.clone()),
                    "session-identity-changed"
                );
            }
            if request.operation == "live" && !self.claude.contains_key(id) {
                validate_session_access(&source, epoch, &store, &session, &workspace)?;
                return Ok(json!({"sessionId":id,"runtimeBootId":self.boot,
                    "executionMode":"managed-resume","status":"idle","revision":0,
                    "turnId":null,"approvals":[],"streamText":"",
                    "sendEnabled":request.experimental_enabled}));
            }
            if !self.claude.contains_key(id) {
                anyhow::ensure!(self.claude.len() < 8, "managed-session-limit");
                self.claude_identity
                    .insert(id.to_owned(), (cwd.clone(), uuid.clone()));
                self.claude
                    .insert(id.to_owned(), crate::claude_runner::Runner::new(cwd, uuid));
            }
            let runner = self
                .claude
                .get_mut(id)
                .context("managed-session-unavailable")?;
            validate_session_access(&source, epoch, &store, &session, &workspace)?;
            if request.operation == "live" {
                let mut state = runner.snapshot();
                state["executionMode"] = json!("managed-resume");
                state["sessionId"] = json!(id);
                state["runtimeBootId"] = json!(self.boot);
                if !request.experimental_enabled {
                    state["sendEnabled"] = json!(false);
                    if let Some(questions) = state["questions"].as_array_mut() {
                        for question in questions {
                            question["supported"] = json!(false);
                        }
                    }
                    if let Some(approvals) = state["approvals"].as_array_mut() {
                        for approval in approvals {
                            approval["supported"] = json!(false);
                        }
                    }
                }
                return Ok(state);
            }
            let revision = request.expected_revision.context("missing-revision")?;
            // Runner errors are preflight/enqueue failures. After acceptance,
            // asynchronous write errors remain fenced in the runner snapshot.
            let outcome = if request.operation == "send" {
                runner.send(request.text.as_deref().context("missing-text")?, revision)
            } else if request.operation == "answer" {
                runner.answer(
                    request.question_id.as_ref().context("missing-question")?,
                    request.turn_id.as_deref().context("missing-turn")?,
                    request.answers.as_ref().context("missing-answers")?,
                    revision,
                )
            } else {
                runner.approve(
                    request.approval_id.as_ref().context("missing-approval")?,
                    request.turn_id.as_deref().context("missing-turn")?,
                    request.decision.as_deref().context("missing-decision")?,
                    revision,
                )
            };
            return control_response(&request, &self.boot, outcome.is_ok(), outcome);
        }
        #[cfg(target_os = "macos")]
        {
            let mut dispatched = false;
            let outcome = (|| -> anyhow::Result<Value> {
                if session.agent != AgentKind::Codex {
                    return self.unsupported(&request, "provider-unsupported");
                }
                let native = provider(session.agent)
                    .context("provider-unavailable")?
                    .list_sessions(&workspace)?
                    .into_iter()
                    .find(|candidate| {
                        store
                            .conversation_id(session.agent, &candidate.native_ref)
                            .is_ok_and(|found| found == id)
                    })
                    .context("session-unavailable")?;
                let uuid = match provider(session.agent)
                    .context("provider-unavailable")?
                    .verified_control_id(&native.native_ref)
                {
                    Ok(Some(id)) => id,
                    _ => return self.unsupported(&request, "unverified-session-identity"),
                };
                if !self.bridges.contains_key(id) {
                    if self.bridges.len() >= 8 {
                        // Revalidate a cached idle snapshot before eviction. Never discard a running,
                        // pending-approval or unresolved-outcome bridge to make room for another tab.
                        let candidates = idle_candidates(
                            &self.recency,
                            self.bridges.iter().map(|(id, bridge)| {
                                (
                                    id.as_str(),
                                    bridge.state().is_some_and(|state| {
                                        state.status() == agentkib_codex_bridge::Status::Idle
                                            && state.approvals().is_empty()
                                    }),
                                )
                            }),
                        );
                        let mut removed = false;
                        for candidate in candidates {
                            let Some(bridge) = self.bridges.get_mut(&candidate) else {
                                continue;
                            };
                            if bridge.refresh().is_ok()
                                && bridge.state().is_some_and(|state| {
                                    state.status() == agentkib_codex_bridge::Status::Idle
                                        && state.approvals().is_empty()
                                })
                            {
                                self.bridges.remove(&candidate);
                                self.recency.retain(|id| id != &candidate);
                                removed = true;
                                break;
                            }
                        }
                        if !removed {
                            return self.unsupported(&request, "live-session-busy");
                        }
                    }
                    let home = dirs::home_dir().context("home-unavailable")?;
                    let compatibility = agentkib_codex_bridge::Compatibility::inspect(
                        Path::new("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
                        &home.join(format!(
                            ".vscode/extensions/openai.chatgpt-{}-darwin-arm64/package.json",
                            agentkib_codex_bridge::EXTENSION_VERSION
                        )),
                    );
                    if !compatibility.is_known() {
                        return self.unsupported(&request, "unverified-installation");
                    }
                    let connected = agentkib_codex_bridge::Bridge::connect(
                        &home.join(".codex/ipc/ipc.sock"),
                        compatibility,
                    )
                    .and_then(|mut bridge| {
                        bridge.select(&uuid)?;
                        Ok(bridge)
                    });
                    match connected {
                        Ok(bridge) => {
                            self.bridges.insert(id.into(), bridge);
                        }
                        Err(_) => return self.unsupported(&request, "open-in-original-client"),
                    }
                }
                self.recency.retain(|entry| entry != id);
                self.recency.push(id.into());
                let bridge = self.bridges.get_mut(id).context("live-unavailable")?;
                if bridge
                    .state()
                    .is_none_or(|state| state.conversation_id() != uuid)
                {
                    self.bridges.remove(id);
                    self.recency.retain(|entry| entry != id);
                    return self.unsupported(&request, "session-identity-changed");
                }
                if bridge.refresh().is_err() {
                    self.bridges.remove(id);
                    self.recency.retain(|entry| entry != id);
                    return self.unsupported(&request, "open-in-original-client");
                }
                let controls = request.experimental_enabled && bridge.enable_controls().is_ok();
                if !controls {
                    bridge.disable_controls();
                }
                let state = bridge.state().context("state-unavailable")?;
                if request.operation == "live" {
                    let questions: Vec<_> = state
                        .questions()
                        .into_iter()
                        .map(|mut q| {
                            if !controls {
                                q["supported"] = json!(false);
                            }
                            q
                        })
                        .collect();
                    let approvals: Vec<_> = state
                        .approvals()
                        .into_iter()
                        .map(|approval| safe_approval(approval, controls))
                        .collect();
                    let status = if !questions.is_empty() {
                        json!("waiting-input")
                    } else {
                        json!(state.status())
                    };
                    validate_session_access(&source, epoch, &store, &session, &workspace)?;
                    return Ok(
                        json!({"sessionId":id,"runtimeBootId":self.boot,"status":status,"revision":state.revision(),"turnId":state.active_turn(),"sendEnabled":controls && state.status()==agentkib_codex_bridge::Status::Idle,"approvals":approvals,"questions":questions}),
                    );
                }
                anyhow::ensure!(
                    controls
                        && request.expected_revision.is_some()
                        && request.expected_revision == state.revision(),
                    "stale-or-disabled-control"
                );
                let authorize =
                    || validate_session_access(&source, epoch, &store, &session, &workspace);
                let dispatch = || {
                    dispatched = true;
                    self.unresolved.insert(id.to_owned());
                };
                let outcome = if request.operation == "send" {
                    let text = request.text.as_deref().context("missing-text")?;
                    bridge.send_text_at_revision_with_authorization(
                        text,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else if request.operation == "answer" {
                    bridge.answer_at_revision_with_authorization(
                        request.question_id.as_ref().context("missing-question")?,
                        request.turn_id.as_deref().context("missing-turn")?,
                        request.answers.as_ref().context("missing-answers")?,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else {
                    let approval_id = request.approval_id.as_ref().context("missing-approval")?;
                    let turn = request.turn_id.as_deref().context("missing-turn")?;
                    let approval = state
                        .approvals()
                        .into_iter()
                        .find(|a| &a.request_id == approval_id && a.turn_id == turn)
                        .context("approval-no-longer-pending")?;
                    let safe = safe_approval(approval, controls);
                    let decision = request.decision.as_deref().context("missing-decision")?;
                    anyhow::ensure!(
                        safe["supported"] == true
                            && safe["availableDecisions"]
                                .as_array()
                                .is_some_and(|list| list.contains(&json!(decision))),
                        "unsupported-approval"
                    );
                    let decision = match decision {
                        "accept" => agentkib_codex_bridge::Decision::Accept,
                        "decline" => agentkib_codex_bridge::Decision::Decline,
                        "cancel" => agentkib_codex_bridge::Decision::Cancel,
                        _ => anyhow::bail!("unsupported-decision"),
                    };
                    bridge.approve_at_revision_with_authorization(
                        approval_id,
                        turn,
                        decision,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                };
                // Only a matching acknowledgement clears a dispatched operation.
                // Final bridge preflight errors never installed the fence.
                if outcome.is_ok() {
                    self.unresolved.remove(id);
                }
                control_response(&request, &self.boot, dispatched, outcome)
            })();
            match outcome {
                Err(error) if request.operation != "live" && !dispatched => {
                    control_response(&request, &self.boot, false, Err(error))
                }
                result => result,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace, session, epoch);
            self.unsupported(&request, "platform-unsupported")
        }
    }
    fn claim(&mut self, request: &Request) -> anyhow::Result<()> {
        anyhow::ensure!(
            request
                .session_id
                .as_ref()
                .is_none_or(|id| !self.unresolved.contains(id)),
            "control-outcome-unconfirmed"
        );
        anyhow::ensure!(
            request.experimental_enabled && request.runtime_boot_id.as_deref() == Some(&self.boot),
            "stale-or-disabled-control"
        );
        let id = request
            .request_id
            .as_ref()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .context("invalid-request-id")?;
        anyhow::ensure!(
            self.used.len() < 10_000 && self.used.insert(id.clone()),
            "duplicate-or-exhausted-request"
        );
        Ok(())
    }
    fn unsupported(&self, request: &Request, reason: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(request.operation == "live", "control-unavailable");
        Ok(
            json!({"sessionId":request.session_id,"runtimeBootId":self.boot,"status":"unsupported","revision":null,"turnId":null,"sendEnabled":false,"approvals":[],"reason":reason}),
        )
    }
}

// The browser needs project identity, not the native peer's richer workspace
// summary. Project only this whitelist from the same snapshot as the sessions.
fn web_catalog(source: &impl Source) -> anyhow::Result<Value> {
    if source.ensure_available().is_err() {
        return Ok(json!({"workspaces":[],"sessions":[],"indexEnabled":false}));
    }
    let snapshot = source.catalog()?;
    let workspaces = snapshot["workspaces"]
        .as_array()
        .context("invalid-catalog-workspaces")?
        .iter()
        .map(|workspace| {
            json!({"id":workspace["id"],"name":workspace["name"],"path":workspace["path"]})
        })
        .collect::<Vec<_>>();
    Ok(json!({"workspaces":workspaces,"sessions":snapshot["sessions"],"indexEnabled":true}))
}

fn validate_session_access(
    source: &RemoteSessionSource,
    epoch: u64,
    store: &Store,
    session: &agentkib_conversations::ConversationSessionSummary,
    workspace: &Path,
) -> anyhow::Result<()> {
    // Owner discovery/refresh can block while the main runtime handles index or
    // workspace changes. Recheck after that wait, not only at request admission.
    source.ensure_enabled(epoch)?;
    let current = store
        .get_conversation_session(&session.id)?
        .context("session-unavailable")?;
    anyhow::ensure!(
        current.workspace_id == session.workspace_id
            && current.agent == session.agent
            && store.workspace_path(&session.workspace_id)? == workspace,
        "session-unavailable"
    );
    Ok(())
}

fn control_response(
    request: &Request,
    boot: &str,
    dispatched: bool,
    outcome: anyhow::Result<()>,
) -> anyhow::Result<Value> {
    if outcome.is_err() && !dispatched {
        return Ok(json!({"accepted":false,"completed":false,
            "controlOutcome":"not-dispatched","error":"control_preflight_rejected",
            "requestId":request.request_id,"runtimeBootId":boot}));
    }
    outcome?;
    Ok(
        json!({"accepted":true,"completed":false,"requestId":request.request_id,"runtimeBootId":boot}),
    )
}

#[cfg(any(target_os = "macos", test))]
fn idle_candidates<'a>(
    recency: &[String],
    states: impl Iterator<Item = (&'a str, bool)>,
) -> Vec<String> {
    let idle: BTreeSet<_> = states.filter_map(|(id, idle)| idle.then_some(id)).collect();
    recency
        .iter()
        .filter(|id| idle.contains(id.as_str()))
        .cloned()
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn safe_approval(approval: agentkib_codex_bridge::Approval, controls: bool) -> Value {
    let details = approval.details;
    let command_request = approval.method == "item/commandExecution/requestApproval";
    // Pinned official schema: omitted kind means command, not terminal input.
    // A proposal is not an authorization; only one-shot decisions are exposed.
    let valid_metadata = !command_request
        || (details.get("kind").is_none_or(|v| v == "command")
            && details
                .get("startedAtMs")
                .is_none_or(|v| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
            // codex rust-v0.153.4 reserves `local` for LocalProcess and rejects
            // remote environment registration under this ID (see QA source).
            && details.get("environmentId").is_none_or(|v| v.is_null() || v == "local")
            && details.get("proposedExecpolicyAmendment").is_none_or(|v| {
                v.is_null()
                    || v.as_array().is_some_and(|items| {
                        !items.is_empty()
                            && items.len() <= 100
                            && items.iter().all(|item| {
                                item.as_str().is_some_and(|s| {
                                    !s.is_empty() && s.len() <= 4096 && !s.contains('\0')
                                })
                            })
                    })
            }));
    let complete = match approval.method.as_str() {
        "item/commandExecution/requestApproval" => {
            details["command"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty() && v.len() <= 16 * 1024 && !v.contains('\0'))
                && details["cwd"]
                    .as_str()
                    .is_some_and(|v| Path::new(v).is_absolute())
        }
        "item/fileChange/requestApproval" => details["changes"].as_array().is_some_and(|changes| {
            !changes.is_empty() && changes.len() <= 100 && changes.iter().all(complete_file_change)
        }),
        _ => false,
    };
    let valid_decisions = details
        .get("availableDecisions")
        .is_none_or(|value| value.is_null() || value.is_array());
    let unknown_metadata: Vec<_> = details.as_object().into_iter().flat_map(|object| object.iter())
        .filter(|(key, value)| !(value.is_null() || matches!(key.as_str(),
            "threadId"|"turnId"|"itemId"|"approvalId"|"command"|"cwd"|"reason"|"commandActions"|"changes"|"availableDecisions")
            || (command_request && matches!(key.as_str(), "kind"|"startedAtMs"|"environmentId"|"proposedExecpolicyAmendment"))))
        .take(32)
        .map(|(key, value)| json!({"field":key.chars().take(80).collect::<String>(),"type":match value {
            Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number",
            Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object"
        }})).collect();
    let supported = valid_decisions
        && valid_metadata
        && (approval.request_id.is_string() || approval.request_id.is_number())
        && controls
        && complete
        // Version-pinned allowlist: unknown non-null metadata may carry a new permission
        // request or an omitted scope. Never silently hide it while enabling approval.
        && details.is_object() && unknown_metadata.is_empty()
        && [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
        ]
        .iter()
        .all(|key| details.get(key).is_none_or(Value::is_null));
    // Null decisions use the version-pinned protocol's standard decisions; unknown entries never escape.
    let offered = details["availableDecisions"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!("accept"), json!("decline"), json!("cancel")]);
    let decisions: Vec<_> = offered
        .into_iter()
        .filter(|v| matches!(v.as_str(), Some("accept" | "decline" | "cancel")))
        .collect();
    let supported = supported && !decisions.is_empty();
    let unsupported_reason = if supported {
        None
    } else if !controls {
        Some("control-disabled")
    } else if !complete {
        Some("incomplete-operation-details")
    } else if !unknown_metadata.is_empty() {
        Some("unsupported-metadata")
    } else {
        Some("unsupported-approval-contract")
    };
    // Diagnostic structure only; never expose unknown permission values or log
    // the raw owner request. It does not grant a new decision or permission.
    json!({"requestId":approval.request_id,"turnId":approval.turn_id,"method":approval.method,"command":details["command"],"cwd":details["cwd"],"changes":details["changes"],"availableDecisions":if supported { decisions } else {vec![]},"supported":supported,
        "unsupportedReason":unsupported_reason,"unsupportedMetadata":unknown_metadata,
        "proposedExecpolicyAmendment":if command_request && valid_metadata {details["proposedExecpolicyAmendment"].clone()} else {Value::Null},
        "environmentId":if command_request && valid_metadata {details["environmentId"].clone()} else {Value::Null}})
}

#[cfg(any(target_os = "macos", test))]
fn complete_file_change(change: &Value) -> bool {
    let Some(object) = change.as_object() else {
        return false;
    };
    // Summary-only entries (path/kind but no actual diff) are not approvable.
    object
        .keys()
        .all(|key| matches!(key.as_str(), "path" | "kind" | "diff"))
        && change["path"]
            .as_str()
            .is_some_and(|path| !path.contains('\0') && Path::new(path).is_absolute())
        && change["diff"]
            .as_str()
            .is_some_and(|diff| diff.len() <= 256 * 1024 && !diff.contains('\0'))
        && change["kind"].as_object().is_some_and(|kind| {
            kind.keys()
                .all(|key| matches!(key.as_str(), "type" | "movePath"))
                && matches!(
                    change["kind"]["type"].as_str(),
                    Some("add" | "update" | "delete")
                )
                && change["kind"].get("movePath").is_none_or(|path| {
                    path.is_null()
                        || path
                            .as_str()
                            .is_some_and(|path| Path::new(path).is_absolute())
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_catalog_projects_one_snapshot_and_only_browser_workspace_fields() {
        struct Snapshot;
        impl Source for Snapshot {
            fn catalog(&self) -> anyhow::Result<Value> {
                Ok(
                    json!({"workspaces":[{"id":"w","name":"test","path":"/projects/test",
                    "discovery_sources":["private"],"status":"active","asset_count":9}],
                    "sessions":[{"id":"s","workspace_id":"w","origin":"auxiliary",
                    "forked_from_session_id":"parent","spawned_by_session_id":null,
                    "created_at":"2026-09-09T00:00:00Z","git_branch":"main"}]}),
                )
            }
            fn events(&self, _: &str, _: Option<&str>, _: usize) -> anyhow::Result<Value> {
                panic!("catalog must not read individual histories")
            }
        }
        let result = web_catalog(&Snapshot).unwrap();
        assert_eq!(result["indexEnabled"], true);
        assert_eq!(
            result["workspaces"],
            json!([{"id":"w","name":"test","path":"/projects/test"}])
        );
        assert_eq!(result["sessions"], Snapshot.catalog().unwrap()["sessions"]);
    }

    #[test]
    fn web_catalog_disabled_index_returns_no_workspaces_or_sessions() {
        struct Disabled;
        impl Source for Disabled {
            fn ensure_available(&self) -> anyhow::Result<()> {
                anyhow::bail!("index-disabled")
            }
            fn catalog(&self) -> anyhow::Result<Value> {
                panic!("disabled catalog must not read the source")
            }
            fn events(&self, _: &str, _: Option<&str>, _: usize) -> anyhow::Result<Value> {
                panic!("disabled catalog must not read histories")
            }
        }
        assert_eq!(
            web_catalog(&Disabled).unwrap(),
            json!({"workspaces":[],"sessions":[],"indexEnabled":false})
        );
    }

    #[test]
    fn final_session_access_rejects_index_and_registry_changes() {
        use agentkib_conversations::{NativeSessionSummary, SessionAvailability, SessionOrigin};
        for change in ["disable", "epoch", "clear", "exclude"] {
            let directory = tempfile::tempdir().unwrap();
            let source = RemoteSessionSource {
                data_dir: directory.path().into(),
            };
            let store = Store::open(&directory.path().join("agentkib.db")).unwrap();
            let workspace = directory.path().join("project");
            fs::create_dir(&workspace).unwrap();
            let registered = store.add_workspace(&workspace).unwrap();
            // Match request admission: Store strips Windows verbatim prefixes,
            // unlike std::fs::canonicalize, so use its persisted path here too.
            let workspace = store.workspace_path(&registered.id).unwrap();
            let session = store
                .sync_conversation_sessions(
                    &registered.id,
                    AgentKind::Codex,
                    &[NativeSessionSummary {
                        native_ref: "synthetic".into(),
                        agent: AgentKind::Codex,
                        title: None,
                        origin: SessionOrigin::Unknown,
                        spawned_by_session_id: None,
                        forked_from_session_id: None,
                        created_at: None,
                        updated_at: None,
                        message_count: None,
                        git_branch: None,
                        archived: false,
                        sidechain: false,
                        availability: SessionAvailability::Readable,
                    }],
                )
                .unwrap()
                .remove(0);
            let epoch = source.availability_epoch().unwrap();
            validate_session_access(&source, epoch, &store, &session, &workspace).unwrap();
            // Model the main runtime changing policy while the Web worker awaits
            // an owner response. Use another store connection, as production does.
            let writer = Store::open(&directory.path().join("agentkib.db")).unwrap();
            let checked_epoch = match change {
                "disable" => {
                    fs::write(
                        directory.path().join("preferences.json"),
                        r#"{"session_index_enabled":false}"#,
                    )
                    .unwrap();
                    epoch
                }
                "epoch" => epoch.wrapping_add(1),
                "clear" => {
                    writer.clear_conversation_index(None).unwrap();
                    epoch
                }
                "exclude" => {
                    writer.exclude_workspace(&registered.id).unwrap();
                    epoch
                }
                _ => unreachable!(),
            };
            assert!(
                validate_session_access(&source, checked_epoch, &store, &session, &workspace)
                    .is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn control_preflight_receipt_depends_on_dispatch_not_error_text() {
        for operation in ["send", "approve"] {
            let request: Request = serde_json::from_value(json!({
                "operation":operation, "requestId":"request-1"
            }))
            .unwrap();
            let error = || anyhow::anyhow!("session revision changed; nothing sent");
            let receipt = control_response(&request, "boot-1", false, Err(error())).unwrap();
            assert_eq!(
                receipt,
                json!({"accepted":false,"completed":false,
                "requestId":"request-1","runtimeBootId":"boot-1",
                "controlOutcome":"not-dispatched","error":"control_preflight_rejected"})
            );
            assert!(control_response(&request, "boot-1", true, Err(error())).is_err());
            assert_eq!(
                control_response(&request, "boot-1", true, Ok(())).unwrap()["accepted"],
                true
            );
        }
    }

    #[test]
    fn invalid_send_text_never_claims_or_fences_control() {
        let mut service = Service::default();
        for text in [" ".to_owned(), "中".repeat(6000), "🙂".repeat(4097)] {
            assert!(
                service
                    .request(json!({"operation":"send", "sessionId":"test", "text":text}))
                    .is_err()
            );
            assert!(service.used.is_empty());
            assert!(service.unresolved.is_empty());
        }
        for text in [
            "a".repeat(16384),
            "🙂".repeat(4096),
            format!("{}a", "中".repeat(5461)),
        ] {
            assert!(agentkib_codex_bridge::validate_send_text(&text).is_ok());
        }
    }

    // Projection uses the host's absolute-path semantics, even when control is
    // unavailable on that host. Keep fixtures valid on Windows as well as Unix.
    fn test_cwd() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    fn test_file() -> std::path::PathBuf {
        test_cwd().join("qa.txt")
    }
    fn file_approval(details: Value) -> Value {
        safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/fileChange/requestApproval".into(),
                details,
            },
            true,
        )
    }
    #[test]
    fn file_approval_requires_full_known_change_not_a_path_summary() {
        let good = json!({"changes":[{"path":test_file(),"kind":{"type":"add"},"diff":"QA\n"}]});
        assert_eq!(file_approval(good.clone())["supported"], true);
        for changes in [
            json!([{"path":test_file(),"kind":{"type":"add"}}]),
            json!([{"path":test_file(),"kind":{"type":"add"},"diff":null}]),
            json!([{"path":"qa.txt","kind":{"type":"add"},"diff":"QA"}]),
            json!([{"path":test_file(),"kind":{"type":"unknown"},"diff":"QA"}]),
            json!([{"path":test_file(),"kind":{"type":"add"},"diff":"QA","truncated":true}]),
        ] {
            let projected = file_approval(json!({"changes":changes}));
            assert_eq!(projected["supported"], false);
            assert_eq!(projected["availableDecisions"], json!([]));
        }
        for field in [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
            "proposedExecpolicyAmendment",
            "proposedNetworkPolicyAmendments",
            "unknownPermissionScope",
        ] {
            let mut details = good.clone();
            details[field] = json!({});
            assert_eq!(file_approval(details)["supported"], false, "{field}");
        }
    }

    #[test]
    fn unsupported_approval_diagnostics_never_expose_unknown_values_or_enable_decisions() {
        let projected = safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(34),
                turn_id: "turn".into(),
                method: "item/commandExecution/requestApproval".into(),
                details: json!({"command":"/usr/bin/true","cwd":test_cwd(),
                "unknownPermissionScope":["private-proposal-value"]}),
            },
            true,
        );
        assert_eq!(projected["supported"], false);
        assert_eq!(projected["availableDecisions"], json!([]));
        assert_eq!(projected["unsupportedReason"], "unsupported-metadata");
        assert_eq!(
            projected["unsupportedMetadata"],
            json!([{"field":"unknownPermissionScope","type":"array"}])
        );
        assert!(!projected.to_string().contains("private-proposal-value"));
    }
    #[test]
    fn command_metadata_is_typed_and_never_grants_persistent_rules() {
        let mut approval = agentkib_codex_bridge::Approval {
            request_id: json!(42),
            turn_id: "turn".into(),
            method: "item/commandExecution/requestApproval".into(),
            details: json!({"command":"/usr/bin/true","cwd":test_cwd(),"kind":"command","environmentId":"local",
                "startedAtMs":1770000000000_u64,"proposedExecpolicyAmendment":["/usr/bin/true"],
                "availableDecisions":["accept","acceptForSession",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["/usr/bin/true"]}},"decline"]}),
        };
        let good = safe_approval(approval.clone(), true);
        assert_eq!(good["supported"], true);
        assert_eq!(good["availableDecisions"], json!(["accept", "decline"]));
        assert_eq!(good["environmentId"], "local");
        assert_eq!(
            good["proposedExecpolicyAmendment"],
            json!(["/usr/bin/true"])
        );
        for (field, value) in [
            ("kind", json!("writeStdin")),
            ("kind", json!("unknown")),
            ("kind", Value::Null),
            ("startedAtMs", json!(-1)),
            ("startedAtMs", json!(1.5)),
            ("startedAtMs", json!("123")),
            ("startedAtMs", json!(9_007_199_254_740_992_u64)),
            ("environmentId", json!("unverified-environment")),
            ("proposedExecpolicyAmendment", json!([1])),
            ("proposedExecpolicyAmendment", json!({})),
            ("proposedExecpolicyAmendment", json!(["bad\0value"])),
            ("additionalPermissions", json!({})),
            ("proposedNetworkPolicyAmendments", json!([])),
        ] {
            let mut invalid = approval.clone();
            invalid.details[field] = value;
            let result = safe_approval(invalid, true);
            assert_eq!(result["supported"], false, "{field}");
            assert_eq!(result["availableDecisions"], json!([]), "{field}");
        }
        approval.details.as_object_mut().unwrap().remove("kind");
        approval
            .details
            .as_object_mut()
            .unwrap()
            .remove("startedAtMs");
        assert_eq!(safe_approval(approval, true)["supported"], true);
    }
    #[test]
    fn command_approval_requires_visible_working_directory_and_complete_scope() {
        let mut approval = agentkib_codex_bridge::Approval {
            request_id: json!(1),
            turn_id: "turn".into(),
            method: "item/commandExecution/requestApproval".into(),
            details: json!({"command":"/usr/bin/true","cwd":test_cwd()}),
        };
        assert_eq!(safe_approval(approval.clone(), true)["supported"], true);
        approval.details["cwd"] = Value::Null;
        assert_eq!(safe_approval(approval, true)["supported"], false);
    }
    #[test]
    fn eviction_is_lru_and_never_selects_busy_approval_or_unknown_entries() {
        let recency = vec![
            "old-running".into(),
            "old-idle".into(),
            "pending".into(),
            "unknown".into(),
            "new-idle".into(),
        ];
        let states = vec![
            ("new-idle", true),
            ("pending", false),
            ("old-idle", true),
            ("unknown", false),
            ("old-running", false),
        ];
        assert_eq!(
            idle_candidates(&recency, states.into_iter()),
            vec!["old-idle", "new-idle"]
        );
        assert!(idle_candidates(&recency, [("pending", false)].into_iter()).is_empty());
    }
    #[test]
    fn restart_does_not_accept_pre_restart_control_and_eviction_cannot_reset_dedup() {
        let mut before = Service::default();
        let request:Request=serde_json::from_value(json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":before.boot,"requestId":uuid::Uuid::new_v4().to_string()})).unwrap();
        before.claim(&request).unwrap();
        // Bridge cache lifecycle deliberately has no relationship to the operation journal.
        #[cfg(target_os = "macos")]
        {
            before.bridges.clear();
            before.recency.clear();
        }
        assert!(before.claim(&request).is_err());
        assert!(Service::default().claim(&request).is_err());
    }
    #[test]
    fn worker_rejects_busy_without_queuing_control() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(1)),
            handle: None,
        };
        let request: RpcRequest = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":1,"method":"web.request","params":{"operation":"send"}}),
        )
        .unwrap();
        assert!(worker.submit(request).unwrap().error.is_some());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn uncertain_control_fence_survives_bridge_eviction_and_new_request_ids() {
        let mut service = Service::default();
        service.unresolved.insert("session-a".into());
        #[cfg(target_os = "macos")]
        {
            service.bridges.clear();
            service.recency.clear();
        }
        for operation in ["send", "approve"] {
            let request: Request = serde_json::from_value(json!({
                "operation":operation,"sessionId":"session-a","experimentalEnabled":true,
                "runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()
            }))
            .unwrap();
            assert!(
                service
                    .claim(&request)
                    .unwrap_err()
                    .to_string()
                    .contains("outcome-unconfirmed")
            );
        }
        let other: Request = serde_json::from_value(json!({
            "operation":"send","sessionId":"session-b","experimentalEnabled":true,
            "runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()
        }))
        .unwrap();
        service.claim(&other).unwrap();
        assert!(
            Service::default().claim(&other).is_err(),
            "restart must reject the old boot"
        );
    }
    #[test]
    fn worker_serializes_page_reads_with_a_bounded_queue() {
        let (sender, receiver) = mpsc::sync_channel(32);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(0)),
            handle: None,
        };
        for id in 0..32 {
            let operation = ["events", "live", "catalog"][id % 3];
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":id,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).is_none());
        }
        for operation in ["live", "send", "approve"] {
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":33,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).unwrap().error.is_some());
        }
        for id in 0..32 {
            assert_eq!(receiver.try_recv().unwrap().id, json!(id));
        }
        assert_eq!(worker.pending.load(Ordering::SeqCst), 32);
    }
    #[test]
    fn rejects_arbitrary_fields_and_stale_replays() {
        assert!(
            serde_json::from_value::<Request>(json!({"operation":"send","path":"/tmp"})).is_err()
        );
        let mut service = Service::default();
        let mut value = json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()});
        let request: Request = serde_json::from_value(value.clone()).unwrap();
        assert!(service.claim(&request).is_ok());
        assert!(service.claim(&request).is_err());
        value["runtimeBootId"] = json!("old");
        assert!(
            service
                .claim(&serde_json::from_value(value).unwrap())
                .is_err()
        );
    }
    #[test]
    fn unsupported_permissions_never_offer_decisions() {
        let value = safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/commandExecution/requestApproval".into(),
                details: json!({"command":"true","additionalPermissions":{}}),
            },
            true,
        );
        assert_eq!(value["supported"], false);
        assert_eq!(value["availableDecisions"], json!([]));
    }
}
