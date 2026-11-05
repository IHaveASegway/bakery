//! Stripe's webhooks: the signature check on the raw body, the parse, the mode check, and the
//! event reduced to a Billing command (ADR 0007, decision 7; docs/security.md, "Payments
//! safety").
//!
//! `Stripe-Signature` is `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`, where each `v1` is
//! HMAC-SHA256 under the endpoint secret of `"<t>.<raw body>"`; there are two `v1` entries while
//! a secret rolls. The check compares against every `v1` in constant time and refuses a `t` more
//! than five minutes from now in either direction
//! (https://docs.stripe.com/webhooks#verify-manually, as of 2026-11-05).
//!
//! The order matters: the signature first, on the bytes as received, so an unverified body never
//! picks a sandbox; then the parse; then `livemode`.

use bakery_domain::billing::{BillingCommand, WebhookKind};
use bakery_domain::{Cents, Ulid};
use data_encoding::HEXLOWER_PERMISSIVE;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use thiserror::Error;

use super::wire::{EventObject, RefundStatus, StripeEvent};
use crate::auth::{hex, mac};

/// How far `t` may be from now, either way: five minutes, as Stripe's libraries use.
pub const TOLERANCE_S: i64 = 300;

/// Why a webhook was refused. Each answers 400 and is logged by [`WebhookError::reason`] alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum WebhookError {
    /// No header, a malformed one, or no `v1` that matches.
    #[error("bad signature")]
    Signature,
    /// Signed, but `t` is outside the tolerance.
    #[error("timestamp outside the tolerance")]
    Timestamp,
    /// Signed, but not an event this parser reads.
    #[error("unreadable body")]
    Body,
    /// An event from the other mode. The bakery's account has only its sandbox wired up, so this
    /// is a misconfiguration, and it is refused whatever it says.
    #[error("not a test-mode event")]
    Livemode,
}

impl WebhookError {
    pub fn reason(self) -> &'static str {
        match self {
            WebhookError::Signature => "signature",
            WebhookError::Timestamp => "timestamp",
            WebhookError::Body => "body",
            WebhookError::Livemode => "livemode",
        }
    }
}

/// The header's `t` as written and every `v1`, or `None` when either is missing.
fn parse_header(header: &str) -> Option<(&str, Vec<&str>)> {
    let mut t = None;
    let mut v1 = Vec::new();
    for item in header.split(',') {
        let Some((k, v)) = item.trim().split_once('=') else {
            continue;
        };
        match k {
            "t" if t.is_none() => t = Some(v),
            "v1" => v1.push(v),
            _ => {}
        }
    }
    let t = t.filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))?;
    (!v1.is_empty()).then_some((t, v1))
}

/// The signed payload, `"<t>.<body>"`.
fn signed_payload(t: &str, body: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(t.len() + 1 + body.len());
    payload.extend_from_slice(t.as_bytes());
    payload.push(b'.');
    payload.extend_from_slice(body);
    payload
}

/// Checks `Stripe-Signature` on the raw body. `now` is wall time in Unix seconds, from the
/// `Clock` port; `tolerance_s` is [`TOLERANCE_S`] outside tests.
pub fn verify_signature(
    header: &str,
    body: &[u8],
    secret: &str,
    now: i64,
    tolerance_s: i64,
) -> Result<(), WebhookError> {
    let (t, candidates) = parse_header(header).ok_or(WebhookError::Signature)?;
    let payload = signed_payload(t, body);
    // Every candidate is checked, so the time taken does not say which one matched.
    let matched = candidates
        .iter()
        .map(|v1| {
            let Ok(sig) = HEXLOWER_PERMISSIVE.decode(v1.as_bytes()) else {
                return false;
            };
            let mut m = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
                .expect("HMAC takes any key length");
            m.update(&payload);
            m.verify_slice(&sig).is_ok()
        })
        .fold(false, |any, ok| any | ok);
    if !matched {
        return Err(WebhookError::Signature);
    }
    let t: i64 = t.parse().map_err(|_| WebhookError::Signature)?;
    if now.abs_diff(t) > tolerance_s.unsigned_abs() {
        return Err(WebhookError::Timestamp);
    }
    Ok(())
}

