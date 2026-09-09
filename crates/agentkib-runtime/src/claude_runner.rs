//! Managed Claude stream-json transport. Construction and snapshots never start Claude.
//! Wire contract: anthropics/claude-agent-sdk-python `_internal/query.py`.
//! The private lock coordinates AgentKib runtimes only; official Claude clients
//! do not honor it. This transport therefore remains an experimental capability.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_LINE: usize = 1024 * 1024;
const MAX_TEXT: usize = 4 * MAX_LINE;
const SUPPORTED_VERSION: &str = "2.1.263 (Claude Code)";

// Embedded 2.1.263 AskUserQuestion schema: answers are keyed by question text,
// and multi-select values use comma-separated labels. New form kinds fail closed.
fn question_schema(input: &Value) -> Result<Vec<Value>> {
    ensure!(
        input.as_object().is_some_and(|o| o
            .keys()
            .all(|k| matches!(k.as_str(), "questions" | "metadata"))),
        "unsupported question input"
    );
    let rows = input["questions"].as_array().context("missing questions")?;
    ensure!((1..=4).contains(&rows.len()), "unsupported question count");
    let mut ids = HashSet::new();
    rows.iter().map(|q| {
        ensure!(q.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "question" | "header" | "options" | "multiSelect"))), "unsupported question fields");
        ensure!(q.get("kind").is_none(), "unsupported question kind");
        let text = q["question"].as_str().filter(|s| !s.is_empty()).context("invalid question")?;
        ensure!(ids.insert(text), "duplicate question");
        let options = q["options"].as_array().context("missing choices")?;
        ensure!((2..=4).contains(&options.len()), "unsupported choices");
        let mut labels = HashSet::new();
        for option in options {
            ensure!(option.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "label" | "description"))), "unsupported choice fields");
            let label = option["label"].as_str().filter(|s| !s.is_empty()).context("invalid choice")?;
            ensure!(labels.insert(label), "duplicate choice");
            ensure!(option.get("preview").is_none(), "unsupported question preview");
        }
        let multi = q.get("multiSelect").map(Value::as_bool).unwrap_or(Some(false)).context("invalid multiSelect")?;
        Ok(json!({"id":text,"header":q["header"],"question":text,"options":options,"multiSelect":multi,"allowCustom":true}))
    }).collect()
}

#[derive(Default)]
struct State {
    session_id: String,
    revision: u64,
    turn_id: String,
    status: String,
    approvals: Vec<Value>,
    questions: Vec<Value>,
    seen_requests: HashSet<String>,
    stream_text: String,
    reason: Option<String>,
    initialized: bool,
    init_id: String,
    pending_user: Option<Value>,
    partial: bool,
}

impl State {
    fn answer(&mut self, id: &Value, turn: &str, answers: &Value, revision: u64) -> Result<Value> {
        ensure!(
            revision == self.revision && turn == self.turn_id,
            "stale Claude question"
        );
        let index = self
            .questions
            .iter()
            .position(|q| &q["requestId"] == id)
            .context("question no longer pending")?;
        let pending = &self.questions[index];
        let rows = pending["questions"]
            .as_array()
            .context("invalid pending questions")?;
        let answer_map = answers.as_object().context("invalid answers")?;
        ensure!(rows.len() == answer_map.len(), "answer keys mismatch");
        let mut native = serde_json::Map::new();
        for row in rows {
            let key = row["id"].as_str().context("invalid question id")?;
            let values = answer_map
                .get(key)
                .and_then(Value::as_array)
                .context("missing answer")?;
            ensure!(
                !values.is_empty()
                    && values.len() <= 16
                    && (row["multiSelect"] == true || values.len() == 1),
                "invalid answer cardinality"
            );
            let mut unique = HashSet::new();
            let text = values
                .iter()
                .map(|v| {
                    let text = v
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
                        .context("invalid answer text")?;
                    ensure!(unique.insert(text), "duplicate answer");
                    Ok(text)
                })
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            native.insert(key.to_owned(), json!(text));
        }
        let mut input = pending["input"].clone();
        input["answers"] = Value::Object(native);
        self.questions.remove(index);
        self.revision += 1;
        self.status = if !self.questions.is_empty() {
            "waiting-input"
        } else if !self.approvals.is_empty() {
            "waiting-approval"
        } else {
            "running"
        }
        .into();
        Ok(
            json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":{"behavior":"allow","updatedInput":input}}}),
        )
    }
    fn fail(&mut self, reason: impl Into<String>) {
        self.status = "outcome-unknown".into();
        self.reason = Some(reason.into());
        self.approvals.clear();
        self.questions.clear();
        self.pending_user = None;
        self.revision += 1;
    }

