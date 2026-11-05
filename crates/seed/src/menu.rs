//! The menu: 5 categories, 24 items and 48 variants, as docs/domain.md, "The seed", lists them.
//! Fixed, not drawn: every sandbox sells the same things at the same prices. Prices are demo
//! amounts in integer cents; the lead times, caps and baking days are the table's.

/// `(slug, name)`.
pub const CATEGORIES: &[(&str, &str)] = &[
    ("breads", "Breads"),
    ("pastries", "Pastries"),
    ("cakes", "Cakes"),
    ("savory", "Savory"),
    ("drinks", "Drinks"),
];

/// The nine major US food allergens (docs/domain.md, "The seed").
pub const ALLERGENS: [&str; 9] = [
    "milk",
    "eggs",
    "fish",
    "shellfish",
    "tree-nuts",
    "peanuts",
    "wheat",
    "soybeans",
    "sesame",
];

/// One way to buy an item. The variant's slug is `<item slug>/<suffix>`.
#[derive(Debug, Clone, Copy)]
pub struct VariantSpec {
    pub suffix: &'static str,
    pub label: &'static str,
    pub price_cents: i64,
    pub lead_minutes: u32,
}

/// An item and everything its variants share.
#[derive(Debug, Clone, Copy)]
pub struct ItemSpec {
    pub slug: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub allergens: &'static [&'static str],
    pub daily_cap: u32,
    /// Weekdays baked, Monday 0 to Sunday 6. The bakery is closed on Mondays.
    pub days: &'static [u8],
    /// Seasonal window as `("MM-DD", "MM-DD")`, inclusive, wrapping over the new year when the
    /// start is after the end.
    pub season: Option<(&'static str, &'static str)>,
    /// `(over_qty, lead_minutes)`: more than `over_qty` of one variant needs `lead_minutes`
    /// (12 h for more than 4 of one loaf).
    pub bulk_lead: Option<(u32, u32)>,
    pub pickup_only: bool,
    pub variants: &'static [VariantSpec],
}

const TUE_SUN: &[u8] = &[1, 2, 3, 4, 5, 6];
const WED_SUN: &[u8] = &[2, 3, 4, 5, 6];
const FRI_SUN: &[u8] = &[4, 5, 6];
const BULK_LOAF: Option<(u32, u32)> = Some((4, 720));

const fn v(
    suffix: &'static str,
    label: &'static str,
    price_cents: i64,
    lead_minutes: u32,
) -> VariantSpec {
    VariantSpec {
        suffix,
        label,
        price_cents,
        lead_minutes,
    }
}

const fn loaf(
    slug: &'static str,
    name: &'static str,
    allergens: &'static [&'static str],
    days: &'static [u8],
    variants: &'static [VariantSpec],
) -> ItemSpec {
    ItemSpec {
        slug,
        name,
        category: "breads",
        allergens,
        daily_cap: 40,
        days,
        season: None,
        bulk_lead: BULK_LOAF,
        pickup_only: false,
        variants,
    }
}

const fn pastry(
    slug: &'static str,
    name: &'static str,
    allergens: &'static [&'static str],
    season: Option<(&'static str, &'static str)>,
    variants: &'static [VariantSpec],
) -> ItemSpec {
    ItemSpec {
        slug,
        name,
        category: "pastries",
        allergens,
        daily_cap: 80,
        days: TUE_SUN,
        season,
        bulk_lead: None,
        pickup_only: false,
        variants,
    }
}

const fn cake(
    slug: &'static str,
    name: &'static str,
    allergens: &'static [&'static str],
    season: Option<(&'static str, &'static str)>,
    variants: &'static [VariantSpec],
) -> ItemSpec {
    ItemSpec {
        slug,
        name,
        category: "cakes",
        allergens,
        daily_cap: 30,
        days: WED_SUN,
        season,
        bulk_lead: None,
        pickup_only: false,
        variants,
    }
}

const fn savory(
    slug: &'static str,
    name: &'static str,
    allergens: &'static [&'static str],
    variants: &'static [VariantSpec],
) -> ItemSpec {
    ItemSpec {
        slug,
        name,
        category: "savory",
        allergens,
        daily_cap: 50,
        days: TUE_SUN,
        season: None,
        bulk_lead: None,
        pickup_only: false,
        variants,
    }
}