/// A `Stripe-Signature` header for `body` at `t`, as Stripe writes it: what a test, or a fake of
/// Stripe, sends.
pub fn signature_header(secret: &str, t: i64, body: &[u8]) -> String {
    let t = t.to_string();
    let sig = mac(secret.as_bytes(), &signed_payload(&t, body));
    format!("t={t},v1={}", hex(&sig))
}

/// Parses a verified body.
pub fn parse_event(body: &[u8]) -> Result<StripeEvent, WebhookError> {
    serde_json::from_slice(body).map_err(|_| WebhookError::Body)
}

impl StripeEvent {
    /// Refuses an event from the other mode, whatever else it says.
    pub fn require_test(&self) -> Result<&StripeEvent, WebhookError> {
        if self.livemode {
            Err(WebhookError::Livemode)
        } else {
            Ok(self)
        }
    }

    /// The sandbox the object's metadata names: where the Worker routes the event. `None` for
    /// an object the bakery did not create.
    pub fn sandbox(&self) -> Option<Ulid> {
        self.data.object.metadata()?.get("sandbox")?.parse().ok()
    }

    /// What Billing reads from the event, or `None` for an event it has no use for, which is
    /// acknowledged and dropped. `charge.refunded` is one: the refund it reports also arrives as
    /// `refund.created` (or `refund.updated`, once a pending refund succeeds), which names the
    /// refund and its request, and as the gateway's own answer.
    pub fn billing_kind(&self) -> Option<WebhookKind> {
        match (&self.data.object, self.event_type.as_str()) {
            (EventObject::PaymentIntent(pi), "payment_intent.succeeded") => {
                Some(WebhookKind::Succeeded {
                    intent: pi.id.clone(),
                    amount: Cents(pi.amount),
                })
            }
            (EventObject::PaymentIntent(pi), "payment_intent.payment_failed") => {
                Some(WebhookKind::Failed {
                    intent: pi.id.clone(),
                    code: pi
                        .last_payment_error
                        .as_ref()
                        .map_or_else(|| "unknown".to_owned(), |e| e.best_code()),
                })
            }
            (EventObject::PaymentIntent(pi), "payment_intent.canceled") => {
                Some(WebhookKind::Canceled {
                    intent: pi.id.clone(),
                })
            }
            (EventObject::Refund(r), "refund.created" | "refund.updated")
                if r.status == RefundStatus::Succeeded =>
            {
                Some(WebhookKind::Refunded {
                    intent: r.payment_intent.clone()?,
                    refund: r.id.clone(),
                    amount: Cents(r.amount),
                    request: r.metadata.get("refund").and_then(|id| id.parse().ok()),
                })
            }
            _ => None,
        }
    }