    fn append(&mut self, text: &str) -> Result<()> {
        ensure!(
            self.stream_text.len() + text.len() <= MAX_TEXT,
            "Claude output exceeds 4 MiB"
        );
        self.stream_text.push_str(text);
        Ok(())
    }

    fn approve(
        &mut self,
        request_id: &Value,
        turn_id: &str,
        decision: &str,
        revision: u64,
    ) -> Result<Value> {
        ensure!(revision == self.revision, "stale Claude revision");
        ensure!(
            turn_id == self.turn_id
                && matches!(self.status.as_str(), "waiting-approval" | "waiting-input"),
            "stale Claude turn"
        );
        ensure!(
            matches!(decision, "allow" | "deny"),
            "unsupported Claude approval decision"
        );
        let index = self
            .approvals
            .iter()
            .position(|a| &a["requestId"] == request_id)
            .context("unknown or already answered Claude approval")?;
        let approval = self.approvals.remove(index);
        self.revision += 1;
        self.status = if !self.questions.is_empty() {
            "waiting-input"
        } else if self.approvals.is_empty() {
            "running"
        } else {
            "waiting-approval"
        }
        .into();
        let response = if decision == "allow" {
            json!({"behavior":"allow", "updatedInput":approval["input"]})
        } else {
            json!({"behavior":"deny", "message":"Denied by the user"})
        };
        Ok(
            json!({"type":"control_response", "response":{"subtype":"success", "request_id":request_id,"response":response}}),
        )
    }

