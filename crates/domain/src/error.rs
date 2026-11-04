use thiserror::Error;

/// Why a domain value or rule refused its input.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DomainError {
    /// Money arithmetic left the range of `i64` cents.
    #[error("amount out of range")]
    Overflow,
    /// A split's basis points must lie in 0..=10,000.
    #[error("basis points out of range: {0}")]
    BasisPoints(u32),
    /// Not a canonical ULID: 26 characters of upper-case Crockford base32.
    #[error("invalid ULID: {0}")]
    InvalidUlid(String),
    /// Not a time in the canonical RFC 3339 form for its kind.
    #[error("invalid time: {0}")]
    InvalidTime(String),
}
