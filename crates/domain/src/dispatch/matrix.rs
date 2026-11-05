//! The travel-time matrix the savings heuristic and the validator read (ADR 0012, decision 7):
//! whole minutes of driving between every ordered pair of places, and which place is the bakery.
//!
//! A place is an index, `0` to `n - 1`, with a label, `p1` to `pn` for the seed's 64 (docs/domain.md,
//! "Identifiers"). The matrix holds no coordinate, no street and no name: the labels are the
//! only text, and a screen shows a customer's made-up address, never the place.
//!
//! Two sources:
//!
//! - [`TravelMatrix::from_json`] reads the committed fixture spike S7 builds for Salt Lake City,
//!   `crates/seed/data/<city>/matrix.json`, the same JSON the dispatch screen loads as a static
//!   asset. Its shape:
//!
//!   ```json
//!   {
//!     "city": "salt-lake-city",
//!     "built": "2026-11-12",
//!     "source": "OpenStreetMap contributors (ODbL), OSRM car profile",
//!     "depot": 0,
//!     "places": [{ "index": 0, "label": "p1" }, { "index": 1, "label": "p2" }],
//!     "minutes": [[0, 7], [8, 0]]
//!   }
//!   ```
//!
//!   `places` lists every index once, in order; `minutes[i][j]` is the drive from place `i` to
//!   place `j`, so a row per place and a column per place, with zeros on the diagonal. Road
//!   times need not be symmetric (one-way streets), and the heuristic does not assume they are.
//!   `depot` is the bakery's index and may be left out, meaning `0`. Fields the reader does not
//!   know are ignored, so the build may add its own.
//! - [`TravelMatrix::synthetic`], for tests and for the seed until the fixture lands: places
//!   scattered on a plane by a PRNG seeded from the sandbox's seed, the bakery in the middle,
//!   minutes from the straight-line distance, 2 to 40, symmetric. It draws from its own stream,
//!   never the seed's ChaCha generator, so no pinned value moves.

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::inbox::mix;

/// A place's index in the matrix: `0` to `n - 1`. The seed's label for index `i` is `p{i + 1}`.
pub type PlaceIndex = u8;

/// The most places a matrix can hold: every index fits a [`PlaceIndex`].
pub const MAX_PLACES: usize = 256;

/// The fewest and most minutes [`TravelMatrix::synthetic`] puts between two places.
pub const SYNTHETIC_MINUTES: (u32, u32) = (2, 40);

/// The label the seed gives place `index`: `p1` for index 0.
pub fn place_label(index: PlaceIndex) -> String {
    format!("p{}", u16::from(index) + 1)
}

/// The place a seed label names: `p17` is index 16. `None` for anything else.
pub fn place_index(label: &str) -> Option<PlaceIndex> {
    let n: u16 = label.strip_prefix('p')?.parse().ok()?;
    if label.len() > 1 && label.as_bytes()[1] == b'0' {
        return None;
    }
    PlaceIndex::try_from(n.checked_sub(1)?).ok()
}

/// One place as the fixture lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixPlace {
    pub index: PlaceIndex,
    pub label: String,
}

/// Why a matrix could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MatrixError {
    #[error("the matrix is not JSON of the fixture's shape: {0}")]
    Json(String),
    #[error("a matrix needs 1 to {MAX_PLACES} places, not {0}")]
    Size(usize),
    #[error("place {position} is listed with index {index}; places are listed in index order")]
    PlaceOrder { position: usize, index: PlaceIndex },
    #[error("place {0} has an empty label")]
    Label(PlaceIndex),
    #[error("{rows} rows of minutes for {places} places")]
    Rows { rows: usize, places: usize },
    #[error("row {row} has {len} columns for {places} places")]
    Columns {
        row: usize,
        len: usize,
        places: usize,
    },
    #[error("place {0} is not 0 minutes from itself")]
    Diagonal(usize),
    #[error("the depot {depot} is not one of the {places} places")]
    Depot { depot: PlaceIndex, places: usize },
}

/// The file the fixture and the static asset share; [`TravelMatrix::to_json`] writes it back.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MatrixFile {
    city: String,
    built: String,
    source: String,
    #[serde(default)]
    depot: PlaceIndex,
    places: Vec<MatrixPlace>,
    minutes: Vec<Vec<u32>>,
}

