//! The pattern checker for the two free-text fields (docs/domain.md, "Free text and personal
//! data"): the order note and the catering brief.
//!
//! The bakery holds no personal data by construction, so a value that looks like an email
//! address, a phone number, a card number or a URL is refused. The checker is hand-rolled
//! scanning rather than a regex crate: the patterns are four sentences long, and a regex engine
//! would be the largest thing in a crate that is meant to stay small.
//!
//! The doc says characters are counted after NFC normalization. NFC needs Unicode tables this
//! crate does not carry, so it lands in a later PR; [`normalize`] does the one rule that needs no
//! tables, removing control characters other than a newline, and the length caps of 140 and 500
//! characters ([`check_note`], [`check_brief`]) count Unicode scalar values after it. Until NFC
//! arrives, a decomposed accent counts as two characters, so a note can only be refused early,
//! never let through long. Digits written as full-width forms are treated as
//! digits here, since NFC would not fold them and a phone number in full-width digits is still a
//! phone number.
//!
//! The checker names a class and never echoes the text, so a caller can put the class in a 422
//! problem and nothing the visitor typed reaches a log.

/// The class of personal-looking data a value matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FreeTextClass {
    Email,
    Phone,
    CardNumber,
    Url,
}

impl FreeTextClass {
    /// The slug a problem document names the class by.
    pub fn slug(self) -> &'static str {
        match self {
            FreeTextClass::Email => "email",
            FreeTextClass::Phone => "phone",
            FreeTextClass::CardNumber => "card-number",
            FreeTextClass::Url => "url",
        }
    }
}

/// The top-level domains that make `word.tld` a URL. A fixed list: any longer one would catch
/// ordinary sentences that lack a space after a full stop.
const TLDS: &[&str] = &[
    "com", "org", "net", "io", "co", "us", "uk", "de", "fr", "app", "dev", "info", "biz", "edu",
    "gov",
];

/// The order note's cap in characters (docs/domain.md, "Free text and personal data").
pub const NOTE_MAX_CHARS: usize = 140;

/// The catering brief's cap in characters (docs/domain.md, "Free text and personal data").
pub const BRIEF_MAX_CHARS: usize = 500;

/// Why a free-text field was refused: too long, or holding one of the four classes. Neither
/// variant carries the text, so the error can go into a problem document and a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FreeTextError {
    /// Longer than `max` characters after normalization.
    TooLong { max: usize },
    /// Holds a value of this class.
    Class(FreeTextClass),
}

impl FreeTextError {
    /// The slug a problem document names the rule by.
    pub fn slug(self) -> &'static str {
        match self {
            FreeTextError::TooLong { .. } => "too-long",
            FreeTextError::Class(class) => class.slug(),
        }
    }
}

/// Checks an order note: at most [`NOTE_MAX_CHARS`] characters after [`normalize`], and none of
/// the four classes. Returns the normalized text, which is what the `Order` stores.
pub fn check_note(text: &str) -> Result<String, FreeTextError> {
    check_capped(text, NOTE_MAX_CHARS)
}

/// Checks a catering brief: at most [`BRIEF_MAX_CHARS`] characters after [`normalize`], and none
/// of the four classes. Returns the normalized text.
pub fn check_brief(text: &str) -> Result<String, FreeTextError> {
    check_capped(text, BRIEF_MAX_CHARS)
}

fn check_capped(text: &str, max: usize) -> Result<String, FreeTextError> {
    let normalized = normalize(text);
    // `chars` yields Unicode scalar values, the unit the doc counts in.
    if normalized.chars().count() > max {
        return Err(FreeTextError::TooLong { max });
    }
    check_free_text(&normalized).map_err(FreeTextError::Class)?;
    Ok(normalized)
}

/// Removes control characters other than a newline. A tab or a stray escape cannot then split
/// the digits of a number and slip past the checker.
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter(|&c| c == '\n' || !c.is_control())
        .collect()
}

/// `Ok` when `text` holds none of the four classes, else the first class found, checked in the
/// order card number, phone number, email address, URL. The text is normalized first.
pub fn check_free_text(text: &str) -> Result<(), FreeTextClass> {
    let text = normalize(text);
    if let Some(class) = digit_runs(&text) {
        return Err(class);
    }
    if has_email(&text) {
        return Err(FreeTextClass::Email);
    }
    if has_url(&text) {
        return Err(FreeTextClass::Url);
    }
    Ok(())
}

fn is_digit(c: char) -> bool {
    c.is_ascii_digit() || ('\u{FF10}'..='\u{FF19}').contains(&c)
}

/// Characters a phone or card number may be spaced with.
fn is_separator(c: char) -> bool {
    matches!(c, ' ' | '.' | '-' | '(' | ')' | '+')
}

