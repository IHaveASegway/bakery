//! The Customer, hosted by `Customer`, one object per sandbox and persona
//! (`customer:<sandbox>:<ulid>`; docs/domain.md, "Ubiquitous language": Customer, Loyalty). It
//! protects one persona's consent flag and loyalty balance.
//!
//! The object is created on first touch from the seed's persona (docs/architecture.md, "Object
//! naming": children are born only through the Sandbox), so its first command is [`Register`]
//! with the persona's synthetic profile. The profile is the seed's fields and nothing else: a
//! display name made from two word lists, item slugs, a zone, a place label and the synthetic
//! billing line. No contact of any kind exists to hold (docs/product.md, Q22).
//!
//! Loyalty is earn-only for now: one point per whole dollar of a paid order, reversed in
//! proportion when the order is refunded, never below what the order earned, so the balance
//! never goes below zero. Redemption is later.
//!
//! [`Register`]: CustomerCommand::Register

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::{Cents, Ulid, check_free_text};

/// The longest display name, place label or billing line a profile may hold.
pub const PROFILE_TEXT_MAX_CHARS: usize = 64;

/// One point per this many cents: a whole dollar.
pub const CENTS_PER_POINT: i64 = 100;

/// A persona's synthetic profile, copied from the seed (docs/domain.md, "The seed": customers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Two generic words, such as a plant and a landform.
    pub display_name: String,
    /// One to three item slugs.
    pub preferences: Vec<String>,
    /// `z1` to `z3`.
    pub home_zone: String,
    /// `p1` to `p64`: a map label, the only delivery address there is.
    pub place: String,
    /// The synthetic billing line the Payment Element is given, `<place>, unit <n> (synthetic)`.
    pub billing_line: String,
}

impl Profile {
    /// Every text field short, plain and free of the four free-text classes: a seed bug cannot
    /// put something personal-looking into a Customer.
    fn check(&self) -> Result<(), CustomerError> {
        let texts = [
            self.display_name.as_str(),
            self.home_zone.as_str(),
            self.place.as_str(),
            self.billing_line.as_str(),
        ];
        let plain = |t: &str| {
            let n = t.chars().count();
            (1..=PROFILE_TEXT_MAX_CHARS).contains(&n)
                && !t.chars().any(char::is_control)
                && check_free_text(t).is_ok()
        };
        let slug = |t: &str| {
            !t.is_empty()
                && t.len() <= PROFILE_TEXT_MAX_CHARS
                && t.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        };
        if texts.into_iter().all(plain)
            && (1..=3).contains(&self.preferences.len())
            && self.preferences.iter().all(|p| slug(p))
        {
            Ok(())
        } else {
            Err(CustomerError::BadProfile)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomerCommand {
    /// First touch, from the seed's persona. A repeat is a no-op.
    Register {
        customer: Ulid,
        profile: Profile,
        /// The persona's consent flag at seed.
        marketing: bool,
        /// The seed's balance, from the persona's closed history.
        opening_points: u32,
    },
    /// Staff or the customer. Unchanged is a no-op.
    SetConsent { marketing: bool },
    /// From `OrderPaid`: `amount / 100` points, once per order.
    EarnPoints { order: Ulid, amount: Cents },
    /// From `OrderRefunded`: the refunded amount's points back, once per refund, never more
    /// than the order earned. `full` takes back all the order has left.
    ReversePoints {
        order: Ulid,
        refund: Ulid,
        amount: Cents,
        full: bool,
    },
}

/// Customer's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CustomerEvent {
    /// The object's first event: the persona as the seed made it. Not routed; Crm holds the
    /// same roster from the seed.
    CustomerRegistered {
        customer: Ulid,
        profile: Profile,
        marketing: bool,
        opening_points: u32,
    },
    ConsentChanged {
        marketing: bool,
    },
    /// `points` is negative for a reversal, which names its `refund`.
    LoyaltyPointsEarned {
        order: Ulid,
        points: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refund: Option<Ulid>,
    },
}

impl DomainEvent for CustomerEvent {
    const NAMES: &'static [&'static str] = &[
        "CustomerRegistered",
        "ConsentChanged",
        "LoyaltyPointsEarned",
    ];

    fn name(&self) -> &'static str {
        match self {
            CustomerEvent::CustomerRegistered { .. } => "CustomerRegistered",
            CustomerEvent::ConsentChanged { .. } => "ConsentChanged",
            CustomerEvent::LoyaltyPointsEarned { .. } => "LoyaltyPointsEarned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CustomerError {
    #[error("the customer has not been registered")]
    NotRegistered,
    #[error("a profile holds short plain text and one to three item slugs")]
    BadProfile,
    #[error("an amount is zero or more cents")]
    BadAmount,
    #[error("points out of range")]
    Overflow,
}

impl CustomerError {
    /// The slug of the rule, for the problem's type.
    pub fn rule(&self) -> &'static str {
        match self {
            CustomerError::NotRegistered => "not-registered",
            CustomerError::BadProfile => "profile",
            CustomerError::BadAmount => "amount",
            CustomerError::Overflow => "overflow",
        }
    }
}

/// The fold of a Customer's events.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerState {
    customer: Option<Ulid>,
    profile: Option<Profile>,
    marketing: bool,
    opening: i64,
    balance: i64,
    /// Points each order earned, and how many of them have been taken back.
    earned: BTreeMap<Ulid, i64>,
    reversed: BTreeMap<Ulid, i64>,
    /// `(order, refund)` pairs already reversed.
    refunds: BTreeSet<(Ulid, Ulid)>,
}