/// Minutes between every ordered pair of `n` places, and the bakery's place.
#[derive(Clone, PartialEq, Eq)]
pub struct TravelMatrix {
    city: String,
    built: String,
    source: String,
    depot: PlaceIndex,
    labels: Vec<String>,
    /// Row-major, `n * n`.
    minutes: Vec<u32>,
    symmetric: bool,
}

impl fmt::Debug for TravelMatrix {
    // 4,096 numbers would bury every assertion that prints a command holding one.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TravelMatrix")
            .field("city", &self.city)
            .field("built", &self.built)
            .field("places", &self.labels.len())
            .field("depot", &self.depot)
            .finish_non_exhaustive()
    }
}

impl TravelMatrix {
    /// A matrix from its rows, checked as [`TravelMatrix::from_json`] checks the fixture. The
    /// labels are the seed's, `p1` to `pn`.
    pub fn new(rows: Vec<Vec<u32>>, depot: PlaceIndex) -> Result<TravelMatrix, MatrixError> {
        let places = (0..rows.len())
            .map(|i| MatrixPlace {
                index: PlaceIndex::try_from(i).unwrap_or(PlaceIndex::MAX),
                label: place_label(PlaceIndex::try_from(i).unwrap_or(PlaceIndex::MAX)),
            })
            .collect();
        TravelMatrix::checked(MatrixFile {
            city: "test".to_owned(),
            built: "test".to_owned(),
            source: "rows".to_owned(),
            depot,
            places,
            minutes: rows,
        })
    }

    /// The fixture's JSON, in the shape the module documents.
    pub fn from_json(text: &str) -> Result<TravelMatrix, MatrixError> {
        let file: MatrixFile =
            serde_json::from_str(text).map_err(|e| MatrixError::Json(e.to_string()))?;
        TravelMatrix::checked(file)
    }

    fn checked(file: MatrixFile) -> Result<TravelMatrix, MatrixError> {
        let n = file.places.len();
        if n == 0 || n > MAX_PLACES {
            return Err(MatrixError::Size(n));
        }
        for (position, place) in file.places.iter().enumerate() {
            if usize::from(place.index) != position {
                return Err(MatrixError::PlaceOrder {
                    position,
                    index: place.index,
                });
            }
            if place.label.trim().is_empty() {
                return Err(MatrixError::Label(place.index));
            }
        }
        if file.minutes.len() != n {
            return Err(MatrixError::Rows {
                rows: file.minutes.len(),
                places: n,
            });
        }
        let mut minutes = Vec::with_capacity(n * n);
        for (row, cells) in file.minutes.iter().enumerate() {
            if cells.len() != n {
                return Err(MatrixError::Columns {
                    row,
                    len: cells.len(),
                    places: n,
                });
            }
            if cells[row] != 0 {
                return Err(MatrixError::Diagonal(row));
            }
            minutes.extend_from_slice(cells);
        }
        if usize::from(file.depot) >= n {
            return Err(MatrixError::Depot {
                depot: file.depot,
                places: n,
            });
        }
        let symmetric = (0..n).all(|i| (0..i).all(|j| minutes[i * n + j] == minutes[j * n + i]));
        Ok(TravelMatrix {
            city: file.city,
            built: file.built,
            source: file.source,
            depot: file.depot,
            labels: file.places.into_iter().map(|p| p.label).collect(),
            minutes,
            symmetric,
        })
    }

