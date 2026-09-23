pub mod artifacts;
pub mod conversations;
pub mod discovery;
pub mod embeddings;
pub mod memory;
pub mod store;
pub fn validate_target(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 253
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._@:-[]".contains(c))
}
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub mod terminal;
