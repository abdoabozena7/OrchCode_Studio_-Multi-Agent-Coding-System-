use std::path::Path;

pub fn is_secret_candidate(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    file_name == ".env"
        || file_name.ends_with(".pem")
        || file_name == "id_rsa"
        || file_name == "id_ed25519"
        || file_name == "credentials.json"
}
