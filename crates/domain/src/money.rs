//! Money is an integer count of US cents everywhere; rates are basis points (docs/domain.md,
//! "Money and time"). No floats.

use serde::{Deserialize, Serialize};

use crate::DomainError;

/// 10,000 basis points make the whole.
pub const BASIS_POINTS_WHOLE: u32 = 10_000;

/// An amount of US cents. On the wire it is a bare JSON integer in a field named `*_cents`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Cents(pub i64);

impl Cents {
    pub const ZERO: Cents = Cents(0);

    /// `self + other`, refused rather than wrapped.
    pub fn checked_add(self, other: Cents) -> Result<Cents, DomainError> {
        self.0
            .checked_add(other.0)
            .map(Cents)
            .ok_or(DomainError::Overflow)
    }

    /// `self - other`, refused rather than wrapped.
    pub fn checked_sub(self, other: Cents) -> Result<Cents, DomainError> {
        self.0
            .checked_sub(other.0)
            .map(Cents)
            .ok_or(DomainError::Overflow)
    }

    /// `self` times `bp` basis points, rounded half-up to the cent: the tax on a subtotal.
    ///
    /// Half-up means half away from zero, so a refund's tax mirrors its charge's.
    pub fn apply_bp(self, bp: u32) -> Result<Cents, DomainError> {
        let scaled = i128::from(self.0) * i128::from(bp);
        let rounded = round_half_away(scaled, i128::from(BASIS_POINTS_WHOLE));
        i64::try_from(rounded)
            .map(Cents)
            .map_err(|_| DomainError::Overflow)
    }

    /// Splits `self` into a part of `bp` basis points, rounded half-up, and the remainder.
    ///
    /// The remainder is computed, not rounded, so the two always sum to the total: a deposit and
    /// its balance always make the quote.
    pub fn split(self, bp: u32) -> Result<(Cents, Cents), DomainError> {
        if bp > BASIS_POINTS_WHOLE {
            return Err(DomainError::BasisPoints(bp));
        }
        // With bp <= 10,000 the part's magnitude never exceeds the total's, so neither the part
        // nor the remainder can overflow.
        let part = self.apply_bp(bp)?;
        let remainder = self.checked_sub(part)?;
        Ok((part, remainder))
    }
}

/// `n / d` rounded half away from zero, for `d > 0`.
fn round_half_away(n: i128, d: i128) -> i128 {
    let half = d / 2;
    if n >= 0 {
        (n + half) / d
    } else {
        -((-n + half) / d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn checked_add_refuses_overflow() {
        assert_eq!(Cents(1_870).checked_add(Cents(130)), Ok(Cents(2_000)));
        assert_eq!(
            Cents(i64::MAX).checked_add(Cents(1)),
            Err(DomainError::Overflow)
        );
        assert_eq!(
            Cents(i64::MIN).checked_sub(Cents(1)),
            Err(DomainError::Overflow)
        );
    }

    #[test]
    fn tax_rounds_half_up() {
        // 10.00% of $0.05 is 0.5 cents: rounds up to 1.
        assert_eq!(Cents(5).apply_bp(1_000), Ok(Cents(1)));
        // 10.00% of $0.04 is 0.4 cents: rounds down to 0.
        assert_eq!(Cents(4).apply_bp(1_000), Ok(Cents(0)));
        // 10.00% of $18.70 is exactly $1.87.
        assert_eq!(Cents(1_870).apply_bp(1_000), Ok(Cents(187)));
        // 8.25% of $12.34 is 101.805 cents: rounds to 102.
        assert_eq!(Cents(1_234).apply_bp(825), Ok(Cents(102)));
        // A refund mirrors its charge.
        assert_eq!(Cents(-5).apply_bp(1_000), Ok(Cents(-1)));
    }

    #[test]
    fn deposit_and_balance_sum_to_the_quote() {
        // The 25% deposit on a $1,234.57 quote is 30,864.25 cents: rounds to 30,864.
        assert_eq!(
            Cents(123_457).split(2_500),
            Ok((Cents(30_864), Cents(92_593)))
        );
        // 25% of 2 cents is 0.5: the part takes the half cent.
        assert_eq!(Cents(2).split(2_500), Ok((Cents(1), Cents(1))));
        assert_eq!(Cents(0).split(2_500), Ok((Cents(0), Cents(0))));
        assert_eq!(Cents(999).split(0), Ok((Cents(0), Cents(999))));
        assert_eq!(Cents(999).split(10_000), Ok((Cents(999), Cents(0))));
    }

    #[test]
    fn split_refuses_more_than_the_whole() {
        assert_eq!(
            Cents(100).split(10_001),
            Err(DomainError::BasisPoints(10_001))
        );
    }

    #[test]
    fn extreme_totals_split_without_overflow() {
        for total in [i64::MAX, i64::MIN, i64::MAX - 1, i64::MIN + 1] {
            let (part, rest) = Cents(total).split(5_000).unwrap();
            assert_eq!(part.checked_add(rest), Ok(Cents(total)));
        }
    }

    #[test]
    fn serializes_as_a_bare_integer() {
        assert_eq!(serde_json::to_string(&Cents(1_870)).unwrap(), "1870");
        assert_eq!(serde_json::from_str::<Cents>("1870").unwrap(), Cents(1_870));
    }

    proptest! {
        #[test]
        fn part_plus_remainder_is_the_total(total in any::<i64>(), bp in 0u32..=BASIS_POINTS_WHOLE) {
            let (part, remainder) = Cents(total).split(bp).unwrap();
            prop_assert_eq!(part.checked_add(remainder), Ok(Cents(total)));
        }

        #[test]
        fn the_part_is_within_half_a_cent_of_exact(total in -1_000_000_000i64..1_000_000_000, bp in 0u32..=BASIS_POINTS_WHOLE) {
            let (part, _) = Cents(total).split(bp).unwrap();
            let exact = i128::from(total) * i128::from(bp);
            let error = (i128::from(part.0) * 10_000 - exact).abs();
            prop_assert!(error <= 5_000);
        }
    }
}
