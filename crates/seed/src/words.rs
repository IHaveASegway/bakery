//! Made-up name parts. Generic words only, never a list of real people or businesses
//! (docs/domain.md, "The seed"): given-name-like words are plants and weather, family-name-like
//! words are landforms and crafts.

/// Plants, then weather.
pub const GIVEN: &[&str] = &[
    "Fennel", "Sorrel", "Yarrow", "Thistle", "Bramble", "Nettle", "Tansy", "Larkspur", "Burdock",
    "Sedge", "Teasel", "Chicory", "Drizzle", "Squall", "Zephyr", "Cirrus", "Sleet", "Virga",
    "Graupel", "Rime",
];

/// Landforms, then crafts.
pub const FAMILY: &[&str] = &[
    "Talus", "Moraine", "Drumlin", "Esker", "Butte", "Mesa", "Cirque", "Arroyo", "Caldera",
    "Tombolo", "Lathe", "Kiln", "Loom", "Chisel", "Bobbin", "Trowel", "Spindle", "Gouge", "Anvil",
    "Awl",
];

/// Venue names are two generic words, as in the docs' Harbor Loft and Orchard Pavilion.
pub const VENUE_FIRST: &[&str] = &[
    "Harbor", "Orchard", "Lantern", "Cedar", "Granite", "Meadow", "Copper", "Juniper",
];

pub const VENUE_SECOND: &[&str] = &[
    "Loft",
    "Pavilion",
    "Hall",
    "Barn",
    "Terrace",
    "Commons",
    "Gallery",
    "Courtyard",
];