    /// A made-up city of `n` places (clamped to 1 to [`MAX_PLACES`]): the bakery, place 0, at the
    /// middle of a 1,000 by 1,000 square, the rest scattered on it by a SplitMix64 stream seeded
    /// from `seed`, and the minutes between two places 2 plus the straight-line distance scaled so
    /// the square's diagonal is 38, so 2 to 40 minutes. Symmetric, with zeros on the diagonal, and
    /// the same for one seed on every machine: integer arithmetic only.
    pub fn synthetic(seed: u64, n: usize) -> TravelMatrix {
        const SIDE: u64 = 1_000;
        // The diagonal of the square, rounded up: sqrt(2) * 1,000.
        const DIAGONAL: u64 = 1_415;
        let n = n.clamp(1, MAX_PLACES);
        let mut state = mix(seed ^ 0xD15B_A7C4_0000_0001);
        let mut next = || {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            mix(state)
        };
        let points: Vec<(i64, i64)> = (0..n)
            .map(|i| {
                if i == 0 {
                    ((SIDE / 2) as i64, (SIDE / 2) as i64)
                } else {
                    ((next() % (SIDE + 1)) as i64, (next() % (SIDE + 1)) as i64)
                }
            })
            .collect();
        let (lo, hi) = SYNTHETIC_MINUTES;
        let span = u64::from(hi - lo);
        let rows = points
            .iter()
            .enumerate()
            .map(|(i, a)| {
                points
                    .iter()
                    .enumerate()
                    .map(|(j, b)| {
                        if i == j {
                            return 0;
                        }
                        let (dx, dy) = ((a.0 - b.0).unsigned_abs(), (a.1 - b.1).unsigned_abs());
                        let distance = (dx * dx + dy * dy).isqrt();
                        lo + u32::try_from((distance * span).div_ceil(DIAGONAL).min(span))
                            .unwrap_or(hi - lo)
                    })
                    .collect()
            })
            .collect();
        let places = (0..n)
            .map(|i| {
                let index = PlaceIndex::try_from(i).unwrap_or(PlaceIndex::MAX);
                MatrixPlace {
                    index,
                    label: place_label(index),
                }
            })
            .collect();
        TravelMatrix::checked(MatrixFile {
            city: "synthetic".to_owned(),
            built: format!("seed:{seed}"),
            source: "TravelMatrix::synthetic: a planar layout, not a road network".to_owned(),
            depot: 0,
            places,
            minutes: rows,
        })
        .expect("the synthetic layout is square with a zero diagonal")
    }

    /// The fixture's JSON for this matrix, compact, with a trailing newline.
    pub fn to_json(&self) -> String {
        let n = self.len();
        let file = MatrixFile {
            city: self.city.clone(),
            built: self.built.clone(),
            source: self.source.clone(),
            depot: self.depot,
            places: self
                .labels
                .iter()
                .enumerate()
                .map(|(i, label)| MatrixPlace {
                    index: PlaceIndex::try_from(i).unwrap_or(PlaceIndex::MAX),
                    label: label.clone(),
                })
                .collect(),
            minutes: self.minutes.chunks(n).map(<[u32]>::to_vec).collect(),
        };
        let mut out = serde_json::to_string(&file).expect("plain data serializes");
        out.push('\n');
        out
    }

    /// How many places.
    pub fn len(&self) -> usize {
        self.labels.len()
    }

