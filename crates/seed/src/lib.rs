//! Deterministic synthetic data for a sandbox (docs/domain.md, "The seed").
//!
//! A [`Seed`] drives a ChaCha20 PRNG, and the [`Generator`] draws from it in a fixed order, so
//! one seed gives the same output byte for byte on every machine. PR 2 generates the first
//! things only: persona display names, venue names and the menu's categories and items. Every
//! name is made up from generic words; none is a real person, business or address.

mod menu;
mod words;

use rand_chacha::ChaCha20Rng;
use rand_core::{Rng, SeedableRng};
use serde::Serialize;

pub use menu::{CATEGORIES, ITEMS};

/// The bakery's 60 regular customers.
pub const PERSONA_COUNT: usize = 60;
/// The six catering venues, `v1` to `v6`.
pub const VENUE_COUNT: usize = 6;

/// A sandbox's seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Seed(pub u64);

impl Seed {
    /// The PRNG for this seed. The 32-byte ChaCha key is the seed's little-endian bytes followed
    /// by zeros, written out here rather than left to `seed_from_u64`, so the stream cannot change
    /// under a `rand_core` upgrade.
    pub fn rng(self) -> ChaCha20Rng {
        let mut key = [0u8; 32];
        key[..8].copy_from_slice(&self.0.to_le_bytes());
        ChaCha20Rng::from_seed(key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Persona {
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Venue {
    /// `v1` to `v6`.
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Category {
    pub slug: &'static str,
    pub name: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub slug: &'static str,
    pub name: &'static str,
    pub category: &'static str,
}

/// Everything PR 2 generates for one seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Generated {
    pub seed: Seed,
    pub personas: Vec<Persona>,
    pub venues: Vec<Venue>,
    pub categories: Vec<Category>,
    pub items: Vec<Item>,
}

impl Generated {
    /// Pretty JSON with a trailing newline: the bytes the determinism check compares.
    pub fn to_json(&self) -> String {
        let mut out = serde_json::to_string_pretty(self).expect("plain data serializes");
        out.push('\n');
        out
    }
}

/// Draws a sandbox's synthetic things from one seed, always in the same order.
pub struct Generator {
    seed: Seed,
    rng: ChaCha20Rng,
}

impl Generator {
    pub fn new(seed: Seed) -> Generator {
        Generator {
            seed,
            rng: seed.rng(),
        }
    }

    /// Generates everything, consuming the generator so its draws cannot be reordered.
    pub fn generate(mut self) -> Generated {
        // The order of draws is part of the output: personas first, then venues.
        let personas = self
            .distinct_pairs(words::GIVEN, words::FAMILY, PERSONA_COUNT)
            .into_iter()
            .map(|display_name| Persona { display_name })
            .collect();
        let venues = self
            .distinct_pairs(words::VENUE_FIRST, words::VENUE_SECOND, VENUE_COUNT)
            .into_iter()
            .enumerate()
            .map(|(i, name)| Venue {
                id: format!("v{}", i + 1),
                name,
            })
            .collect();
        Generated {
            seed: self.seed,
            personas,
            venues,
            categories: CATEGORIES
                .iter()
                .map(|&(slug, name)| Category { slug, name })
                .collect(),
            items: ITEMS
                .iter()
                .map(|&(slug, name, category)| Item {
                    slug,
                    name,
                    category,
                })
                .collect(),
        }
    }

    /// `count` distinct "first second" names: a partial Fisher-Yates shuffle of every pair.
    fn distinct_pairs(&mut self, first: &[&str], second: &[&str], count: usize) -> Vec<String> {
        let mut pairs: Vec<(usize, usize)> = (0..first.len())
            .flat_map(|a| (0..second.len()).map(move |b| (a, b)))
            .collect();
        assert!(
            count <= pairs.len(),
            "word lists too short for {count} names"
        );
        for i in 0..count {
            let j = i + self.below(pairs.len() - i);
            pairs.swap(i, j);
        }
        pairs[..count]
            .iter()
            .map(|&(a, b)| format!("{} {}", first[a], second[b]))
            .collect()
    }

    /// A uniform draw from `0..n`, by rejection, so no value is favoured.
    fn below(&mut self, n: usize) -> usize {
        let n = n as u64;
        let zone = u64::MAX - u64::MAX % n;
        loop {
            let x = self.rng.next_u64();
            if x < zone {
                return (x % n) as usize;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn one_seed_gives_identical_bytes() {
        let a = Generator::new(Seed(42)).generate().to_json();
        let b = Generator::new(Seed(42)).generate().to_json();
        assert_eq!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn the_stream_for_a_seed_never_changes() {
        // Pinned output: a change here means a dependency or the draw order moved the stream,
        // and every sandbox born from a seed would change with it.
        let g = Generator::new(Seed(42)).generate();
        let first: Vec<&str> = g
            .personas
            .iter()
            .take(3)
            .map(|p| p.display_name.as_str())
            .collect();
        assert_eq!(first, ["Drizzle Trowel", "Cirrus Tombolo", "Sleet Anvil"]);
    }

    #[test]
    fn another_seed_gives_other_people() {
        let a = Generator::new(Seed(1)).generate();
        let b = Generator::new(Seed(2)).generate();
        assert_ne!(a.personas, b.personas);
        assert_eq!(a.items, b.items);
    }

    #[test]
    fn counts_match_the_domain() {
        let g = Generator::new(Seed(7)).generate();
        assert_eq!(g.personas.len(), PERSONA_COUNT);
        assert_eq!(g.venues.len(), VENUE_COUNT);
        assert_eq!(g.categories.len(), 5);
        assert_eq!(g.items.len(), 24);
        let ids: Vec<&str> = g.venues.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["v1", "v2", "v3", "v4", "v5", "v6"]);
    }

    #[test]
    fn names_are_distinct() {
        for seed in 0..50 {
            let g = Generator::new(Seed(seed)).generate();
            let names: HashSet<&str> = g.personas.iter().map(|p| p.display_name.as_str()).collect();
            assert_eq!(names.len(), PERSONA_COUNT);
            let venues: HashSet<&str> = g.venues.iter().map(|v| v.name.as_str()).collect();
            assert_eq!(venues.len(), VENUE_COUNT);
        }
    }

    #[test]
    fn every_item_is_in_a_known_category_and_slugs_are_unique() {
        let categories: HashSet<&str> = CATEGORIES.iter().map(|c| c.0).collect();
        let slugs: HashSet<&str> = ITEMS.iter().map(|i| i.0).collect();
        assert_eq!(slugs.len(), ITEMS.len());
        for (slug, _, category) in ITEMS {
            assert!(categories.contains(category), "{slug}");
            assert!(
                slug.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'),
                "{slug}"
            );
        }
    }

    #[test]
    fn word_lists_have_no_repeats() {
        for list in [
            words::GIVEN,
            words::FAMILY,
            words::VENUE_FIRST,
            words::VENUE_SECOND,
        ] {
            let set: HashSet<&str> = list.iter().copied().collect();
            assert_eq!(set.len(), list.len());
        }
    }
}
