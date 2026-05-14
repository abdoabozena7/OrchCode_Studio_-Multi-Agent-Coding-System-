use crate::models::{AgentStatus, ModelProviderConfig, ModelProviderType, Session, Task};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const EVENT_AUTHORITY_RUNTIME_BRIDGE: &str = "runtime_bridge";
const EVENT_AUTHORITY_RUST: &str = "rust";
const EVENT_PATCH_PROPOSED: &str = "runtime.patch.proposed";
const EVENT_PATCH_APPROVED: &str = "runtime.patch.approved";
const EVENT_PATCH_APPLIED: &str = "runtime.patch.applied";
const EVENT_PATCH_REJECTED: &str = "runtime.patch.rejected";
const EVENT_COMMAND_REQUESTED: &str = "runtime.command.requested";
const EVENT_COMMAND_COMPLETED: &str = "runtime.command.completed";
const EVENT_ARTIFACT_CREATED: &str = "runtime.artifact.created";

pub struct DatabaseService {
    conn: Connection,
}

impl DatabaseService {
    pub fn new() -> rusqlite::Result<Self> {
        let db_path = app_database_path();
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        let service = Self { conn };
        service.initialize()?;
        Ok(service)
    }

    fn initialize(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                user_prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                agent_role TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS tool_calls (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                status TEXT NOT NULL,
                input_summary TEXT,
                output_summary TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS patches (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                diff_text TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS project_memory (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS model_provider_config (
                id TEXT PRIMARY KEY,
                provider_type TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                selected_model TEXT NOT NULL,
                api_key_configured INTEGER NOT NULL DEFAULT 0,
                is_valid INTEGER NOT NULL DEFAULT 0,
                last_validated_at TEXT,
                last_validation_error TEXT
            );

            CREATE TABLE IF NOT EXISTS orchestration_runs (
                session_id TEXT PRIMARY KEY,
                product_brief TEXT,
                business_brief TEXT,
                technical_plan TEXT,
                assignment_plan TEXT,
                status TEXT NOT NULL,
                trust_profile TEXT,
                token_hash TEXT,
                token_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                canonical_event_type TEXT,
                authority TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS command_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                command TEXT NOT NULL,
                risk TEXT NOT NULL,
                reason TEXT,
                status TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS command_results (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                request_id TEXT,
                command TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                stdout TEXT,
                stderr TEXT,
                message TEXT,
                payload TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                artifact_type TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            "#,
        )?;
        add_column_if_missing(&self.conn, "agent_runs", "agent_id", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "role_title", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "lifecycle_stage", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "artifact_json", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "started_at", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "completed_at", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "updated_at", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "proposal_payload", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_payload", "TEXT")?;
        add_column_if_missing(&self.conn, "session_events", "canonical_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "session_events", "authority", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "payload", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "updated_at", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "payload", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_authority", "TEXT")?;
        self.backfill_event_metadata()?;
        Ok(())
    }

    pub fn upsert_project(&self, name: &str, path: &str) -> rusqlite::Result<String> {
        let now = Utc::now().to_rfc3339();
        if let Some(id) = self
            .conn
            .query_row(
                "SELECT id FROM projects WHERE path = ?1",
                params![path],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            self.conn.execute(
                "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, &now, &id],
            )?;
            return Ok(id);
        }

        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, name, path, &now, &now],
        )?;
        Ok(id)
    }

    pub fn create_mock_session(
        &self,
        project_id: Option<String>,
        user_prompt: &str,
    ) -> rusqlite::Result<crate::models::CreateSessionResponse> {
        let now = Utc::now().to_rfc3339();
        let session = Session {
            id: Uuid::new_v4().to_string(),
            project_id,
            user_prompt: user_prompt.to_string(),
            status: "planning".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        self.conn.execute(
            "INSERT INTO sessions (id, project_id, user_prompt, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &session.id,
                &session.project_id,
                &session.user_prompt,
                &session.status,
                &session.created_at,
                &session.updated_at
            ],
        )?;

        let tasks = vec![
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Analyze project".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Create technical plan".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Prepare patch proposal".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
        ];

        for task in &tasks {
            self.conn.execute(
                "INSERT INTO tasks (id, session_id, title, status, agent_role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &task.id,
                    &task.session_id,
                    &task.title,
                    &task.status,
                    &task.agent_role,
                    &task.created_at
                ],
            )?;
        }

        let agents = vec![
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Product Orchestrator".to_string(),
                status: "done".to_string(),
                detail: Some("Mock product framing complete".to_string()),
            },
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Business Orchestrator".to_string(),
                status: "done".to_string(),
                detail: Some("Mock business constraints reviewed".to_string()),
            },
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Engineering Orchestrator".to_string(),
                status: "planning".to_string(),
                detail: Some("Preparing technical plan".to_string()),
            },
        ];