/// A run is a maximal stretch of digits and separators; a letter, comma or newline ends it. A
/// run of 13 to 19 digits is a card number, one of 7 or more a phone number. So "12 scones" and
/// "Two candles, 24 forks" pass, and "555 0100 123" does not.
fn digit_runs(text: &str) -> Option<FreeTextClass> {
    let mut worst: Option<FreeTextClass> = None;
    let mut digits = 0usize;
    for c in text.chars().chain(std::iter::once('\n')) {
        if is_digit(c) {
            digits += 1;
        } else if !is_separator(c) {
            let class = match digits {
                13..=19 => Some(FreeTextClass::CardNumber),
                7.. => Some(FreeTextClass::Phone),
                _ => None,
            };
            // A card number outranks a phone number found in the same text.
            if class == Some(FreeTextClass::CardNumber) || worst.is_none() {
                worst = class.or(worst);
            }
            digits = 0;
        }
    }
    worst
}

/// A run of non-space characters holding an `@` with something before it and, after it, a dot
/// with something on each side.
fn has_email(text: &str) -> bool {
    text.split_whitespace().any(|token| {
        token.match_indices('@').any(|(at, _)| {
            let (local, domain) = (&token[..at], &token[at + 1..]);
            !local.is_empty() && domain_has_dot(domain)
        })
    })
}

fn domain_has_dot(domain: &str) -> bool {
    domain
        .match_indices('.')
        .any(|(dot, _)| dot > 0 && dot + 1 < domain.len())
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-'
}