impl CustomerState {
    pub fn customer(&self) -> Option<Ulid> {
        self.customer
    }

    pub fn profile(&self) -> Option<&Profile> {
        self.profile.as_ref()
    }

    pub fn marketing(&self) -> bool {
        self.marketing
    }

    /// The loyalty balance: the opening points plus every earn and reversal.
    pub fn balance(&self) -> i64 {
        self.balance
    }

    /// The points `order` still holds: what it earned minus what was taken back.
    pub fn order_points(&self, order: Ulid) -> i64 {
        self.earned.get(&order).copied().unwrap_or(0)
            - self.reversed.get(&order).copied().unwrap_or(0)
    }

    fn registered(&self) -> Result<(), CustomerError> {
        if self.profile.is_some() {
            Ok(())
        } else {
            Err(CustomerError::NotRegistered)
        }
    }
}

pub struct Customer;

impl Aggregate for Customer {
    type State = CustomerState;
    type Command = CustomerCommand;
    type Event = CustomerEvent;
    type Error = CustomerError;

    fn decide(
        state: &CustomerState,
        cmd: &CustomerCommand,
        _ctx: &DecideContext,
    ) -> Result<Vec<CustomerEvent>, CustomerError> {
        match cmd {
            CustomerCommand::Register {
                customer,
                profile,
                marketing,
                opening_points,
            } => {
                if state.profile.is_some() {
                    return Ok(vec![]);
                }
                profile.check()?;
                Ok(vec![CustomerEvent::CustomerRegistered {
                    customer: *customer,
                    profile: profile.clone(),
                    marketing: *marketing,
                    opening_points: *opening_points,
                }])
            }
            CustomerCommand::SetConsent { marketing } => {
                state.registered()?;
                if state.marketing == *marketing {
                    return Ok(vec![]);
                }
                Ok(vec![CustomerEvent::ConsentChanged {
                    marketing: *marketing,
                }])
            }
            CustomerCommand::EarnPoints { order, amount } => {
                state.registered()?;
                if amount.0 < 0 {
                    return Err(CustomerError::BadAmount);
                }
                // An order earns once; an order under a dollar earns nothing and records
                // nothing, so its repeat is a no-op too.
                let points = amount.0 / CENTS_PER_POINT;
                if state.earned.contains_key(order) || points == 0 {
                    return Ok(vec![]);
                }
                let points = i32::try_from(points).map_err(|_| CustomerError::Overflow)?;
                Ok(vec![CustomerEvent::LoyaltyPointsEarned {
                    order: *order,
                    points,
                    refund: None,
                }])
            }
            CustomerCommand::ReversePoints {
                order,
                refund,
                amount,
                full,
            } => {
                state.registered()?;
                if amount.0 < 0 {
                    return Err(CustomerError::BadAmount);
                }
                if state.refunds.contains(&(*order, *refund)) {
                    return Ok(vec![]);
                }
                let left = state.order_points(*order);
                let n = if *full {
                    left
                } else {
                    (amount.0 / CENTS_PER_POINT).min(left)
                };
                // Nothing to take back (an order that earned nothing, or a refund under a
                // dollar) changes nothing, so it needs no record to stay idempotent.
                if n <= 0 {
                    return Ok(vec![]);
                }
                let n = i32::try_from(n).map_err(|_| CustomerError::Overflow)?;
                Ok(vec![CustomerEvent::LoyaltyPointsEarned {
                    order: *order,
                    points: -n,
                    refund: Some(*refund),
                }])
            }
        }
    }