    fn frame(&mut self, frame: Value) -> Result<Option<Value>> {
        if let Some(id) = frame.get("session_id") {
            ensure!(
                id.as_str() == Some(self.session_id.as_str()),
                "Claude session ID changed unexpectedly"
            );
        }
        match frame["type"]
            .as_str()
            .context("Claude frame missing type")?
        {
            // Claude 2.1.263's embedded SDK schema declares these as outbound
            // notifications. A command lifecycle event describes queue delivery,
            // not a tool permission or the authoritative turn result. Heartbeats
            // explicitly require no response. Keep notifications revision-neutral
            // so liveness/metadata cannot invalidate a pending approval.
            "command_lifecycle" | "keep_alive" | "transcript_mirror" | "active_goal"
            | "autocompact_state" => return Ok(None),
            "control_response" => {
                ensure!(
                    !self.initialized && frame["response"]["request_id"] == self.init_id,
                    "unexpected Claude control response"
                );
                ensure!(
                    frame["response"]["subtype"] == "success",
                    "Claude initialize failed"
                );
                self.initialized = true;
                self.revision += 1;
                return Ok(self.pending_user.take());
            }
            "control_request" => {
                ensure!(
                    self.initialized,
                    "Claude requested interaction before initialize"
                );
                ensure!(
                    matches!(
                        self.status.as_str(),
                        "running" | "waiting-approval" | "waiting-input"
                    ),
                    "Claude interaction outside active turn"
                );
                let id = frame["request_id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .context("invalid Claude request id")?;
                ensure!(
                    self.seen_requests.len() < 4096,
                    "too many Claude control requests"
                );
                ensure!(
                    self.seen_requests.insert(id.to_owned()),
                    "duplicate Claude control request"
                );
                let request = &frame["request"];
                ensure!(
                    request["subtype"] == "can_use_tool",
                    "unsupported Claude control request; process stopped"
                );
                let name = request["tool_name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .context("invalid Claude tool name")?;
                ensure!(request["input"].is_object(), "invalid Claude tool input");
                ensure!(
                    self.approvals.len() < 32,
                    "too many pending Claude approvals"
                );
                ensure!(
                    request.as_object().unwrap().keys().all(|key| matches!(
                        key.as_str(),
                        "subtype"
                            | "tool_name"
                            | "input"
                            | "tool_use_id"
                            | "permission_suggestions"
                            | "blocked_path"
                            | "decision_reason"
                            | "agent_id"
                            | "title"
                            | "display_name"
                            | "description"
                            | "decision_reason_type"
                            | "matched_ask_rule"
                            | "classifier_approvable"
                            | "suppress_always_allow_rule"
                            | "default_to_no"
                            | "requires_user_interaction"
                    )),
                    "unsupported Claude permission scope"
                );
                if name == "AskUserQuestion" {
                    let questions = question_schema(&request["input"])?;
                    ensure!(self.questions.len() < 32, "too many pending questions");
                    self.questions.push(json!({"requestId":id,"turnId":self.turn_id,"method":"claude/AskUserQuestion","supported":true,"questions":questions,"input":request["input"]}));
                    self.status = "waiting-input".into();
                    self.revision += 1;
                    return Ok(None);
                }
                ensure!(
                    request
                        .get("requires_user_interaction")
                        .is_none_or(|value| value == false)
                        && name != "AskUserQuestion",
                    "unsupported Claude user interaction; process stopped"
                );
                let mut context = request.as_object().unwrap().clone();
                context.remove("input");
                context.remove("tool_name");
                context.remove("subtype");
                context.insert("blockedPath".into(), request["blocked_path"].clone());
                context.insert("decisionReason".into(), request["decision_reason"].clone());
                context.insert(
                    "permissionSuggestions".into(),
                    request["permission_suggestions"].clone(),
                );
                self.approvals.push(json!({"requestId":id,"turnId":self.turn_id,"method":"claude/can_use_tool","supported":true,"toolName":name,"input":request["input"],"context":context,"availableDecisions":["allow","deny"]}));
                self.status = if self.questions.is_empty() {
                    "waiting-approval"
                } else {
                    "waiting-input"
                }
                .into();
            }
            "control_cancel_request" => {
                ensure!(
                    frame["request_id"].is_string(),
                    "invalid Claude cancellation"
                );
                self.approvals
                    .retain(|a| a["requestId"] != frame["request_id"]);
                self.questions
                    .retain(|a| a["requestId"] != frame["request_id"]);
                if self.questions.is_empty() && self.status == "waiting-input" {
                    self.status = if self.approvals.is_empty() {
                        "running"
                    } else {
                        "waiting-approval"
                    }
                    .into();
                }
                if self.approvals.is_empty() && self.status == "waiting-approval" {
                    self.status = "running".into();
                }
            }
            "stream_event" => {
                let event = &frame["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let text = event["delta"]["text"]
                        .as_str()
                        .context("invalid Claude text delta")?;
                    self.append(text)?;
                    self.partial = true;
                }
            }
            "assistant" => {
                if !self.partial
                    && let Some(blocks) = frame["message"]["content"].as_array()
                {
                    for block in blocks {
                        if block["type"] == "text" {
                            self.append(block["text"].as_str().context("invalid Claude text")?)?;
                        }
                    }
                }
                self.partial = false;
            }
            "result" => {
                ensure!(
                    self.initialized,
                    "Claude resume failed before initialization"
                );
                ensure!(
                    self.approvals.is_empty() && self.questions.is_empty(),
                    "Claude result with unresolved approvals"
                );
                if frame["is_error"] == true || frame["subtype"] != "success" {
                    bail!(
                        "Claude turn failed: {}",
                        frame["errors"]
                            .as_array()
                            .map(|errors| errors
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("; "))
                            .filter(|s| !s.is_empty())
                            .or_else(|| frame["result"].as_str().map(str::to_owned))
                            .unwrap_or_else(|| "unknown execution error".into())
                    );
                }
                if self.stream_text.is_empty()
                    && let Some(text) = frame["result"].as_str()
                {
                    self.append(text)?;
                }
                self.status = "idle".into();
                self.stream_text.clear();
            }
            "system" => {
                // Background continuations cannot safely be associated with our one active turn.
                ensure!(
                    !matches!(
                        frame["subtype"].as_str(),
                        Some("task_started" | "background_tasks_changed")
                    ),
                    "Claude background tasks are unsupported in managed sessions"
                );
            }
            "user" | "tool_progress" | "tool_use_summary" | "rate_limit_event" | "auth_status"
            | "prompt_suggestion" => {}
            unknown => {
                let safe_type: String = unknown
                    .chars()
                    .take(64)
                    .map(|character| {
                        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                            character
                        } else {
                            '_'
                        }
                    })
                    .collect();
                bail!("unsupported Claude stream frame ({safe_type}); process stopped");
            }
        }
        self.revision += 1;
        Ok(None)
    }
}

enum Event {
    Frame(Value),
    Error(String),
    Eof,
    Write(Value),
}

struct Worker {
    sender: SyncSender<Event>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

pub struct Runner {
    workspace: PathBuf,
    uuid: String,
    state: Arc<Mutex<State>>,
    worker: Mutex<Option<Worker>>,
}

impl Runner {
    pub fn installation_supported() -> bool {
        check_version().is_ok()
    }

