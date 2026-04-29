use crate::models::{AgentStatus, ModelProviderConfig, ModelProviderType, Session, Task};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

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
            "#,
        )
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