    fn evolve(mut state: CustomerState, event: &CustomerEvent) -> CustomerState {
        match event {
            CustomerEvent::CustomerRegistered {
                customer,
                profile,
                marketing,
                opening_points,
            } => {
                if state.profile.is_none() {
                    state.customer = Some(*customer);
                    state.profile = Some(profile.clone());
                    state.marketing = *marketing;
                    state.opening = i64::from(*opening_points);
                    state.balance += state.opening;
                }
            }
            CustomerEvent::ConsentChanged { marketing } => state.marketing = *marketing,
            CustomerEvent::LoyaltyPointsEarned {
                order,
                points,
                refund,
            } => {
                let points = i64::from(*points);
                match refund {
                    None => {
                        if state.earned.contains_key(order) {
                            return state;
                        }
                        state.earned.insert(*order, points);
                    }
                    Some(refund) => {
                        if !state.refunds.insert((*order, *refund)) {
                            return state;
                        }
                        *state.reversed.entry(*order).or_insert(0) -= points;
                    }
                }
                state.balance += points;
            }
        }
        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Envelope, WallTime, execute, replay};
    use proptest::prelude::*;

    fn ulid(n: u128) -> Ulid {
        Ulid::from_parts(1_793_000_000_000, n)
    }

    fn ctx() -> DecideContext {
        DecideContext {
            now: "2026-11-07T09:00:00-07:00".parse().unwrap(),
            id: ulid(999),
        }
    }

    fn profile() -> Profile {
        Profile {
            display_name: "Drizzle Trowel".into(),
            preferences: vec!["croissant".into(), "seeded-rye".into()],
            home_zone: "z2".into(),
            place: "p9".into(),
            billing_line: "p9, unit 1 (synthetic)".into(),
        }
    }

    fn register(opening: u32) -> CustomerCommand {
        CustomerCommand::Register {
            customer: ulid(1),
            profile: profile(),
            marketing: true,
            opening_points: opening,
        }
    }

    /// Runs commands from empty, keeping every event.
    fn run(cmds: &[CustomerCommand]) -> (CustomerState, Vec<CustomerEvent>) {
        let mut state = CustomerState::default();
        let mut log = Vec::new();
        for cmd in cmds {
            if let Ok((next, events)) = execute::<Customer>(state.clone(), cmd, &ctx()) {
                state = next;
                log.extend(events);
            }
        }
        (state, log)
    }

    #[test]
    fn register_once_then_repeats_are_no_ops() {
        let (state, log) = run(&[register(12), register(99)]);
        assert_eq!(log.len(), 1);
        assert_eq!(state.balance(), 12);
        assert!(state.marketing());
        assert_eq!(state.profile(), Some(&profile()));
    }

    #[test]
    fn a_profile_that_looks_personal_is_refused() {
        let mut bad = profile();
        bad.display_name = "call 555 0100 123".into();
        let cmd = CustomerCommand::Register {
            customer: ulid(1),
            profile: bad,
            marketing: true,
            opening_points: 0,
        };
        assert_eq!(
            Customer::decide(&CustomerState::default(), &cmd, &ctx()),
            Err(CustomerError::BadProfile)
        );
    }

    #[test]
    fn nothing_but_register_before_registering() {
        let cmd = CustomerCommand::SetConsent { marketing: false };
        assert_eq!(
            Customer::decide(&CustomerState::default(), &cmd, &ctx()),
            Err(CustomerError::NotRegistered)
        );
    }

    #[test]
    fn consent_changes_only_when_it_changes() {
        let (state, log) = run(&[
            register(0),
            CustomerCommand::SetConsent { marketing: true },
            CustomerCommand::SetConsent { marketing: false },
            CustomerCommand::SetConsent { marketing: false },
        ]);
        assert!(!state.marketing());
        assert_eq!(
            log[1..],
            [CustomerEvent::ConsentChanged { marketing: false }]
        );
    }

    #[test]
    fn points_are_whole_dollars_once_per_order() {
        let earn = CustomerCommand::EarnPoints {
            order: ulid(5),
            amount: Cents(2_099),
        };
        let (state, log) = run(&[register(3), earn.clone(), earn]);
        assert_eq!(state.balance(), 3 + 20);
        assert_eq!(
            log[1..],
            [CustomerEvent::LoyaltyPointsEarned {
                order: ulid(5),
                points: 20,
                refund: None
            }]
        );
    }