    pub fn new(workspace: PathBuf, uuid: String) -> Self {
        Self {
            workspace,
            uuid,
            state: Arc::new(Mutex::new(State {
                status: "idle".into(),
                ..State::default()
            })),
            worker: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        json!({"status":state.status,"sendEnabled":state.status == "idle","revision":state.revision,"turnId":state.turn_id,"approvals":state.approvals,"questions":state.questions,"streamText":state.stream_text,"reason":state.reason})
    }

    pub fn send(&self, text: &str, expected_revision: u64) -> Result<()> {
        ensure!(
            !text.trim().is_empty() && text.len() <= 128 * 1024,
            "Claude message must contain 1–131072 bytes"
        );
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        ensure!(state.revision == expected_revision, "stale Claude revision");
        ensure!(state.status == "idle", "Claude session is busy or failed");
        let turn_id = uuid::Uuid::new_v4().to_string();
        let user = json!({"type":"user","session_id":self.uuid,"parent_tool_use_id":null,"uuid":turn_id,"message":{"role":"user","content":text}});
        state.turn_id = turn_id;
        state.stream_text.clear();
        state.partial = false;
        state.reason = None;
        state.status = "running".into();
        state.revision += 1;
        if let Some(worker) = worker.as_ref() {
            if let Err(error) = worker.sender.try_send(Event::Write(user)) {
                state.fail("Claude worker unavailable");
                return Err(error.into());
            }
        } else {
            match self.start(&mut state, user) {
                Ok(started) => *worker = Some(started),
                Err(error) => {
                    state.fail(error.to_string());
                    state.status = "unsupported".into();
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub fn approve(
        &self,
        request_id: &Value,
        turn_id: &str,
        decision: &str,
        expected_revision: u64,
    ) -> Result<()> {
        let worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let worker = worker.as_ref().context("Claude session has not started")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        let response = state.approve(request_id, turn_id, decision, expected_revision)?;
        if let Err(error) = worker.sender.try_send(Event::Write(response)) {
            state.fail("Claude approval transport unavailable");
            worker.stop.store(true, Ordering::Release);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn answer(&self, id: &Value, turn: &str, answers: &Value, revision: u64) -> Result<()> {
        let worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let worker = worker.as_ref().context("Claude session has not started")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        let response = state.answer(id, turn, answers, revision)?;
        if let Err(error) = worker.sender.try_send(Event::Write(response)) {
            state.fail("Claude answer transport unavailable");
            worker.stop.store(true, Ordering::Release);
            return Err(error.into());
        }
        Ok(())
    }

    fn start(&self, state: &mut State, user: Value) -> Result<Worker> {
        let uuid = uuid::Uuid::parse_str(&self.uuid).context("invalid Claude session UUID")?;
        state.session_id = self.uuid.clone();
        let lock_dir = dirs::data_local_dir()
            .context("runtime data directory unavailable")?
            .join("agentkib/claude-runner-locks");
        std::fs::create_dir_all(&lock_dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_dir.join(format!("{uuid}.lock")))?;
        lock.try_lock()
            .context("Claude session is managed by another process")?;
        check_version()?;
        let mut command = Command::new("claude");
        #[cfg(unix)]
        command.process_group(0);
        // Non-Unix descendant cleanup needs a job object before it can be enabled.
        ensure!(cfg!(unix), "managed Claude process groups require Unix");
        let mut child = command
            .current_dir(&self.workspace)
            .arg(format!("--resume={}", self.uuid))
            .args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-mode",
                "manual",
                "--permission-prompts",
                "host",
                "--permission-prompt-tool",
                "stdio",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to start Claude")?;
        let stdout = child.stdout.take().context("Claude stdout unavailable")?;
        let (sender, receiver) = mpsc::sync_channel(32);
        let mut stdin = child.stdin.take().context("Claude stdin unavailable")?;
        let (writer, write_queue) = mpsc::sync_channel::<Value>(32);
        let write_errors = sender.clone();
        // Keep pipe backpressure off the lifecycle worker so Drop can always kill
        // our own child, even when that child has stopped reading stdin.
        thread::spawn(move || {
            for frame in write_queue {
                let result = (|| -> Result<()> {
                    serde_json::to_writer(&mut stdin, &frame)?;
                    stdin.write_all(b"\n")?;
                    stdin.flush()?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = write_errors.send(Event::Error("Claude stdin write failed".into()));
                    break;
                }
            }
        });
        let reader_sender = sender.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader)
                    .take((MAX_LINE + 1) as u64)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => {
                        let _ = reader_sender.send(Event::Eof);
                        break;
                    }
                    Ok(_) if bytes.len() > MAX_LINE => {
                        let _ =
                            reader_sender.send(Event::Error("Claude frame exceeds 1 MiB".into()));
                        break;
                    }
                    Ok(_) => match serde_json::from_slice(&bytes) {
                        Ok(frame) => {
                            if reader_sender.send(Event::Frame(frame)).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = reader_sender
                                .send(Event::Error("malformed Claude stream JSON".into()));
                            break;
                        }
                    },
                    Err(_) => {
                        let _ =
                            reader_sender.send(Event::Error("Claude stream read failed".into()));
                        break;
                    }
                }
            }
        });
        state.init_id = uuid::Uuid::new_v4().to_string();
        state.pending_user = Some(user);
        let initialize = json!({"type":"control_request","request_id":state.init_id,"request":{"subtype":"initialize","hooks":null}});
        let shared = self.state.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let join = thread::spawn(move || {
            let _lock: File = lock;
            let started = Instant::now();
            let result = (|| -> Result<()> {
                write_frame(&writer, initialize)?;
                loop {
                    if worker_stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    let state = shared
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
                    ensure!(state.status != "outcome-unknown", "Claude session failed");
                    ensure!(
                        state.initialized || started.elapsed() < Duration::from_secs(30),
                        "Claude initialize timed out"
                    );
                    if let Some(exit) = child.try_wait()? {
                        bail!("Claude process exited ({exit})");
                    }
                    drop(state);
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Ok(Event::Frame(frame)) => {
                            let response = shared
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .frame(frame)?;
                            if let Some(response) = response {
                                write_frame(&writer, response)?;
                            }
                        }
                        Ok(Event::Write(frame)) => write_frame(&writer, frame)?,
                        Ok(Event::Error(error)) => bail!("{error}"),
                        Ok(Event::Eof) => bail!("Claude stream closed"),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            bail!("Claude transport disconnected")
                        }
                    }
                }
            })();
            terminate_owned_process_group(&mut child);
            if let Err(error) = result {
                let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
                if state.status != "outcome-unknown" {
                    state.fail(error.to_string());
                }
            }
        });
        Ok(Worker {
            sender,
            stop,
            join: Some(join),
        })
    }
}

fn write_frame(writer: &SyncSender<Value>, frame: Value) -> Result<()> {
    writer
        .try_send(frame)
        .context("Claude stdin queue unavailable")?;
    Ok(())
}

fn terminate_owned_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // Only called for children spawned with process_group(0), so their PID
        // is the private PGID; never discover or signal an external Claude group.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn check_version() -> Result<()> {
    let mut child = Command::new("claude")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Claude CLI unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            let mut output = String::new();
            child
                .stdout
                .take()
                .context("Claude version stdout unavailable")?
                .take(4096)
                .read_to_string(&mut output)?;
            ensure!(
                status.success() && output.trim() == SUPPORTED_VERSION,
                "managed Claude requires CLI 2.1.263"
            );
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Claude version check timed out");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn active() -> State {
        State {
            initialized: true,
            status: "running".into(),
            turn_id: "turn".into(),
            ..State::default()
        }
    }
    fn permission(id: &str) -> Value {
        json!({"type":"control_request","request_id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"}}})
    }

    #[test]
    fn questions_round_trip_and_expire() {
        let mut state = active();
        let mut request = permission("question");
        request["request"]["tool_name"] = json!("AskUserQuestion");
        request["request"]["input"] = json!({"questions":[{"question":"Which?","header":"Choice","options":[{"label":"A"},{"label":"B"}],"multiSelect":true}]});
        request["request"]["requires_user_interaction"] = json!(true);
        state.frame(request).unwrap();
        assert!(state.approvals.is_empty());
        assert_eq!(state.status, "waiting-input");
        assert!(
            state
                .answer(
                    &json!("question"),
                    "turn",
                    &json!({"bad":["A"]}),
                    state.revision
                )
                .is_err()
        );
        state.frame(permission("approval")).unwrap();
        state
            .approve(&json!("approval"), "turn", "deny", state.revision)
            .unwrap();
        assert_eq!(state.status, "waiting-input");
        let response = state
            .answer(
                &json!("question"),
                "turn",
                &json!({"Which?":["A","B"]}),
                state.revision,
            )
            .unwrap();
        assert_eq!(
            response["response"]["response"]["updatedInput"]["answers"]["Which?"],
            "A, B"
        );
        assert_eq!(state.status, "running");
        assert!(
            state
                .answer(
                    &json!("question"),
                    "turn",
                    &json!({"Which?":["A"]}),
                    state.revision
                )
                .is_err()
        );
    }
    #[test]
    fn construction_is_passive() {
        let runner = Runner::new(PathBuf::from("/missing"), "invalid".into());
        assert_eq!(runner.snapshot()["status"], "idle");
        assert!(runner.worker.lock().unwrap().is_none());
    }
    #[test]
    fn approvals_are_exact_and_one_shot() {
        let mut state = active();
        state.frame(permission("a")).unwrap();
        assert!(state.approve(&json!("a"), "turn", "allow", 0).is_err());
        assert!(state.approve(&json!("a"), "old", "allow", 1).is_err());
        assert!(state.approve(&json!("a"), "turn", "always", 1).is_err());
        let response = state.approve(&json!("a"), "turn", "allow", 1).unwrap();
        assert_eq!(
            response["response"]["response"],
            json!({"behavior":"allow","updatedInput":{"command":"pwd"}})
        );
        assert!(state.approve(&json!("a"), "turn", "allow", 2).is_err());
        assert!(state.frame(permission("a")).is_err());
    }
    #[test]
    fn initialize_precedes_user_input() {
        let mut state = State {
            init_id: "init".into(),
            pending_user: Some(json!({"type":"user"})),
            ..State::default()
        };
        assert!(state.frame(permission("a")).is_err());
        assert_eq!(state.frame(json!({"type":"control_response","response":{"request_id":"init","subtype":"success"}})).unwrap(), Some(json!({"type":"user"})));
        assert!(state.initialized);
    }
    #[test]
    fn deny_cancel_unknown_and_failure() {
        let mut state = active();
        state.frame(permission("a")).unwrap();
        let denied = state.approve(&json!("a"), "turn", "deny", 1).unwrap();
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        state.frame(permission("b")).unwrap();
        state
            .frame(json!({"type":"control_cancel_request","request_id":"b"}))
            .unwrap();
        assert!(state.approvals.is_empty());
        assert!(state.frame(json!({"type":"control_request","request_id":"c","request":{"subtype":"elicitation"}})).is_err());
        assert!(
            state
                .frame(json!({"type":"result","subtype":"success","is_error":true}))
                .is_err()
        );
    }
    #[test]
    fn partial_stream_is_not_duplicated() {
        let mut state = active();
        state.frame(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}})).unwrap();
        state
            .frame(
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}),
            )
            .unwrap();
        assert_eq!(state.stream_text, "hello");
        assert!(state.append(&"x".repeat(MAX_TEXT)).is_err());
        state
            .frame(json!({"type":"result","subtype":"success","is_error":false,"result":"hello"}))
            .unwrap();
        assert_eq!(state.status, "idle");
        assert!(state.stream_text.is_empty());
    }

    #[test]
    fn mismatched_session_and_background_tasks_fail_closed() {
        let mut state = active();
        state.session_id = "expected".into();
        assert!(
            state
                .frame(json!({"type":"system","session_id":"forked","subtype":"init"}))
                .is_err()
        );
        assert!(
            state
                .frame(json!({"type":"system","session_id":"expected","subtype":"task_started"}))
                .is_err()
        );
        let mut request = permission("scope");
        request["request"]["additional_permissions"] = json!({"network":true});
        assert!(state.frame(request).is_err());
        assert!(state.approvals.is_empty());
    }

    #[test]
    fn session_lock_excludes_another_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.lock");
        let first = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        first.try_lock().unwrap();
        assert!(second.try_lock().is_err());
        drop(first);
        second.try_lock().unwrap();
    }

    #[test]
    fn native_permission_metadata_is_preserved() {
        let mut state = active();
        let mut request = permission("metadata");
        for (key, value) in [
            ("decision_reason_type", json!("ask-rule")),
            ("matched_ask_rule", json!({"tool":"Bash"})),
            ("classifier_approvable", json!(false)),
            ("suppress_always_allow_rule", json!(true)),
            ("default_to_no", json!(true)),
            ("requires_user_interaction", json!(false)),
        ] {
            request["request"][key] = value;
        }
        state.frame(request).unwrap();
        assert_eq!(
            state.approvals[0]["context"]["decision_reason_type"],
            "ask-rule"
        );
        assert_eq!(state.approvals[0]["context"]["default_to_no"], true);
        assert_eq!(state.approvals[0]["input"], json!({"command":"pwd"}));
    }

    #[test]
    fn interactive_requests_never_become_allow_buttons() {
        {
            let name = "OtherInteractiveTool";
            let mut state = active();
            let mut request = permission(name);
            request["request"]["tool_name"] = json!(name);
            request["request"]["requires_user_interaction"] = json!(true);
            assert!(
                state
                    .frame(request)
                    .unwrap_err()
                    .to_string()
                    .contains("unsupported Claude user interaction")
            );
            assert!(state.approvals.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_closes_descendant_pipes() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60 & echo ready; wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = sender.send(stdout.read_to_end(&mut bytes));
        });
        terminate_owned_process_group(&mut child);
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn sdk_notifications_do_not_change_turn_or_approvals() {
        let mut state = active();
        state.frame(permission("pending")).unwrap();
        state.stream_text = "partial".into();
        let before = (
            state.status.clone(),
            state.revision,
            state.approvals.clone(),
            state.stream_text.clone(),
        );
        for message_type in [
            "command_lifecycle",
            "keep_alive",
            "transcript_mirror",
            "active_goal",
            "autocompact_state",
        ] {
            assert!(
                state
                    .frame(json!({"type":message_type,"state":"completed","command_uuid":"turn"}))
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            before,
            (
                state.status.clone(),
                state.revision,
                state.approvals.clone(),
                state.stream_text.clone()
            )
        );
        let mut initializing = State {
            status: "running".into(),
            ..State::default()
        };
        initializing
            .frame(json!({"type":"command_lifecycle","state":"queued","command_uuid":"turn"}))
            .unwrap();
        assert!(!initializing.initialized);
        assert_eq!(initializing.status, "running");
        assert!(state.frame(json!({"type":"conversation_reset"})).is_err());
        assert!(state.frame(json!({"type":"unknown_notification"})).is_err());
    }
}
