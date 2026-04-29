use crate::db::DatabaseService;
use crate::models::{ModelInfo, ModelProviderConfig, ModelProviderConfigInput, ModelProviderType};
use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::Deserialize;

pub struct ModelProviderService {
    client: reqwest::Client,
}

impl ModelProviderService {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("failed to create HTTP client"),
        }
    }

    pub async fn list_available_models(
        &self,
        config: ModelProviderConfigInput,
    ) -> Result<Vec<ModelInfo>, String> {
        match config.provider_type {
            ModelProviderType::Ollama => self.list_ollama_models(&config).await,
            ModelProviderType::OpenaiCompatible => self.list_openai_models(&config).await,
        }
    }

    pub async fn validate(&self, config: ModelProviderConfigInput) -> ModelProviderConfig {
        let mut sanitized = sanitize_config(&config);
        let result = match config.provider_type {
            ModelProviderType::Ollama => self.validate_ollama(&config).await,
            ModelProviderType::OpenaiCompatible => self.validate_openai_compatible(&config).await,
        };

        match result {
            Ok(()) => {
                sanitized.is_valid = true;
                sanitized.last_validated_at = Some(Utc::now().to_rfc3339());
                sanitized.last_validation_error = None;
            }
            Err(err) => {
                sanitized.is_valid = false;
                sanitized.last_validated_at = Some(Utc::now().to_rfc3339());
                sanitized.last_validation_error = Some(err);
            }
        }
        sanitized
    }

    pub async fn save_validated(
        &self,
        db: &DatabaseService,
        config: ModelProviderConfigInput,
    ) -> Result<ModelProviderConfig, String> {
        let validated = self.validate(config).await;
        db.save_model_provider_config(&validated)
            .map_err(|err| format!("Failed to save provider config: {err}"))?;
        Ok(validated)
    }

    async fn validate_ollama(&self, config: &ModelProviderConfigInput) -> Result<(), String> {
        if config.base_url.trim().is_empty() {
            return Err("Ollama base URL is required".to_string());
        }
        if config.selected_model.trim().is_empty() {
            return Err("Select an Ollama model before saving".to_string());
        }

        let models = self.list_ollama_models(config).await?;
        if models.is_empty() {
            return Err("Ollama is reachable but returned no models".to_string());
        }
        if !models
            .iter()
            .any(|model| model.name == config.selected_model)
        {
            return Err("Selected model was not found in Ollama /api/tags".to_string());
        }
        Ok(())
    }

    async fn validate_openai_compatible(
        &self,
        config: &ModelProviderConfigInput,
    ) -> Result<(), String> {
        if config.base_url.trim().is_empty() {
            return Err("Base URL is required".to_string());
        }
        if config.selected_model.trim().is_empty() {
            return Err("Selected model is required".to_string());
        }
        if config
            .api_key
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("API key is required for OpenAI-compatible providers".to_string());
        }

        match self.list_openai_models(config).await {
            Ok(models) if models.is_empty() => Ok(()),
            Ok(models) => {
                if models
                    .iter()
                    .any(|model| model.name == config.selected_model)
                {
                    Ok(())
                } else {
                    Err("Selected model was not found in /v1/models".to_string())
                }
            }
            Err(_) => Ok(()),
        }
    }

    async fn list_ollama_models(
        &self,
        config: &ModelProviderConfigInput,
    ) -> Result<Vec<ModelInfo>, String> {
        let url = format!("{}/api/tags", config.base_url.trim_end_matches('/'));
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|err| format!("Unable to reach Ollama: {err}"))?;

        if !response.status().is_success() {
            return Err(format!("Ollama returned HTTP {}", response.status()));
        }

        let body: OllamaTagsResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse Ollama model list: {err}"))?;

        Ok(body
            .models
            .into_iter()
            .map(|model| ModelInfo {
                id: model.name.clone(),
                name: model.name,
                provider_id: config.id.clone(),
                context_window: None,
                supports_tools: None,
                supports_vision: None,
                is_local: true,
            })
            .collect())
    }

    async fn list_openai_models(
        &self,
        config: &ModelProviderConfigInput,
    ) -> Result<Vec<ModelInfo>, String> {
        if config
            .api_key
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("API key is required to list models".to_string());
        }

        let mut headers = HeaderMap::new();
        let bearer = format!("Bearer {}", config.api_key.as_deref().unwrap_or_default());
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&bearer).map_err(|_| "Invalid API key header".to_string())?,
        );

        let url = format!("{}/v1/models", config.base_url.trim_end_matches('/'));
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| format!("Unable to reach models endpoint: {err}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "Models endpoint returned HTTP {}",
                response.status()
            ));
        }

        let body: OpenAiModelsResponse = response
            .json()
            .await
            .map_err(|err| format!("Failed to parse models endpoint response: {err}"))?;

        Ok(body
            .data
            .into_iter()
            .map(|model| ModelInfo {
                id: model.id.clone(),
                name: model.id,
                provider_id: config.id.clone(),
                context_window: None,
                supports_tools: None,
                supports_vision: None,
                is_local: false,
            })
            .collect())
    }
}

fn sanitize_config(input: &ModelProviderConfigInput) -> ModelProviderConfig {
    ModelProviderConfig {
        id: input.id.clone(),
        provider_type: input.provider_type.clone(),
        provider_name: input.provider_name.clone(),
        base_url: input.base_url.clone(),
        selected_model: input.selected_model.clone(),
        api_key_configured: matches!(input.provider_type, ModelProviderType::OpenaiCompatible)
            && input
                .api_key
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
                == false,
        is_valid: false,
        last_validated_at: None,
        last_validation_error: None,
    }
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}
