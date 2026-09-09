use crate::{Compatibility, Connection, Decision, SessionState, Status};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Opt-in, local-only facade. IDs/commands supplied by a caller are not forwarded verbatim.
pub struct Bridge {
    connection: Connection,
    compatibility: Compatibility,
    controls_enabled: bool,
    selected: Option<SessionState>,
    endpoint: PathBuf,
}

impl Bridge {
    pub fn connect(socket: &Path, compatibility: Compatibility) -> Result<Self> {
        Ok(Self {
            connection: Connection::connect(socket)?,
            compatibility,
            controls_enabled: false,
            selected: None,
            endpoint: socket.to_owned(),
        })
    }

    pub fn enable_controls(&mut self) -> Result<()> {
        ensure!(
            self.connection
                .peer_executable()
                .is_some_and(|p| self.compatibility.matches_router(p)),
            "unverified Codex installation or IPC router executable; read-only mode"
        );
        self.controls_enabled = true;
        Ok(())
    }

    pub fn disable_controls(&mut self) {
        self.controls_enabled = false;
    }
    pub fn state(&self) -> Option<&SessionState> {
        self.selected.as_ref()
    }

    pub fn select(&mut self, conversation: &str) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(conversation).is_ok(),
            "select an explicit Codex conversation UUID"
        );
        self.unfollow();
        let response = self.connection.request(
            "thread-owner-discovery",
            json!({"hostId":"local", "conversationId":conversation}),
            None,
            |_| Ok(()),
        )?;
        let owner = response["handledByClientId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("no session owner found")?
            .to_owned();
        ensure!(owner != self.connection.client_id(), "cannot follow self");
        self.selected = Some(SessionState::new(conversation.into(), owner.clone()));
        let result = (|| {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":conversation,"hostId":"local","following":true}),
                &owner,
            )?;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                self.poll(until.saturating_duration_since(Instant::now()))?;
                if self
                    .selected
                    .as_ref()
                    .is_some_and(|s| s.revision().is_some())
                {
                    return Ok(());
                }
            }
            anyhow::bail!("no compatible owner snapshot received; read-only mode");
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        }
        result
    }

    pub fn refresh(&mut self) -> Result<()> {
        let state = self.selected.as_ref().context("no selected session")?;
        let id = state.conversation.clone();
        if state.revision().is_none() {
            return self.select(&id);
        }
        let owner = state.owner.clone();
        let result = (|| {
            // Keep the stream intact: unsubscribe/resubscribe makes the owner
            // publish a new revision even when no conversation state changed.
            let selected = &mut self.selected;
            let response = self.connection.request(
                "thread-owner-discovery",
                json!({"hostId":"local", "conversationId":id}),
                None,
                |message| {
                    selected
                        .as_mut()
                        .context("no selected session")?
                        .notification(message)
                },
            )?;
            ensure!(
                response["handledByClientId"] == owner,
                "session owner changed"
            );
            let state = self.selected.as_ref().context("no selected session")?;
            ensure!(state.revision().is_some(), "session stream invalidated");
            let baseline = state.snapshot_count;
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":id,"hostId":"local","following":true}),
                &owner,
            )?;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                self.poll(until.saturating_duration_since(Instant::now()))?;
                let state = self.selected.as_ref().context("no selected session")?;
                ensure!(state.revision().is_some(), "session stream invalidated");
                if state.snapshot_count > baseline {
                    return Ok(());
                }
            }
            anyhow::bail!("no compatible owner refresh snapshot received");
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        }
        result
    }

    pub fn poll(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout.min(Duration::from_secs(3));
        match self.connection.receive(deadline) {
            Ok(Some(message)) => {
                if let Some(state) = &mut self.selected {
                    if following_status_requested(&message, state) {
                        self.connection.broadcast("thread-stream-following-changed",
                            json!({"conversationId":state.conversation,"hostId":"local","following":true}), &state.owner)?;
                    } else {
                        state.notification(message)?;
                    }
                }
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(error) => {
                self.invalidate(Status::Disconnected);
                Err(error)
            }
        }
    }

    /// A returned receipt means the owner acknowledged the request, NOT turn completion.
    /// The caller must observe subsequent state; errors never imply it is safe to resend.
    pub fn send_text(&mut self, text: &str) -> Result<()> {
        self.send_text_at_revision(text, None)
    }

    pub fn send_text_at_revision(&mut self, text: &str, revision: Option<u64>) -> Result<()> {
        self.send_text_at_revision_with_dispatch(text, revision, || {})
    }

    /// Runs `dispatch` immediately before the first mutation write attempt, while
    /// the operation lock is held. Errors before this callback did not send it.
    pub fn send_text_at_revision_with_dispatch(
        &mut self,
        text: &str,
        revision: Option<u64>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.send_text_at_revision_with_authorization(text, revision, || Ok(()), dispatch)
    }

    /// Rechecks host authorization after owner refresh, immediately before writing.
    /// A rejected authorization does not invoke `dispatch` or send request bytes.
    pub fn send_text_at_revision_with_authorization(
        &mut self,
        text: &str,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        crate::validate_send_text(text)?;
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_none() || revision == state.revision(),
            "session revision changed; nothing sent"
        );
        ensure!(
            state.status() == Status::Idle,
            "session is not idle; sending is disabled"
        );
        let id = state.conversation.clone();
        self.mutate_with_authorization("thread-follower-start-turn", json!({"conversationId":id,
            "turnStart":{"request":{"threadId":id,"input":[{"type":"text","text":text,"text_elements":[]}]}}}), authorize, dispatch).map(|_| ())
    }

    /// Interrupts the selected turn only. Even a matching owner receipt does not
    /// guarantee that tool subprocesses have exited; never remove the turn guard
    /// or retry without it to attempt thread-wide terminal cleanup.
    pub fn stop(&mut self, expected_turn_id: &str) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            state.active_turn() == Some(expected_turn_id),
            "turn changed; stop cancelled"
        );
        let receipt = self.mutate(
            "thread-follower-interrupt-turn",
            json!({"conversationId":state.conversation,
            "mode":"user-stop","expectedTurnId":expected_turn_id}),
        )?;
        validate_interrupt_receipt(&receipt, expected_turn_id)
    }

    pub fn approve(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
    ) -> Result<()> {
        self.approve_at_revision(request_id, expected_turn_id, decision, None)
    }

    pub fn approve_at_revision(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
    ) -> Result<()> {
        self.approve_at_revision_with_dispatch(
            request_id,
            expected_turn_id,
            decision,
            revision,
            || {},
        )
    }

    /// Like sending, final owner refresh and approval checks precede `dispatch`.
    pub fn approve_at_revision_with_dispatch(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.approve_at_revision_with_authorization(
            request_id,
            expected_turn_id,
            decision,
            revision,
            || Ok(()),
            dispatch,
        )
    }

    /// Rechecks host authorization after the final approval/owner checks.
    pub fn approve_at_revision_with_authorization(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_none() || revision == state.revision(),
            "session revision changed; nothing sent"
        );
        let approval = state
            .approvals()
            .into_iter()
            .find(|a| &a.request_id == request_id && a.turn_id == expected_turn_id)
            .context("approval no longer pending; nothing sent")?;
        if matches!(decision, Decision::Accept) {
            ensure!(
                match approval.method.as_str() {
                    "item/commandExecution/requestApproval" =>
                        approval.details["command"]
                            .as_str()
                            .is_some_and(|c| !c.is_empty())
                            && approval
                                .details
                                .get("networkApprovalContext")
                                .is_none_or(Value::is_null)
                            && approval
                                .details
                                .get("additionalPermissions")
                                .is_none_or(Value::is_null),
                    "item/fileChange/requestApproval" =>
                        approval.details["changes"]
                            .as_array()
                            .is_some_and(|c| !c.is_empty())
                            && approval.details.get("grantRoot").is_none_or(Value::is_null),
                    _ => false,
                },
                "approval details are incomplete or unsupported; handle in the original client"
            );
        }
        if let Some(available) = approval
            .details
            .get("availableDecisions")
            .filter(|v| !v.is_null())
        {
            ensure!(
                available
                    .as_array()
                    .is_some_and(|items| items.contains(&json!(decision))),
                "decision not offered by owner"
            );
        }
        let method = match approval.method.as_str() {
            "item/commandExecution/requestApproval" => "thread-follower-command-approval-decision",
            "item/fileChange/requestApproval" => "thread-follower-file-approval-decision",
            _ => anyhow::bail!("please handle this request in the original client"),
        };
        self.mutate_with_authorization(
            method,
            json!({"conversationId":state.conversation,"requestId":request_id,"decision":decision}),
            authorize,
            dispatch,
        )
        .map(|_| ())
    }

    pub fn answer_at_revision_with_authorization(
        &mut self,
        id: &Value,
        turn: &str,
        answers: &Value,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_some() && revision == state.revision(),
            "stale question revision"
        );
        let pending = state
            .questions()
            .into_iter()
            .find(|q| &q["requestId"] == id && q["turnId"] == turn && q["supported"] == true)
            .context("question no longer pending or unsupported")?;
        let rows = pending["questions"]
            .as_array()
            .context("invalid questions")?;
        let map = answers.as_object().context("invalid answers")?;
        ensure!(map.len() == rows.len(), "answer keys mismatch");
        let mut response = serde_json::Map::new();
        for row in rows {
            let key = row["id"].as_str().context("invalid question id")?;
            let values = map
                .get(key)
                .and_then(Value::as_array)
                .context("missing answer")?;
            ensure!(values.len() == 1, "invalid answer cardinality");
            let text = values[0]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
                .context("invalid answer")?;
            ensure!(
                row["allowCustom"] == true
                    || row["options"]
                        .as_array()
                        .is_some_and(|opts| opts.iter().any(|o| o["label"] == text)),
                "answer not offered"
            );
            response.insert(key.to_owned(), json!({"answers":values}));
        }
        self.mutate_with_authorization("thread-follower-submit-user-input", json!({"conversationId":state.conversation,"requestId":id,"response":{"answers":response}}), authorize, dispatch).map(|_| ())
    }

    fn ready(&self) -> Result<()> {
        ensure!(
            self.controls_enabled && self.compatibility.is_known(),
            "experimental controls are disabled"
        );
        ensure!(self.connection.is_connected(), "IPC disconnected");
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            matches!(
                state.status(),
                Status::Idle | Status::Running | Status::AwaitingApproval
            ),
            "session state is not confirmed; synchronize before retrying"
        );
        Ok(())
    }

    fn mutate(&mut self, method: &str, params: Value) -> Result<Value> {
        self.mutate_with_dispatch(method, params, || {})
    }

    fn mutate_with_dispatch(
        &mut self,
        method: &str,
        params: Value,
        dispatch: impl FnOnce(),
    ) -> Result<Value> {
        self.mutate_with_authorization(method, params, || Ok(()), dispatch)
    }

    fn mutate_with_authorization(
        &mut self,
        method: &str,
        params: Value,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<Value> {
        let state = self.selected.as_mut().context("no selected session")?;
        let owner = state.owner.clone();
        // Invalidating first prevents a second submission even if the acknowledgement is lost.
        let previous_status = state.status;
        state.status = Status::OutcomeUnknown;
        let mut dispatched = false;
        let mut following_requested = false;
        let response = self.connection.request_with_dispatch(
            method,
            params,
            Some(&owner),
            |m| {
                if following_status_requested(&m, state) {
                    following_requested = true;
                    Ok(())
                } else {
                    state.notification(m)
                }
            },
            || {
                authorize()?;
                dispatched = true;
                dispatch();
                Ok(())
            },
        );
        if !dispatched {
            // No request bytes or notifications were processed. Local framing
            // failure must not poison the confirmed snapshot as an unknown write.
            state.status = previous_status;
            return response;
        }
        if following_requested && self.connection.is_connected() {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":true}),
                &owner,
            )?;
        }
        match response {
            Ok(value) if value["method"] == method => {
                // No blind retry or claimed success. A fresh snapshot resolves the operation.
                state.status = Status::OutcomeUnknown;
                Ok(value["result"].clone())
            }
            Ok(_) => {
                state.invalidate(Status::Unsupported);
                anyhow::bail!("unrecognized owner acknowledgement")
            }
            Err(error) => {
                state.invalidate(Status::OutcomeUnknown);
                Err(error)
            }
        }
    }

    fn invalidate(&mut self, status: Status) {
        if let Some(state) = &mut self.selected {
            state.invalidate(status);
        }
    }

    fn unfollow(&mut self) {
        if let Some(state) = self.selected.take() {
            let _ = self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":false}),
                &state.owner,
            );
        }
    }
}