    #[test]
    fn a_refund_takes_back_its_points_and_never_more_than_the_order_earned() {
        let order = ulid(5);
        let (state, log) = run(&[
            register(0),
            CustomerCommand::EarnPoints {
                order,
                amount: Cents(2_500),
            },
            // $9.99 back: 9 points.
            CustomerCommand::ReversePoints {
                order,
                refund: ulid(6),
                amount: Cents(999),
                full: false,
            },
            // The same refund again: nothing.
            CustomerCommand::ReversePoints {
                order,
                refund: ulid(6),
                amount: Cents(999),
                full: false,
            },
            // More than is left: only what is left.
            CustomerCommand::ReversePoints {
                order,
                refund: ulid(7),
                amount: Cents(5_000),
                full: false,
            },
            CustomerCommand::ReversePoints {
                order,
                refund: ulid(8),
                amount: Cents(100),
                full: true,
            },
        ]);
        assert_eq!(state.balance(), 0);
        assert_eq!(state.order_points(order), 0);
        let points: Vec<i32> = log
            .iter()
            .filter_map(|e| match e {
                CustomerEvent::LoyaltyPointsEarned { points, .. } => Some(*points),
                _ => None,
            })
            .collect();
        assert_eq!(points, [25, -9, -16]);
    }

    #[test]
    fn every_event_round_trips_through_an_envelope() {
        let (_, log) = run(&[
            register(4),
            CustomerCommand::SetConsent { marketing: false },
            CustomerCommand::EarnPoints {
                order: ulid(5),
                amount: Cents(1_000),
            },
            CustomerCommand::ReversePoints {
                order: ulid(5),
                refund: ulid(6),
                amount: Cents(500),
                full: false,
            },
        ]);
        assert_eq!(log.len(), 4);
        for (i, event) in log.iter().enumerate() {
            let envelope = Envelope {
                v: 1,
                id: ulid(100 + i as u128),
                sandbox: ulid(7),
                stream: format!("customer:{}:{}", ulid(7), ulid(1)),
                seq: i as u64 + 1,
                event_type: event.name().to_owned(),
                at: ctx().now,
                recorded_at: WallTime::from_unix_ms(1_793_000_000_000).unwrap(),
                data: event.to_data(),
                cause: None,
            };
            let text = serde_json::to_string(&envelope).unwrap();
            let back: Envelope = serde_json::from_str(&text).unwrap();
            assert_eq!(&CustomerEvent::from_envelope(&back).unwrap(), event);
        }
        // An earn writes no `refund` at all, as the catalog's row has it.
        assert_eq!(
            log[2].to_data(),
            serde_json::json!({ "order": ulid(5).to_string(), "points": 10 })
        );
    }

    fn command() -> impl Strategy<Value = CustomerCommand> {
        prop_oneof![
            any::<bool>().prop_map(|marketing| CustomerCommand::SetConsent { marketing }),
            (1u128..5, 0i64..10_000).prop_map(|(o, a)| CustomerCommand::EarnPoints {
                order: ulid(o),
                amount: Cents(a),
            }),
            (1u128..5, 10u128..14, 0i64..10_000, any::<bool>()).prop_map(|(o, r, a, full)| {
                CustomerCommand::ReversePoints {
                    order: ulid(o),
                    refund: ulid(r),
                    amount: Cents(a),
                    full,
                }
            }),
        ]
    }

    proptest! {
        /// The balance is the fold of the log; a command applied again straight after itself
        /// (a redelivery) changes nothing; and the balance never goes below zero.
        #[test]
        fn the_balance_is_the_fold_and_never_negative(
            opening in 0u32..50,
            cmds in proptest::collection::vec(command(), 0..40),
        ) {
            let mut state = CustomerState::default();
            let mut log = Vec::new();
            for cmd in std::iter::once(register(opening)).chain(cmds) {
                let (next, events) = execute::<Customer>(state, &cmd, &ctx()).unwrap();
                state = next;
                log.extend(events);
                let again = Customer::decide(&state, &cmd, &ctx()).unwrap();
                prop_assert!(again.is_empty(), "{:?} again gave {:?}", cmd, again);
                prop_assert!(state.balance() >= 0);
            }
            prop_assert_eq!(&replay::<Customer>(&log), &state);
            let sum: i64 = i64::from(opening) + log.iter().map(|e| match e {
                CustomerEvent::LoyaltyPointsEarned { points, .. } => i64::from(*points),
                _ => 0,
            }).sum::<i64>();
            prop_assert_eq!(state.balance(), sum);
        }
    }
}