const fn drink(
    slug: &'static str,
    name: &'static str,
    allergens: &'static [&'static str],
    variants: &'static [VariantSpec],
) -> ItemSpec {
    ItemSpec {
        slug,
        name,
        category: "drinks",
        allergens,
        daily_cap: 200,
        days: TUE_SUN,
        season: None,
        bulk_lead: None,
        pickup_only: true,
        variants,
    }
}

const fn pastry_pair(single: i64, box_of_6: i64) -> [VariantSpec; 2] {
    [
        v("single", "Single", single, 120),
        v("box-6", "Box of 6", box_of_6, 120),
    ]
}

const fn cake_trio(six: i64, nine: i64, slice: i64) -> [VariantSpec; 3] {
    [
        v("6-inch", "6-inch", six, 2_880),
        v("9-inch", "9-inch", nine, 2_880),
        v("slice", "Slice", slice, 120),
    ]
}

const fn loaf_pair(whole: i64, half: i64) -> [VariantSpec; 2] {
    [
        v("whole", "Whole", whole, 120),
        v("half", "Half", half, 120),
    ]
}

const fn single(price_cents: i64) -> [VariantSpec; 1] {
    [v("single", "Single", price_cents, 120)]
}

const fn drink_pair(small: i64, large: i64) -> [VariantSpec; 2] {
    [v("small", "Small", small, 0), v("large", "Large", large, 0)]
}

// Variant arrays are named constants so each item can borrow one for 'static.
const COUNTRY: [VariantSpec; 2] = loaf_pair(950, 550);
const RYE: [VariantSpec; 2] = loaf_pair(1_050, 600);
const BAGUETTE: [VariantSpec; 2] = loaf_pair(450, 275);
const FOCACCIA: [VariantSpec; 2] = loaf_pair(1_200, 700);
const BRIOCHE: [VariantSpec; 2] = loaf_pair(1_100, 650);
const SANDWICH: [VariantSpec; 2] = loaf_pair(900, 525);
const CROISSANT: [VariantSpec; 2] = pastry_pair(450, 2_400);
const CHOCOLAT: [VariantSpec; 2] = pastry_pair(500, 2_700);
const ALMOND: [VariantSpec; 2] = pastry_pair(575, 3_100);
const BUN: [VariantSpec; 2] = pastry_pair(475, 2_550);
const CARDAMOM: [VariantSpec; 2] = pastry_pair(525, 2_850);
const DANISH: [VariantSpec; 2] = pastry_pair(500, 2_700);
const SCONE: [VariantSpec; 2] = pastry_pair(400, 2_150);
const CHOCOLATE_CAKE: [VariantSpec; 3] = cake_trio(3_800, 6_400, 650);
const LEMON_CAKE: [VariantSpec; 3] = cake_trio(3_400, 5_800, 575);
const CARROT_CAKE: [VariantSpec; 3] = cake_trio(3_600, 6_000, 600);
const FRUIT_TART: [VariantSpec; 3] = cake_trio(4_000, 6_800, 700);
const HAM_CROISSANT: [VariantSpec; 1] = single(750);
const QUICHE: [VariantSpec; 1] = single(650);
const HAND_PIE: [VariantSpec; 1] = single(600);
const FOCACCIA_SANDWICH: [VariantSpec; 1] = single(1_100);
const DRIP: [VariantSpec; 2] = drink_pair(300, 375);
const LATTE: [VariantSpec; 2] = drink_pair(450, 550);
const CHAI: [VariantSpec; 2] = drink_pair(475, 575);