fn validate_interrupt_receipt(receipt: &Value, expected_turn_id: &str) -> Result<()> {
    ensure!(
        receipt["ok"] == true && receipt["interruptedTurnId"].as_str() == Some(expected_turn_id),
        "owner did not confirm the selected turn interruption; synchronize, do not retry blindly"
    );
    ensure!(
        receipt.get("goalPauseError").is_none_or(Value::is_null),
        "turn interrupted but owner reported a goal pause failure; check the original client"
    );
    Ok(())
}

type OperationKey = (PathBuf, String);
static OPERATIONS: OnceLock<Mutex<BTreeSet<OperationKey>>> = OnceLock::new();

// Serializes bridge instances across cooperating processes, without waiting for a lock.
// Official clients do not participate in this lock; this is not a cross-client CAS.
struct OperationGuard(OperationKey, Option<std::fs::File>);
impl OperationGuard {
    fn acquire(endpoint: &Path, conversation: &str) -> Result<Self> {
        let mut active = OPERATIONS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| anyhow::anyhow!("bridge operation lock unavailable"))?;
        let key = (endpoint.to_owned(), conversation.into());
        ensure!(
            active.insert(key.clone()),
            "session operation already in flight"
        );
        let mut guard = Self(key, None);
        drop(active);
        guard.1 = Some(process_lock(endpoint, conversation)?);
        Ok(guard)
    }
}