        for agent in &agents {
            self.conn.execute(
                "INSERT INTO agent_runs (id, session_id, name, status, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &agent.id,
                    &agent.session_id,
                    &agent.name,
                    &agent.status,
                    &agent.detail,
                    &now
                ],
            )?;
        }

        Ok(crate::models::CreateSessionResponse {
            session,
            tasks,
            agents,
        })
    }

    pub fn tasks_for_session(&self, session_id: &str) -> rusqlite::Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, title, status, agent_role, created_at FROM tasks WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                session_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                agent_role: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn agents_for_session(&self, session_id: &str) -> rusqlite::Result<Vec<AgentStatus>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, name, status, detail FROM agent_runs WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(AgentStatus {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                status: row.get(3)?,
                detail: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn save_model_provider_config(&self, config: &ModelProviderConfig) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM model_provider_config", [])?;
        self.conn.execute(
            "INSERT INTO model_provider_config (id, provider_type, provider_name, base_url, selected_model, api_key_configured, is_valid, last_validated_at, last_validation_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                config.id,
                provider_type_to_str(&config.provider_type),
                &config.provider_name,
                &config.base_url,
                &config.selected_model,
                i64::from(config.api_key_configured),
                i64::from(config.is_valid),
                &config.last_validated_at,
                &config.last_validation_error
            ],
        )?;
        Ok(())
    }

    pub fn get_model_provider_config(&self) -> rusqlite::Result<Option<ModelProviderConfig>> {
        self.conn
            .query_row(
                "SELECT id, provider_type, provider_name, base_url, selected_model, api_key_configured, is_valid, last_validated_at, last_validation_error FROM model_provider_config LIMIT 1",
                [],
                |row| {
                    let provider_type: String = row.get(1)?;
                    Ok(ModelProviderConfig {
                        id: row.get(0)?,
                        provider_type: provider_type_from_str(&provider_type),
                        provider_name: row.get(2)?,
                        base_url: row.get(3)?,
                        selected_model: row.get(4)?,
                        api_key_configured: row.get::<_, i64>(5)? == 1,
                        is_valid: row.get::<_, i64>(6)? == 1,
                        last_validated_at: row.get(7)?,
                        last_validation_error: row.get(8)?,
                    })
                },
            )
            .optional()
    }

    pub fn clear_model_provider_config(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM model_provider_config", [])?;
        Ok(())
    }

    pub fn create_orchestration_run(
        &self,
        session_id: &str,
        user_prompt: &str,
        status: &str,
        trust_profile: &str,
        token_hash: &str,
        token_expires_at: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT OR REPLACE INTO orchestration_runs (session_id, status, trust_profile, token_hash, token_expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT created_at FROM orchestration_runs WHERE session_id = ?1), ?6), ?6)",
            params![session_id, status, trust_profile, token_hash, token_expires_at, &now],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO sessions (id, project_id, user_prompt, status, created_at, updated_at) VALUES (?1, NULL, ?2, ?3, ?4, ?4)",
            params![session_id, user_prompt, status, &now],
        )?;
        Ok(())
    }

    pub fn append_session_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> rusqlite::Result<()> {
        self.append_session_event_with_authority(
            session_id,
            event_type,
            payload,
            EVENT_AUTHORITY_RUNTIME_BRIDGE,
        )
    }

    pub fn append_authoritative_session_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> rusqlite::Result<()> {
        self.append_session_event_with_authority(session_id, event_type, payload, EVENT_AUTHORITY_RUST)
    }

    fn append_session_event_with_authority(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
        authority: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        let event_id = Uuid::new_v4().to_string();
        let canonical_event_type = canonical_event_type(event_type);
        self.conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, canonical_event_type, authority, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![event_id, session_id, event_type, canonical_event_type, authority, payload, &now],
        )?;
        self.persist_event_projection(
            &event_id,
            session_id,
            canonical_event_type,
            payload,
            &now,
            authority,
        )?;
        Ok(())
    }

    fn backfill_event_metadata(&self) -> rusqlite::Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, canonical_event_type, authority FROM session_events",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        for row in rows {
            let (id, event_type, canonical, authority) = row;
            let canonical = canonical.unwrap_or_else(|| canonical_event_type(&event_type).to_string());
            let authority = authority.unwrap_or_else(|| EVENT_AUTHORITY_RUNTIME_BRIDGE.to_string());
            self.conn.execute(
                "UPDATE session_events SET canonical_event_type = ?2, authority = ?3 WHERE id = ?1",
                params![id, canonical, authority],
            )?;
        }
        Ok(())
    }

    fn persist_event_projection(
        &self,
        event_id: &str,
        session_id: &str,
        event_type: &str,
        payload: &str,
        now: &str,
        authority: &str,
    ) -> rusqlite::Result<()> {
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return Ok(());
        };
        if event_type == EVENT_PATCH_PROPOSED {
            if let Some(proposal) = value.get("proposal").or(Some(&value)) {
                if let (Some(id), Some(title), Some(diff)) = (
                    proposal.get("id").and_then(Value::as_str),
                    proposal.get("title").and_then(Value::as_str),
                    proposal.get("unifiedDiff").and_then(Value::as_str),
                ) {
                    let status = proposal
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("proposed");
                    self.upsert_patch_status(
                        session_id,
                        id,
                        title,
                        diff,
                        status,
                        &proposal.to_string(),
                        event_id,
                        event_type,
                        authority,
                        payload,
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_PATCH_APPROVED
            || event_type == EVENT_PATCH_APPLIED
            || event_type == EVENT_PATCH_REJECTED
        {
            if let Some(patch_id) = value
                .get("patchId")
                .or_else(|| value.get("patch_id"))
                .and_then(Value::as_str)
            {
                let status = match event_type {
                    EVENT_PATCH_APPROVED => Some("approved"),
                    EVENT_PATCH_APPLIED => value
                        .get("status")
                        .and_then(Value::as_str)
                        .or(Some("applied")),
                    EVENT_PATCH_REJECTED => Some("rejected"),
                    _ => None,
                };
                if let Some(status) = status {
                    self.update_patch_status(
                        session_id,
                        patch_id,
                        status,
                        event_id,
                        event_type,
                        authority,
                        payload,
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_REQUESTED {
            if let Some(request) = value.get("commandRequest").or(Some(&value)) {
                if let (Some(id), Some(command), Some(risk)) = (
                    request.get("id").and_then(Value::as_str),
                    request.get("command").and_then(Value::as_str),
                    request.get("risk").and_then(Value::as_str),
                ) {
                    let status = request
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("requested");
                    self.conn.execute(
                        "INSERT OR REPLACE INTO command_requests (id, session_id, command, risk, reason, status, payload, source_event_id, source_event_type, source_event_authority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE((SELECT created_at FROM command_requests WHERE id = ?1), ?11), ?11)",
                        params![
                            id,
                            session_id,
                            command,
                            risk,
                            request.get("reason").and_then(Value::as_str),
                            status,
                            request.to_string(),
                            event_id,
                            event_type,
                            authority,
                            now
                        ],
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_COMPLETED {
            if let Some(result) = value.get("result").or(Some(&value)) {
                if let (Some(command), Some(status)) = (
                    result.get("command").and_then(Value::as_str),
                    result.get("status").and_then(Value::as_str),
                ) {
                    self.conn.execute(
                        "INSERT INTO command_results (id, session_id, request_id, command, status, exit_code, stdout, stderr, message, payload, source_event_id, source_event_type, source_event_authority, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        params![
                            Uuid::new_v4().to_string(),
                            session_id,
                            value.get("requestId").and_then(Value::as_str),
                            command,
                            status,
                            result.get("exitCode").and_then(Value::as_i64),
                            result.get("stdout").and_then(Value::as_str),
                            result.get("stderr").and_then(Value::as_str),
                            result.get("message").and_then(Value::as_str),
                            value.to_string(),
                            event_id,
                            event_type,
                            authority,
                            now
                        ],
                    )?;
                    if let Some(request_id) = value.get("requestId").and_then(Value::as_str) {
                        self.update_command_request_status(
                            session_id,
                            request_id,
                            command_request_status_from_result(status),
                            now,
                        )?;
                    }
                }
            }
        }
        if event_type == EVENT_ARTIFACT_CREATED {
            if let Some(artifact) = value.get("artifact").or(Some(&value)) {
                if let (Some(id), Some(artifact_type), Some(title)) = (
                    artifact.get("id").and_then(Value::as_str),
                    artifact.get("type").and_then(Value::as_str),
                    artifact.get("title").and_then(Value::as_str),
                ) {
                    self.conn.execute(
                        "INSERT OR REPLACE INTO artifacts (id, session_id, artifact_type, title, summary, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT created_at FROM artifacts WHERE id = ?1), ?7))",
                        params![
                            id,
                            session_id,
                            artifact_type,
                            title,
                            artifact.get("summary").and_then(Value::as_str),
                            artifact.to_string(),
                            now
                        ],
                    )?;
                }
            }
        }
        Ok(())
    }

    fn upsert_patch_status(
        &self,
        session_id: &str,
        patch_id: &str,
        title: &str,
        diff: &str,
        status: &str,
        proposal_payload: &str,
        last_event_id: &str,
        last_event_type: &str,
        last_event_authority: &str,
        last_event_payload: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO patches (id, session_id, title, diff_text, status, proposal_payload, last_event_id, last_event_type, last_event_authority, last_event_payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE((SELECT created_at FROM patches WHERE id = ?1), ?11), ?11)",
            params![
                patch_id,
                session_id,
                title,
                diff,
                status,
                proposal_payload,
                last_event_id,
                last_event_type,
                last_event_authority,
                last_event_payload,
                now
            ],
        )?;
        Ok(())
    }

    pub fn update_patch_status(
        &self,
        session_id: &str,
        patch_id: &str,
        status: &str,
        last_event_id: &str,
        last_event_type: &str,
        last_event_authority: &str,
        last_event_payload: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE patches SET status = ?3, last_event_id = ?4, last_event_type = ?5, last_event_authority = ?6, last_event_payload = ?7, updated_at = ?8 WHERE session_id = ?1 AND id = ?2",
            params![session_id, patch_id, status, last_event_id, last_event_type, last_event_authority, last_event_payload, now],
        )?;
        Ok(())
    }

    fn update_command_request_status(
        &self,
        session_id: &str,
        request_id: &str,
        status: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE command_requests SET status = ?3, updated_at = ?4 WHERE session_id = ?1 AND id = ?2",
            params![session_id, request_id, status, now],
        )?;
        Ok(())
    }

    pub fn upsert_orchestration_run(
        &self,
        session_id: &str,
        status: &str,
        product_brief: Option<&str>,
        business_brief: Option<&str>,
        technical_plan: Option<&str>,
        assignment_plan: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE orchestration_runs SET status = ?2, product_brief = COALESCE(?3, product_brief), business_brief = COALESCE(?4, business_brief), technical_plan = COALESCE(?5, technical_plan), assignment_plan = COALESCE(?6, assignment_plan), updated_at = ?7 WHERE session_id = ?1",
            params![session_id, status, product_brief, business_brief, technical_plan, assignment_plan, &now],
        )?;
        Ok(())
    }

    pub fn upsert_agent_run(
        &self,
        session_id: &str,
        agent_id: &str,
        role_title: &str,
        lifecycle_stage: &str,
        artifact_json: Option<&str>,
        status: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_runs (id, session_id, name, status, detail, created_at, agent_id, role_title, lifecycle_stage, artifact_json, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?1, ?3, ?6, ?7, ?5, CASE WHEN ?4 IN ('completed','blocked','failed') THEN ?5 ELSE NULL END) ON CONFLICT(id) DO UPDATE SET status = excluded.status, role_title = excluded.role_title, lifecycle_stage = excluded.lifecycle_stage, artifact_json = excluded.artifact_json, completed_at = excluded.completed_at",
            params![agent_id, session_id, role_title, status, &now, lifecycle_stage, artifact_json],
        )?;
        Ok(())
    }

    pub fn patch_payload_for_session(
        &self,
        session_id: &str,
        patch_id: &str,
    ) -> rusqlite::Result<Option<String>> {
        self.conn.query_row(
            "SELECT payload FROM session_events WHERE session_id = ?1 AND (COALESCE(canonical_event_type, event_type) = ?2 OR event_type = 'patch.proposed') AND payload LIKE ?3 ORDER BY created_at DESC LIMIT 1",
            params![session_id, EVENT_PATCH_PROPOSED, format!("%{}%", patch_id)],
            |row| row.get::<_, String>(0),
        ).optional()
    }
}

fn canonical_event_type(event_type: &str) -> &str {
    match event_type {
        "patch.proposed" | EVENT_PATCH_PROPOSED => EVENT_PATCH_PROPOSED,
        "patch.approved" | EVENT_PATCH_APPROVED => EVENT_PATCH_APPROVED,
        "apply.completed" | EVENT_PATCH_APPLIED => EVENT_PATCH_APPLIED,
        "patch.rejected" | EVENT_PATCH_REJECTED => EVENT_PATCH_REJECTED,
        "command.completed" | EVENT_COMMAND_COMPLETED => EVENT_COMMAND_COMPLETED,
        EVENT_COMMAND_REQUESTED => EVENT_COMMAND_REQUESTED,
        EVENT_ARTIFACT_CREATED => EVENT_ARTIFACT_CREATED,
        _ => event_type,
    }
}

fn command_request_status_from_result(result_status: &str) -> &str {
    match result_status {
        "executed" => "completed",
        "blocked" => "blocked",
        "approval_required" => "approval_required",
        _ => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    impl DatabaseService {
        fn new_in_memory() -> rusqlite::Result<Self> {
            let conn = Connection::open_in_memory()?;
            let service = Self { conn };
            service.initialize()?;
            Ok(service)
        }
    }

    #[test]
    fn canonicalizes_patch_and_command_event_projections() {
        let db = DatabaseService::new_in_memory().expect("db");
        let session_id = "session_1";
        db.create_orchestration_run(
            session_id,
            "Test prompt",
            "created",
            "standard",
            "token_hash",
            "2099-01-01T00:00:00Z",
        )
        .expect("seed session");

        db.append_session_event(
            session_id,
            "patch.proposed",
            &json!({
                "proposal": {
                    "id": "patch_1",
                    "title": "Patch title",
                    "unifiedDiff": "diff --git a/a.txt b/a.txt",
                    "status": "proposed"
                }
            })
            .to_string(),
        )
        .expect("patch proposed");
        db.append_authoritative_session_event(
            session_id,
            EVENT_PATCH_APPLIED,
            &json!({
                "patchId": "patch_1",
                "status": "applied"
            })
            .to_string(),
        )
        .expect("patch applied");
        db.append_session_event(
            session_id,
            "runtime.command.requested",
            &json!({
                "commandRequest": {
                    "id": "req_1",
                    "command": "cargo test",
                    "risk": "medium",
                    "status": "approval_required"
                }
            })
            .to_string(),
        )
        .expect("command requested");
        db.append_authoritative_session_event(
            session_id,
            "command.completed",
            &json!({
                "requestId": "req_1",
                "result": {
                    "command": "cargo test",
                    "status": "executed",
                    "exitCode": 0,
                    "stdout": "ok",
                    "stderr": "",
                    "message": "done"
                }
            })
            .to_string(),
        )
        .expect("command completed");

        let patch = db
            .conn
            .query_row(
                "SELECT status, last_event_type, last_event_authority, proposal_payload FROM patches WHERE id = 'patch_1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .expect("patch row");
        assert_eq!(patch.0, "applied");
        assert_eq!(patch.1, EVENT_PATCH_APPLIED);
        assert_eq!(patch.2, EVENT_AUTHORITY_RUST);
        assert!(patch.3.contains("\"unifiedDiff\""));

        let command_request = db
            .conn
            .query_row(
                "SELECT status, source_event_type, source_event_authority FROM command_requests WHERE id = 'req_1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .expect("request row");
        assert_eq!(command_request.0, "completed");
        assert_eq!(command_request.1, EVENT_COMMAND_REQUESTED);
        assert_eq!(command_request.2, EVENT_AUTHORITY_RUNTIME_BRIDGE);

        let command_result = db
            .conn
            .query_row(
                "SELECT source_event_type, source_event_authority FROM command_results WHERE request_id = 'req_1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("result row");
        assert_eq!(command_result.0, EVENT_COMMAND_COMPLETED);
        assert_eq!(command_result.1, EVENT_AUTHORITY_RUST);

        let session_event = db
            .conn
            .query_row(
                "SELECT canonical_event_type, authority FROM session_events WHERE event_type = 'command.completed'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("session event");
        assert_eq!(session_event.0, EVENT_COMMAND_COMPLETED);
        assert_eq!(session_event.1, EVENT_AUTHORITY_RUST);
    }
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    ty: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])?;
    Ok(())
}

fn app_database_path() -> PathBuf {
    dirs_next::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("OrchCodeStudio")
        .join("state.sqlite")
}

fn provider_type_to_str(provider_type: &ModelProviderType) -> &'static str {
    match provider_type {
        ModelProviderType::Ollama => "ollama",
        ModelProviderType::OpenaiCompatible => "openai_compatible",
    }
}

fn provider_type_from_str(provider_type: &str) -> ModelProviderType {
    match provider_type {
        "openai_compatible" => ModelProviderType::OpenaiCompatible,
        _ => ModelProviderType::Ollama,
    }
}
