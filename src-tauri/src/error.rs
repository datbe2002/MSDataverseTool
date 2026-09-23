//! A single error type that serializes to a string so it can cross the
//! Tauri command boundary and show up nicely in the frontend.

pub struct AppError(pub anyhow::Error);

pub type AppResult<T> = Result<T, AppError>;

impl std::fmt::Debug for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

// Any standard error converts in via `?`.
impl<E> From<E> for AppError
where
    E: std::error::Error + Send + Sync + 'static,
{
    fn from(e: E) -> Self {
        AppError(anyhow::Error::new(e))
    }
}

impl AppError {
    /// Wrap an `anyhow::Error` (kept as a method rather than a `From` impl to
    /// avoid a coherence conflict with the blanket `From<E: Error>` above).
    #[allow(dead_code)]
    pub fn from_anyhow(e: anyhow::Error) -> Self {
        AppError(e)
    }

    pub fn msg<T: std::fmt::Display>(m: T) -> Self {
        AppError(anyhow::anyhow!("{}", m))
    }
}