// Keep lock files permanently: unlinking a locked inode permits a second lock domain.
fn process_lock(endpoint: &Path, conversation: &str) -> Result<std::fs::File> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    let home = dirs::home_dir().context("home unavailable")?;
    let directory = home.join(".agentkib-bridge-locks");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "unsafe bridge lock directory"
    );
    // Stable hash limits filenames; a collision only conservatively blocks another operation.
    let identity = format!("{}:{conversation}", endpoint.display());
    let mut hash = 0xcbf29ce484222325u64;
    for byte in identity.as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&directory)?;
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(format!("{hash:016x}.lock").as_bytes())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_CREAT | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    ensure!(fd >= 0, "bridge process lock unavailable");
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "unsafe bridge process lock"
    );
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "session operation already in flight"
    );
    Ok(file)
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        // Release the kernel lock before admitting another in-process operation. Closing
        // alone is insufficient if another test/thread forked while this descriptor was
        // open: its CLOEXEC copy can keep the open-file-description locked until exec.
        if let Some(file) = self.1.take() {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            drop(file);
        }
        if let Some(lock) = OPERATIONS.get()
            && let Ok(mut active) = lock.lock()
        {
            active.remove(&self.0);
        }
    }
}

fn following_status_requested(message: &Value, state: &SessionState) -> bool {
    message["type"] == "broadcast"
        && message["method"] == "thread-stream-following-status-requested"
        && message["version"] == 1
        && message["sourceClientId"] == state.owner
        && message["params"]["conversationId"] == state.conversation
        && message["params"]["hostId"] == "local"
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.unfollow();
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[test]
    fn process_lock_rejects_an_independent_process() {
        const KEY: &str = "AGENTKIB_LOCK_TEST_ENDPOINT";
        if let Ok(endpoint) = std::env::var(KEY) {
            assert!(process_lock(Path::new(&endpoint), "cross-process").is_err());
            return;
        }
        let endpoint = format!("/synthetic/{}.sock", uuid::Uuid::new_v4());
        let held = process_lock(Path::new(&endpoint), "cross-process").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bridge::operation_tests::process_lock_rejects_an_independent_process",
            ])
            .env(KEY, &endpoint)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
        drop(held);
        assert!(process_lock(Path::new(&endpoint), "cross-process").is_ok());
    }

    #[test]
    fn interruption_receipt_must_confirm_exact_turn() {
        for receipt in [
            json!({"ok":true}),
            json!({"ok":true,"interruptedTurnId":null}),
            json!({"ok":true,"interruptedTurnId":"other-turn"}),
            json!({"ok":false,"interruptedTurnId":"turn-1"}),
            json!({"ok":true,"interruptedTurnId":"turn-1","goalPauseError":"failure"}),
        ] {
            assert!(validate_interrupt_receipt(&receipt, "turn-1").is_err());
        }
        assert!(
            validate_interrupt_receipt(&json!({"ok":true,"interruptedTurnId":"turn-1"}), "turn-1")
                .is_ok()
        );
    }

    #[test]
    fn guard_drop_unlocks_even_when_a_descriptor_copy_survives() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory.path().join("inherited-copy.sock");
        let guard = OperationGuard::acquire(&endpoint, "session").unwrap();
        // dup models the shared open-file-description inherited between fork and exec.
        let inherited = guard.1.as_ref().unwrap().try_clone().unwrap();
        drop(guard);
        let next = OperationGuard::acquire(&endpoint, "session").unwrap();
        drop((next, inherited));
    }

    #[test]
    fn operation_lock_rejects_duplicates_and_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint_path = directory.path().join("operation-lock-test.sock");
        let endpoint = endpoint_path.as_path();
        let first = OperationGuard::acquire(endpoint, "conversation-a").unwrap();
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_err());
        let other = OperationGuard::acquire(endpoint, "conversation-b").unwrap();
        let other_endpoint = OperationGuard::acquire(
            &directory.path().join("other-lock-test.sock"),
            "conversation-a",
        )
        .unwrap();
        drop(first);
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_ok());
        drop((other, other_endpoint));
    }
}