    /// The `ApplyEvent` command for Billing, keyed by the event's id.
    pub fn billing_command(&self) -> Option<BillingCommand> {
        Some(BillingCommand::ApplyEvent {
            event_id: self.id.clone(),
            kind: self.billing_kind()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "whsec_fake0000000000000000000000000000";
    const NOW: i64 = 1_793_900_000;
    const BODY: &[u8] = br#"{"id":"evt_fake_1","object":"event","type":"payment_intent.succeeded","livemode":false,"created":1793900000,"data":{"object":{"id":"pi_fake_1","object":"payment_intent","amount":2090,"currency":"usd","status":"succeeded","metadata":{"sandbox":"01JC8YV2D4QK7S1M9E3PZ6W8AN","purpose":"order"},"livemode":false}}}"#;

    fn v1(secret: &str, t: i64, body: &[u8]) -> String {
        let mut m = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        m.update(format!("{t}.").as_bytes());
        m.update(body);
        HEXLOWER_PERMISSIVE.encode(&m.finalize().into_bytes())
    }

    #[test]
    fn the_header_is_hmac_sha256_of_t_dot_body_in_lower_hex() {
        // The known answer, made here with the same crates over "<t>.<body>".
        let header = signature_header(SECRET, NOW, BODY);
        let expected = v1(SECRET, NOW, BODY);
        assert_eq!(header, format!("t={NOW},v1={expected}"));
        assert_eq!(expected.len(), 64);
        assert!(
            expected
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        );
        // A fixed vector, computed outside Rust (Python's hmac module) over
        // `1793900000.{"id":"evt_fake_1"}`, so the payload's shape is pinned as well as the MAC.
        assert_eq!(
            signature_header(SECRET, NOW, br#"{"id":"evt_fake_1"}"#),
            "t=1793900000,v1=66f122a56bb68e2f54f00112ed40f405f50826e6f4d016574cd239b33d8875ff"
        );
        assert_eq!(
            verify_signature(&header, BODY, SECRET, NOW, TOLERANCE_S),
            Ok(())
        );
    }

    #[test]
    fn a_body_changed_by_one_byte_is_refused() {
        let header = signature_header(SECRET, NOW, BODY);
        for i in [0, BODY.len() / 2, BODY.len() - 1] {
            let mut tampered = BODY.to_vec();
            tampered[i] ^= 0x01;
            assert_eq!(
                verify_signature(&header, &tampered, SECRET, NOW, TOLERANCE_S),
                Err(WebhookError::Signature),
                "byte {i}"
            );
        }
        // So is a signature changed by one hex digit, the wrong secret, and a moved `t`.
        let mut sig = header.clone();
        let last = sig.pop().unwrap();
        sig.push(if last == '0' { '1' } else { '0' });
        assert_eq!(
            verify_signature(&sig, BODY, SECRET, NOW, TOLERANCE_S),
            Err(WebhookError::Signature)
        );
        assert_eq!(
            verify_signature(&header, BODY, "whsec_fake_other", NOW, TOLERANCE_S),
            Err(WebhookError::Signature)
        );
        let moved = header.replacen(&format!("t={NOW}"), &format!("t={}", NOW + 1), 1);
        assert_eq!(
            verify_signature(&moved, BODY, SECRET, NOW, TOLERANCE_S),
            Err(WebhookError::Signature)
        );
    }

    #[test]
    fn the_timestamp_must_be_within_five_minutes_either_way() {
        for (offset, ok) in [
            (-360, false),
            (-301, false),
            (-300, true),
            (-240, true),
            (0, true),
            (240, true),
            (300, true),
            (301, false),
            (360, false),
        ] {
            let t = NOW + offset;
            let header = signature_header(SECRET, t, BODY);
            let expected = if ok {
                Ok(())
            } else {
                Err(WebhookError::Timestamp)
            };
            assert_eq!(
                verify_signature(&header, BODY, SECRET, NOW, TOLERANCE_S),
                expected,
                "t off by {offset} s"
            );
        }
    }

    #[test]
    fn one_matching_v1_among_several_is_enough() {
        let good = v1(SECRET, NOW, BODY);
        let stale = v1("whsec_fake_previous", NOW, BODY);
        for header in [
            format!("t={NOW},v1={stale},v1={good}"),
            format!("t={NOW},v1={good},v1={stale}"),
            format!("t={NOW}, v0=abc, v1={stale}, v1={}", good.to_uppercase()),
        ] {
            assert_eq!(
                verify_signature(&header, BODY, SECRET, NOW, TOLERANCE_S),
                Ok(()),
                "{header}"
            );
        }
        assert_eq!(
            verify_signature(
                &format!("t={NOW},v1={stale},v1={stale}"),
                BODY,
                SECRET,
                NOW,
                TOLERANCE_S
            ),
            Err(WebhookError::Signature)
        );
    }

    #[test]
    fn malformed_headers_are_signature_failures() {
        let good = v1(SECRET, NOW, BODY);
        for header in [
            String::new(),
            "garbage".to_owned(),
            format!("v1={good}"),
            format!("t={NOW}"),
            format!("t=,v1={good}"),
            format!("t=-{NOW},v1={good}"),
            format!("t={NOW}x,v1={good}"),
            format!("t={NOW},v1=zz{}", &good[2..]),
            format!("t={NOW},v1={}", &good[..62]),
            format!("t=99999999999999999999,v1={good}"),
        ] {
            assert_eq!(
                verify_signature(&header, BODY, SECRET, NOW, TOLERANCE_S),
                Err(WebhookError::Signature),
                "{header:?}"
            );
        }
    }

    #[test]
    fn parsing_reads_the_sandbox_and_refuses_the_other_mode() {
        let event = parse_event(BODY).unwrap();
        assert_eq!(
            event.require_test().map(|e| e.id.as_str()),
            Ok("evt_fake_1")
        );
        assert_eq!(
            event.sandbox().unwrap().to_string(),
            "01JC8YV2D4QK7S1M9E3PZ6W8AN"
        );
        assert_eq!(
            event.billing_command(),
            Some(BillingCommand::ApplyEvent {
                event_id: "evt_fake_1".into(),
                kind: WebhookKind::Succeeded {
                    intent: "pi_fake_1".into(),
                    amount: Cents(2_090)
                }
            })
        );
        let live = String::from_utf8(BODY.to_vec()).unwrap().replacen(
            r#""livemode":false"#,
            r#""livemode":true"#,
            1,
        );
        let live = parse_event(live.as_bytes()).unwrap();
        assert_eq!(live.require_test().unwrap_err(), WebhookError::Livemode);
        assert_eq!(WebhookError::Livemode.reason(), "livemode");
        assert_eq!(parse_event(b"not json"), Err(WebhookError::Body));
        assert_eq!(
            parse_event(br#"{"id":"evt_fake_1"}"#),
            Err(WebhookError::Body)
        );
    }

    fn event(event_type: &str, object: &str) -> StripeEvent {
        parse_event(
            format!(
                r#"{{"id":"evt_fake_9","type":"{event_type}","livemode":false,"created":1,"data":{{"object":{object}}}}}"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn each_event_type_becomes_its_billing_kind() {
        let pi = |status: &str, extra: &str| {
            format!(
                r#"{{"id":"pi_fake_1","object":"payment_intent","amount":2090,"currency":"usd","status":"{status}","livemode":false{extra}}}"#
            )
        };
        assert_eq!(
            event(
                "payment_intent.payment_failed",
                &pi(
                    "requires_payment_method",
                    r#","last_payment_error":{"type":"card_error","code":"card_declined"}"#
                )
            )
            .billing_kind(),
            Some(WebhookKind::Failed {
                intent: "pi_fake_1".into(),
                code: "card_declined".into()
            })
        );
        assert_eq!(
            event("payment_intent.canceled", &pi("canceled", "")).billing_kind(),
            Some(WebhookKind::Canceled {
                intent: "pi_fake_1".into()
            })
        );
        let refund = |status: &str| {
            format!(
                r#"{{"id":"re_fake_1","object":"refund","amount":500,"status":"{status}","payment_intent":"pi_fake_1","metadata":{{"sandbox":"01JC8YV2D4QK7S1M9E3PZ6W8AN","refund":"01JC8Z6F1A5H3D7K9M2P4R6T8V"}}}}"#
            )
        };
        let created = event("refund.created", &refund("succeeded"));
        assert_eq!(
            created.billing_kind(),
            Some(WebhookKind::Refunded {
                intent: "pi_fake_1".into(),
                refund: "re_fake_1".into(),
                amount: Cents(500),
                request: Some("01JC8Z6F1A5H3D7K9M2P4R6T8V".parse().unwrap())
            })
        );
        assert!(created.sandbox().is_some());
        assert_eq!(
            event("refund.created", &refund("pending")).billing_kind(),
            None
        );
        assert!(
            event("refund.updated", &refund("succeeded"))
                .billing_kind()
                .is_some()
        );
        // Acknowledged and dropped.
        let charge = r#"{"id":"ch_fake_1","object":"charge","amount":2090,"amount_refunded":500,"refunded":false,"payment_intent":"pi_fake_1","metadata":{}}"#;
        assert_eq!(event("charge.refunded", charge).billing_kind(), None);
        assert_eq!(
            event("payment_intent.created", &pi("requires_payment_method", "")).billing_kind(),
            None
        );
        assert_eq!(
            event(
                "customer.created",
                r#"{"object":"customer","id":"cus_fake_1"}"#
            )
            .billing_command(),
            None
        );
        assert_eq!(
            event(
                "customer.created",
                r#"{"object":"customer","id":"cus_fake_1"}"#
            )
            .sandbox(),
            None
        );
    }
}