/// A scheme, a `www.` prefix, or a word, a dot and a listed top-level domain that ends there.
fn has_url(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
        return true;
    }
    let chars: Vec<char> = lower.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c != '.' || i == 0 || !is_word_char(chars[i - 1]) {
            continue;
        }
        let tail: String = chars[i + 1..]
            .iter()
            .take_while(|&&t| t.is_alphanumeric())
            .collect();
        if TLDS.contains(&tail.as_str()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(text: &str) -> Option<FreeTextClass> {
        check_free_text(text).err()
    }

    #[test]
    fn ordinary_notes_pass() {
        for note in [
            "Please slice the loaf",
            "Leave at the side door",
            "Two candles, no message",
            "12 scones",
            "Two candles, 24 forks, 3 napkins",
            "Ring the bell twice (the left one)",
            "Half-and-half, no sugar. Thanks!",
            "Pick up at 3.30 please",
            "Table for 12 at 5, back door",
            "e.g. the big one, i.e. the round loaf",
            "Line one\nLine two",
            "",
        ] {
            assert_eq!(class(note), None, "{note:?}");
        }
    }

    #[test]
    fn emails_are_found() {
        for text in [
            "mail me at fern@example.com",
            "fern.sorrel+cakes@example.org",
            "x@a.b",
            "(fern@example.net)",
            "me@example.com.",
        ] {
            assert_eq!(class(text), Some(FreeTextClass::Email), "{text:?}");
        }
    }

    #[test]
    fn an_at_sign_alone_is_not_an_email() {
        for text in [
            "meet @ 5pm",
            "cake@ home",
            "@home",
            "see you @noon",
            "fern@localhost",
            "fern@.com",
            "fern@example.",
        ] {
            assert_eq!(class(text), None, "{text:?}");
        }
    }

    #[test]
    fn phone_numbers_are_found() {
        for text in [
            "call 555-0100",
            "call 555 0100",
            "(801) 555-0100",
            "+1 801 555 0100",
            "801.555.0100",
            "8015550100",
            "5550100",
            "call me on 555 0100 after 5",
            "\u{FF15}\u{FF15}\u{FF15}\u{FF10}\u{FF11}\u{FF10}\u{FF10}",
        ] {
            assert_eq!(class(text), Some(FreeTextClass::Phone), "{text:?}");
        }
    }

    #[test]
    fn short_digit_runs_pass() {
        for text in [
            "555-01",
            "123456",
            "12 34 56",
            "6 loaves, 12 rolls, 7 tarts",
        ] {
            assert_eq!(class(text), None, "{text:?}");
        }
    }

    #[test]
    fn card_numbers_are_found() {
        for text in [
            "4242 4242 4242 4242",
            "4242-4242-4242-4242",
            "4242424242424242",
            "pay with 4242 4242 4242 4242 please",
            // Fails Luhn on purpose: the rule does not care.
            "1234 5678 9012 3456",
            "1234567890123",
            "1234567890123456789",
        ] {
            assert_eq!(class(text), Some(FreeTextClass::CardNumber), "{text:?}");
        }
    }

    #[test]
    fn twenty_digits_are_still_a_phone_number() {
        assert_eq!(class("12345678901234567890"), Some(FreeTextClass::Phone));
    }

    #[test]
    fn urls_are_found() {
        for text in [
            "see http://example.com",
            "see HTTPS://EXAMPLE.ORG/x",
            "www.example",
            "Visit Www.Example",
            "bakery.com",
            "go to cake-shop.org now",
            "example.io",
            "a.co",
            "note.dev,",
            "fresh.gov",
            "x.edu/path",
            "site.info",
            "site.biz",
            "bread.app",
            "bread.uk",
            "bread.de",
            "bread.fr",
            "bread.us",
            "bread.net",
        ] {
            assert_eq!(class(text), Some(FreeTextClass::Url), "{text:?}");
        }
    }

    #[test]
    fn words_that_merely_contain_a_tld_pass() {
        for text in [
            "bread.community",
            "end.Done",
            "U.S. only",
            "the.dog",
            "Thanks.Comfy seat",
            "wait... what",
            ".com",
            "Cost: $4.50",
        ] {
            assert_eq!(class(text), None, "{text:?}");
        }
    }

    #[test]
    fn control_characters_cannot_split_a_number() {
        assert_eq!(class("555\u{0}0100"), Some(FreeTextClass::Phone));
        assert_eq!(
            class("4242\t4242\t4242\t4242"),
            Some(FreeTextClass::CardNumber)
        );
        assert_eq!(class("ex\u{7}ample.com"), Some(FreeTextClass::Url));
    }

    #[test]
    fn a_newline_ends_a_run() {
        assert_eq!(class("555\n0100"), None);
    }

    #[test]
    fn normalize_removes_controls_but_keeps_newlines() {
        assert_eq!(normalize("a\tb\u{0}c\u{7f}d\ne\r\n"), "abcd\ne\n");
        assert_eq!(
            normalize("Two candles, no message"),
            "Two candles, no message"
        );
        assert_eq!(normalize("caf\u{e9}"), "caf\u{e9}");
    }

    #[test]
    fn the_class_has_a_slug() {
        assert_eq!(FreeTextClass::Email.slug(), "email");
        assert_eq!(FreeTextClass::Phone.slug(), "phone");
        assert_eq!(FreeTextClass::CardNumber.slug(), "card-number");
        assert_eq!(FreeTextClass::Url.slug(), "url");
    }

    #[test]
    fn a_note_of_140_characters_passes_and_141_does_not() {
        let at_cap = "a".repeat(NOTE_MAX_CHARS);
        assert_eq!(check_note(&at_cap), Ok(at_cap.clone()));
        assert_eq!(
            check_note(&format!("{at_cap}a")),
            Err(FreeTextError::TooLong { max: 140 })
        );
    }

    #[test]
    fn a_brief_of_500_characters_passes_and_501_does_not() {
        let at_cap = "b".repeat(BRIEF_MAX_CHARS);
        assert_eq!(check_brief(&at_cap), Ok(at_cap.clone()));
        assert_eq!(
            check_brief(&format!("{at_cap}b")),
            Err(FreeTextError::TooLong { max: 500 })
        );
    }

    #[test]
    fn caps_count_scalar_values_not_bytes() {
        // 140 two-byte characters are 280 bytes and still one note.
        let accented = "\u{e9}".repeat(NOTE_MAX_CHARS);
        assert_eq!(accented.len(), 280);
        assert!(check_note(&accented).is_ok());
        // Four-byte characters too.
        assert!(check_note(&"\u{1F950}".repeat(NOTE_MAX_CHARS)).is_ok());
        assert!(check_note(&"\u{1F950}".repeat(NOTE_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn caps_count_after_control_characters_are_removed() {
        let padded = format!("{}{}", "c".repeat(NOTE_MAX_CHARS), "\u{7}".repeat(10));
        assert_eq!(check_note(&padded), Ok("c".repeat(NOTE_MAX_CHARS)));
        assert_eq!(check_note("Slice\tit"), Ok("Sliceit".to_owned()));
    }

    #[test]
    fn capped_checks_still_run_the_four_classes() {
        assert_eq!(
            check_note("call 555 0100"),
            Err(FreeTextError::Class(FreeTextClass::Phone))
        );
        assert_eq!(
            check_brief("details at fern@example.com"),
            Err(FreeTextError::Class(FreeTextClass::Email))
        );
        assert_eq!(
            check_note("Two candles, no message").unwrap(),
            "Two candles, no message"
        );
    }

    #[test]
    fn free_text_errors_have_slugs() {
        assert_eq!(FreeTextError::TooLong { max: 140 }.slug(), "too-long");
        assert_eq!(FreeTextError::Class(FreeTextClass::Url).slug(), "url");
    }

    #[test]
    fn a_card_beats_a_phone_when_both_runs_are_present() {
        assert_eq!(
            class("call 555 0100 or 4242 4242 4242 4242"),
            Some(FreeTextClass::CardNumber)
        );
    }
}
