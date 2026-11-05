//! The menu's 5 categories and 24 items, as docs/domain.md, "The seed", lists them. Fixed, not
//! drawn: every sandbox sells the same things. Variants, prices and caps arrive with the
//! Catalog.

/// `(slug, name)`.
pub const CATEGORIES: &[(&str, &str)] = &[
    ("breads", "Breads"),
    ("pastries", "Pastries"),
    ("cakes", "Cakes"),
    ("savory", "Savory"),
    ("drinks", "Drinks"),
];

/// `(slug, name, category slug)`.
pub const ITEMS: &[(&str, &str, &str)] = &[
    ("country-loaf", "Country loaf", "breads"),
    ("seeded-rye", "Seeded rye", "breads"),
    ("baguette", "Baguette", "breads"),
    ("focaccia", "Focaccia", "breads"),
    ("brioche-loaf", "Brioche loaf", "breads"),
    ("sandwich-loaf", "Sandwich loaf", "breads"),
    ("croissant", "Croissant", "pastries"),
    ("pain-au-chocolat", "Pain au chocolat", "pastries"),
    ("almond-croissant", "Almond croissant", "pastries"),
    ("morning-bun", "Morning bun", "pastries"),
    ("cardamom-knot", "Cardamom knot", "pastries"),
    ("fruit-danish", "Fruit danish", "pastries"),
    ("scone", "Scone", "pastries"),
    ("chocolate-layer-cake", "Chocolate layer cake", "cakes"),
    ("lemon-olive-oil-cake", "Lemon olive oil cake", "cakes"),
    ("carrot-cake", "Carrot cake", "cakes"),
    ("seasonal-fruit-tart", "Seasonal fruit tart", "cakes"),
    (
        "ham-and-cheese-croissant",
        "Ham and cheese croissant",
        "savory",
    ),
    ("quiche-slice", "Quiche slice", "savory"),
    ("hand-pie", "Hand pie", "savory"),
    ("focaccia-sandwich", "Focaccia sandwich", "savory"),
    ("drip-coffee", "Drip coffee", "drinks"),
    ("latte", "Latte", "drinks"),
    ("chai", "Chai", "drinks"),
];
