//! The text encodings sign-in needs: base64url without padding (cookies, PKCE, JWTs), lower-case
//! hex (account ids, IP hashes, session ids) and percent-encoding for query strings and form
//! bodies. Hand-rolled where it is a dozen lines, `data-encoding` where it is not.

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};

/// base64url with no `=` padding (RFC 4648 section 5), as JWTs and PKCE use it.
pub fn base64url(bytes: &[u8]) -> String {
    BASE64URL_NOPAD.encode(bytes)
}

/// Decodes base64url without padding. Refuses padding, the standard alphabet's `+` and `/`, and
/// non-canonical trailing bits, so one value has one text form.
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    BASE64URL_NOPAD.decode(text.as_bytes()).ok()
}

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
    HEXLOWER.encode(bytes)
}

/// Whether `text` is exactly `len` characters of lower-case hex.
pub fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Percent-encodes everything outside RFC 3986's unreserved set (`A-Z a-z 0-9 - . _ ~`). The
/// result is safe in a query string and in an `application/x-www-form-urlencoded` body, whose
/// decoders read `%20` as a space as well as `+`.
pub fn percent_encode(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for &b in text.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0x0f)]));
        }
    }
    out
}

/// `k1=v1&k2=v2`, each value percent-encoded. The keys are this crate's constants.
pub fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Compares two byte strings in time that depends on their lengths only.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trips_without_padding() {
        let text = base64url(&[0xfb, 0xff, 0x00]);
        assert_eq!(text, "-_8A");
        assert_eq!(base64url(b"a"), "YQ");
        assert_eq!(base64url_decode("YQ").unwrap(), b"a");
        assert_eq!(base64url_decode("YQ=="), None);
        assert_eq!(base64url_decode("+/8A"), None);
        // "YR" carries non-zero trailing bits: not canonical.
        assert_eq!(base64url_decode("YR"), None);
    }

    #[test]
    fn hex_is_lower_case() {
        assert_eq!(hex(&[0xab, 0x01]), "ab01");
        assert!(is_lower_hex("ab01", 4));
        assert!(!is_lower_hex("AB01", 4));
        assert!(!is_lower_hex("ab0", 4));
    }

    #[test]
    fn percent_encoding_keeps_only_the_unreserved_set() {
        assert_eq!(percent_encode("aZ09-._~"), "aZ09-._~");
        assert_eq!(
            percent_encode("http://127.0.0.1:8787/v1/a b?c=d&e"),
            "http%3A%2F%2F127.0.0.1%3A8787%2Fv1%2Fa%20b%3Fc%3Dd%26e"
        );
        assert_eq!(percent_encode("é"), "%C3%A9");
        assert_eq!(form(&[("a", "1 2"), ("b", "+")]), "a=1%202&b=%2B");
    }

    #[test]
    fn constant_time_eq_compares() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