/// The 24 items, in the order the menu shows them. Their variants total 48.
pub const ITEMS: &[ItemSpec] = &[
    loaf(
        "country-loaf",
        "Country loaf",
        &["wheat"],
        TUE_SUN,
        &COUNTRY,
    ),
    loaf(
        "seeded-rye",
        "Seeded rye",
        &["wheat", "sesame"],
        WED_SUN,
        &RYE,
    ),
    loaf("baguette", "Baguette", &["wheat"], TUE_SUN, &BAGUETTE),
    loaf("focaccia", "Focaccia", &["wheat"], TUE_SUN, &FOCACCIA),
    loaf(
        "brioche-loaf",
        "Brioche loaf",
        &["wheat", "milk", "eggs"],
        FRI_SUN,
        &BRIOCHE,
    ),
    loaf(
        "sandwich-loaf",
        "Sandwich loaf",
        &["wheat", "milk", "soybeans"],
        TUE_SUN,
        &SANDWICH,
    ),
    pastry(
        "croissant",
        "Croissant",
        &["wheat", "milk", "eggs"],
        None,
        &CROISSANT,
    ),
    pastry(
        "pain-au-chocolat",
        "Pain au chocolat",
        &["wheat", "milk", "eggs", "soybeans"],
        None,
        &CHOCOLAT,
    ),
    pastry(
        "almond-croissant",
        "Almond croissant",
        &["wheat", "milk", "eggs", "tree-nuts"],
        None,
        &ALMOND,
    ),
    pastry(
        "morning-bun",
        "Morning bun",
        &["wheat", "milk", "eggs"],
        None,
        &BUN,
    ),
    pastry(
        "cardamom-knot",
        "Cardamom knot",
        &["wheat", "milk", "eggs"],
        Some(("10-15", "03-15")),
        &CARDAMOM,
    ),
    pastry(
        "fruit-danish",
        "Fruit danish",
        &["wheat", "milk", "eggs"],
        None,
        &DANISH,
    ),
    pastry("scone", "Scone", &["wheat", "milk", "eggs"], None, &SCONE),
    cake(
        "chocolate-layer-cake",
        "Chocolate layer cake",
        &["wheat", "milk", "eggs", "soybeans"],
        None,
        &CHOCOLATE_CAKE,
    ),
    cake(
        "lemon-olive-oil-cake",
        "Lemon olive oil cake",
        &["wheat", "eggs", "tree-nuts"],
        None,
        &LEMON_CAKE,
    ),
    cake(
        "carrot-cake",
        "Carrot cake",
        &["wheat", "milk", "eggs", "tree-nuts"],
        None,
        &CARROT_CAKE,
    ),
    cake(
        "seasonal-fruit-tart",
        "Seasonal fruit tart",
        &["wheat", "milk", "eggs", "tree-nuts"],
        Some(("05-01", "09-30")),
        &FRUIT_TART,
    ),
    savory(
        "ham-and-cheese-croissant",
        "Ham and cheese croissant",
        &["wheat", "milk", "eggs"],
        &HAM_CROISSANT,
    ),
    savory(
        "quiche-slice",
        "Quiche slice",
        &["wheat", "milk", "eggs"],
        &QUICHE,
    ),
    savory("hand-pie", "Hand pie", &["wheat", "milk"], &HAND_PIE),
    savory(
        "focaccia-sandwich",
        "Focaccia sandwich",
        &["wheat", "milk", "sesame"],
        &FOCACCIA_SANDWICH,
    ),
    drink("drip-coffee", "Drip coffee", &[], &DRIP),
    drink("latte", "Latte", &["milk"], &LATTE),
    drink("chai", "Chai", &["milk"], &CHAI),
];

/// A catering package, priced per head (docs/domain.md, "CateringEvent": headcount 10 to 200).
#[derive(Debug, Clone, Copy)]
pub struct PackageSpec {
    pub slug: &'static str,
    pub name: &'static str,
    pub per_head_cents: i64,
}

pub const PACKAGES: &[PackageSpec] = &[
    PackageSpec {
        slug: "pastry-platter",
        name: "Pastry platter",
        per_head_cents: 950,
    },
    PackageSpec {
        slug: "breakfast-spread",
        name: "Breakfast spread",
        per_head_cents: 1_450,
    },
    PackageSpec {
        slug: "lunch-boxes",
        name: "Lunch boxes",
        per_head_cents: 1_850,
    },
    PackageSpec {
        slug: "celebration-cake-and-coffee",
        name: "Celebration cake and coffee",
        per_head_cents: 1_250,
    },
];

/// Whether `month`/`day` falls in the item's season. An item with no window is always in season.
pub fn in_season(item: &ItemSpec, month: i64, day: i64) -> bool {
    let Some((from, to)) = item.season else {
        return true;
    };
    let md = |s: &str| -> (i64, i64) {
        let (m, d) = s.split_once('-').expect("MM-DD");
        (m.parse().expect("month"), d.parse().expect("day"))
    };
    let (from, to, now) = (md(from), md(to), (month, day));
    if from <= to {
        from <= now && now <= to
    } else {
        now >= from || now <= to
    }
}