    /// Never true: a matrix holds at least the bakery.
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }

    /// The bakery's place: where every route starts and ends.
    pub fn depot(&self) -> PlaceIndex {
        self.depot
    }

    pub fn city(&self) -> &str {
        &self.city
    }

    pub fn label(&self, place: PlaceIndex) -> Option<&str> {
        self.labels.get(usize::from(place)).map(String::as_str)
    }

    /// Whether `place` is one of the matrix's.
    pub fn contains(&self, place: PlaceIndex) -> bool {
        usize::from(place) < self.len()
    }

    /// Whether every pair takes as long one way as the other.
    pub fn is_symmetric(&self) -> bool {
        self.symmetric
    }

    /// Minutes from `from` to `to`; `None` when either is not a place of the matrix.
    pub fn minutes(&self, from: PlaceIndex, to: PlaceIndex) -> Option<u32> {
        if !self.contains(from) || !self.contains(to) {
            return None;
        }
        self.minutes
            .get(usize::from(from) * self.len() + usize::from(to))
            .copied()
    }

    /// One van's drive: the bakery to each place in turn and back to the bakery. An empty route
    /// is 0 minutes; `None` when a place is not the matrix's. Saturates rather than overflows.
    pub fn route_minutes(&self, places: &[PlaceIndex]) -> Option<u32> {
        if places.is_empty() {
            return Some(0);
        }
        let mut total = 0u32;
        let mut at = self.depot;
        for &p in places.iter().chain(std::iter::once(&self.depot)) {
            total = total.saturating_add(self.minutes(at, p)?);
            at = p;
        }
        Some(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_indexes_are_one_apart() {
        assert_eq!(place_label(0), "p1");
        assert_eq!(place_label(63), "p64");
        assert_eq!(place_index("p17"), Some(16));
        assert_eq!(place_index("p1"), Some(0));
        assert_eq!(place_index("p256"), Some(255));
        for bad in ["p0", "p257", "17", "p", "p017", "q3", "p-1"] {
            assert_eq!(place_index(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_synthetic_city_is_symmetric_and_bounded_and_the_same_every_run() {
        let m = TravelMatrix::synthetic(42, 64);
        assert_eq!(m.len(), 64);
        assert_eq!(m.depot(), 0);
        assert!(m.is_symmetric());
        for i in 0..64u8 {
            assert_eq!(m.minutes(i, i), Some(0));
            for j in 0..64u8 {
                if i != j {
                    let x = m.minutes(i, j).unwrap();
                    assert!((2..=40).contains(&x), "{i} {j} {x}");
                }
            }
        }
        assert_eq!(m, TravelMatrix::synthetic(42, 64));
        assert_ne!(m, TravelMatrix::synthetic(43, 64));
        assert_eq!(m.label(16), Some("p17"));
        // Pinned, so a change to the layout is a decision and not an accident.
        assert_eq!(
            (m.minutes(0, 1), m.minutes(0, 63), m.minutes(17, 40)),
            (Some(14), Some(13), Some(12))
        );
    }

    #[test]
    fn the_fixture_shape_round_trips() {
        let m = TravelMatrix::synthetic(7, 5);
        let text = m.to_json();
        assert!(text.starts_with(r#"{"city":"synthetic","built":"seed:7","source":"#));
        assert_eq!(TravelMatrix::from_json(&text), Ok(m));
    }

    #[test]
    fn the_fixture_reader_refuses_what_does_not_fit() {
        let ok = r#"{"city":"c","built":"b","source":"s",
            "places":[{"index":0,"label":"p1"},{"index":1,"label":"p2"}],
            "minutes":[[0,7],[8,0]], "extra": true}"#;
        let m = TravelMatrix::from_json(ok).unwrap();
        assert_eq!(m.depot(), 0);
        assert!(!m.is_symmetric());
        assert_eq!(m.route_minutes(&[1]), Some(15));
        let bad = |places: &str, minutes: &str, depot: u8| {
            TravelMatrix::from_json(&format!(
                r#"{{"city":"c","built":"b","source":"s","depot":{depot},"places":{places},"minutes":{minutes}}}"#
            ))
        };
        let two = r#"[{"index":0,"label":"p1"},{"index":1,"label":"p2"}]"#;
        assert_eq!(bad("[]", "[]", 0), Err(MatrixError::Size(0)));
        assert_eq!(
            bad(r#"[{"index":1,"label":"p2"}]"#, "[[0]]", 0),
            Err(MatrixError::PlaceOrder {
                position: 0,
                index: 1
            })
        );
        assert_eq!(
            bad(r#"[{"index":0,"label":" "}]"#, "[[0]]", 0),
            Err(MatrixError::Label(0))
        );
        assert_eq!(
            bad(two, "[[0,1]]", 0),
            Err(MatrixError::Rows { rows: 1, places: 2 })
        );
        assert_eq!(
            bad(two, "[[0,1],[1]]", 0),
            Err(MatrixError::Columns {
                row: 1,
                len: 1,
                places: 2
            })
        );
        assert_eq!(bad(two, "[[0,1],[1,3]]", 0), Err(MatrixError::Diagonal(1)));
        assert_eq!(
            bad(two, "[[0,1],[1,0]]", 2),
            Err(MatrixError::Depot {
                depot: 2,
                places: 2
            })
        );
        assert!(matches!(
            TravelMatrix::from_json("{}"),
            Err(MatrixError::Json(_))
        ));
    }

    #[test]
    fn a_route_starts_and_ends_at_the_depot() {
        let m = TravelMatrix::new(vec![vec![0, 2, 9], vec![3, 0, 4], vec![8, 5, 0]], 0).unwrap();
        assert_eq!(m.route_minutes(&[]), Some(0));
        // 0 -> 1 -> 2 -> 0.
        assert_eq!(m.route_minutes(&[1, 2]), Some(2 + 4 + 8));
        // 0 -> 2 -> 1 -> 0.
        assert_eq!(m.route_minutes(&[2, 1]), Some(9 + 5 + 3));
        assert_eq!(m.route_minutes(&[3]), None);
        let other_depot = TravelMatrix::new(vec![vec![0, 2], vec![3, 0]], 1).unwrap();
        assert_eq!(other_depot.route_minutes(&[0]), Some(3 + 2));
    }
}
