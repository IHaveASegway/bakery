//! The menu as an aggregate, hosted by `Catalog` (docs/domain.md, "MenuItem availability"). It
//! protects what may be sold when: price, lead time, the days an item is baked, its daily cap
//! and any season. The count left today is not here; it is a `Schedule` fact.
//!
//! The state keeps two copies of the menu. Staff edits change the draft, and `PublishMenu` copies
//! the draft over the published copy and bumps the version, so an order always names a published
//! version and the storefront's cached menu moves only when the version does. `Pause`, `Resume`
//! and `Retire` are the exception: the diagram draws them as transitions of their own, not as
//! drafts, so each changes both copies at once and publishes a version for that one item, leaving
//! any other drafts pending.
//!
//! The tax rate travels with the published menu, so an order's `menu_version` also names the rate
//! it was priced at. `SetTaxRate` is published at once like a pause: it is one `MenuPublished`
//! carrying the new rate, and it leaves any price drafts waiting. The rate is 0 to
//! [`MAX_TAX_BP`] basis points; a sandbox starts at [`DEFAULT_TAX_BP`].
//!
//! Seasons are `MM-DD` windows that come back every year, as the seed writes them. So an item out
//! of its window shows as `scheduled`, waiting for the window, rather than `retired`; only
//! `Retire` retires.

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

use crate::aggregate::{Aggregate, DecideContext, DomainEvent};
use crate::free_text::check_free_text;
pub use crate::order::DEFAULT_TAX_BP;
use crate::{BusinessTime, Cents};

/// The nine major US food allergens (docs/domain.md, "The seed"). The seed's list must equal it;
/// a test in `bakery-app` checks.
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

/// The category whose whole cakes need [`CAKE_MIN_LEAD_MINUTES`].
pub const CAKE_CATEGORY: &str = "cakes";

/// A cake's lead time is at least 48 h (docs/domain.md, "MenuItem availability"). A slice is
/// cut from the day's cakes and takes 2 h (docs/domain.md, "The seed", the menu table), so the
/// rule binds every cake variant but the `slice`.
pub const CAKE_MIN_LEAD_MINUTES: u32 = 2_880;

const SLICE_SUFFIX: &str = "slice";

/// The highest tax rate staff may set, 3,000 bp or 30.00%. A demo rate, not a jurisdiction's.
pub const MAX_TAX_BP: u32 = 3_000;

fn default_tax_bp() -> u32 {
    DEFAULT_TAX_BP
}

/// Names and labels are short labels, not prose.
const MAX_NAME_CHARS: usize = 64;

/// A day of the week, Monday first, as the seed numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ];

    /// The bakery-local weekday of a business time.
    pub fn of(t: BusinessTime) -> Weekday {
        Weekday::ALL[usize::from(t.local_weekday() % 7)]
    }
}

/// A month and day, `MM-DD` on the wire, one end of a season.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MonthDay {
    month: u8,
    day: u8,
}

impl MonthDay {
    /// Refuses a day the month never has; 29 February is allowed, since seasons recur.
    pub fn new(month: u8, day: u8) -> Option<MonthDay> {
        let last = match month {
            4 | 6 | 9 | 11 => 30,
            2 => 29,
            1..=12 => 31,
            _ => return None,
        };
        (1..=last).contains(&day).then_some(MonthDay { month, day })
    }

    pub fn month(self) -> u8 {
        self.month
    }

    pub fn day(self) -> u8 {
        self.day
    }
}

impl fmt::Display for MonthDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}-{:02}", self.month, self.day)
    }
}

impl Serialize for MonthDay {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for MonthDay {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<MonthDay, D::Error> {
        let text = String::deserialize(deserializer)?;
        let b = text.as_bytes();
        let two = |i: usize| -> Option<u8> {
            let (h, l) = (b.get(i)?, b.get(i + 1)?);
            (h.is_ascii_digit() && l.is_ascii_digit()).then(|| (h - b'0') * 10 + (l - b'0'))
        };
        let parsed = (b.len() == 5 && b[2] == b'-')
            .then(|| MonthDay::new(two(0)?, two(3)?))
            .flatten();
        parsed.ok_or_else(|| serde::de::Error::custom("expected MM-DD"))
    }
}

/// A seasonal window, inclusive at both ends, wrapping over the new year when `from` is after
/// `to` (the cardamom knot's October to March).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Season {
    pub from: MonthDay,
    pub to: MonthDay,
}

impl Season {
    /// Whether the bakery-local date of `t` falls in the window.
    pub fn contains(self, t: BusinessTime) -> bool {
        let (_, month, day) = t.local_date();
        let now = MonthDay { month, day };
        if self.from <= self.to {
            self.from <= now && now <= self.to
        } else {
            now >= self.from || now <= self.to
        }
    }
}

/// More than `over_qty` of one variant needs `lead_minutes` (docs/domain.md, "The seed": 12 h
/// for more than 4 of one loaf).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BulkLead {
    pub over_qty: u32,
    pub lead_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Category {
    pub slug: String,
    pub name: String,
}

/// The lifecycle an item stores. `scheduled` is not stored: it is an available item out of its
/// season, so it depends on the date ([`ItemState`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Draft,
    Available,
    Paused,
    Retired,
}

/// The state the diagram in docs/domain.md, "MenuItem availability", draws, on a given date.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Draft,
    Available,
    Scheduled,
    Paused,
    Retired,
}

/// A menu item: what every variant of it shares. Field names follow the seed's `Item`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub allergens: Vec<String>,
    pub daily_cap: u32,
    pub days_baked: Vec<Weekday>,
    pub season: Option<Season>,
    pub bulk_lead: Option<BulkLead>,
    pub pickup_only: bool,
    pub status: ItemStatus,
}

/// A sellable form of an item. The slug is `<item slug>/<suffix>`, as in the seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variant {
    pub slug: String,
    pub item: String,
    pub label: String,
    pub price_cents: Cents,
    pub lead_minutes: u32,
}

/// The fields a `MenuItemChanged` names; an absent field is unchanged. `variants`, when present,
/// replaces the item's whole list. `season` and `bulk_lead` take `null` to clear them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allergens: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_cap: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days_baked: Option<Vec<Weekday>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub season: Option<Option<Season>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub bulk_lead: Option<Option<BulkLead>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<Variant>>,
    /// Set only by `Pause`, `Resume` and `Retire`, which change both copies at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ItemStatus>,
}

/// A field that is present is `Some`, even when it is `null`, so `null` can clear it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl ItemFields {
    fn status_only(status: ItemStatus) -> ItemFields {
        ItemFields {
            status: Some(status),
            ..ItemFields::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum CatalogCommand {
    /// Creates a draft item when the slug is new (then `name`, `category`, `daily_cap`,
    /// `days_baked` and `variants` are required), else edits the draft.
    EditItem {
        item: String,
        fields: ItemFields,
    },
    SetPrice {
        variant: String,
        price: Cents,
    },
    SetAvailability {
        item: String,
        daily_cap: Option<u32>,
        days_baked: Option<Vec<Weekday>>,
        /// `Some(None)` clears the season.
        season: Option<Option<Season>>,
    },
    Pause {
        item: String,
    },
    Resume {
        item: String,
    },
    Retire {
        item: String,
    },
    PublishMenu,
    /// The tax rate in basis points, published at once as a version of its own.
    SetTaxRate {
        tax_bp: u32,
    },
}

impl CatalogCommand {
    fn name(&self) -> &'static str {
        match self {
            CatalogCommand::EditItem { .. } => "EditItem",
            CatalogCommand::SetPrice { .. } => "SetPrice",
            CatalogCommand::SetAvailability { .. } => "SetAvailability",
            CatalogCommand::Pause { .. } => "Pause",
            CatalogCommand::Resume { .. } => "Resume",
            CatalogCommand::Retire { .. } => "Retire",
            CatalogCommand::PublishMenu => "PublishMenu",
            CatalogCommand::SetTaxRate { .. } => "SetTaxRate",
        }
    }
}

/// The catalog's rows in docs/domain.md, "The event catalog".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CatalogEvent {
    MenuItemChanged {
        item: String,
        fields: ItemFields,
    },
    /// `items` counts the items the published menu lists, retired ones excepted. `item` is an
    /// optional field the catalog row does not yet name: present when `Pause`, `Resume` or
    /// `Retire` published that one item, absent when `PublishMenu` published every draft.
    /// `tax_bp` is optional too: present when `SetTaxRate` published a new rate, which publishes
    /// no draft, absent otherwise.
    MenuPublished {
        version: u32,
        items: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tax_bp: Option<u32>,
    },
}

impl DomainEvent for CatalogEvent {
    const NAMES: &'static [&'static str] = &["MenuItemChanged", "MenuPublished"];

    fn name(&self) -> &'static str {
        match self {
            CatalogEvent::MenuItemChanged { .. } => "MenuItemChanged",
            CatalogEvent::MenuPublished { .. } => "MenuPublished",
        }
    }
}

/// The rule a catalog command broke. Each names its rule by [`CatalogError::rule`], for the
/// 422 problem.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CatalogError {
    #[error("no item {0}")]
    UnknownItem(String),
    #[error("no variant {0}")]
    UnknownVariant(String),
    #[error("no category {0}")]
    UnknownCategory(String),
    #[error("{0} is not one of the nine major allergens")]
    UnknownAllergen(String),
    #[error("a new item needs {field}")]
    MissingField { field: &'static str },
    #[error("{0} is not a slug")]
    BadSlug(String),
    #[error("{0} is used twice")]
    DuplicateSlug(String),
    #[error("a name or label must be 1 to 64 characters of plain text")]
    BadName,
    #[error("{item} has no variants")]
    NoVariants { item: String },
    #[error("{variant} must be priced in positive cents")]
    PriceNotPositive { variant: String },
    #[error("{variant} is a cake and needs a lead time of at least {min} minutes")]
    CakeLeadTooShort { variant: String, min: u32 },
    #[error("the bakery is closed on Mondays")]
    ClosedOnMonday,
    #[error("status changes only by Pause, Resume and Retire")]
    StatusByEdit,
    #[error("{0} is retired")]
    Retired(String),
    #[error("{command} does not apply to an item that is {status:?}")]
    OutOfOrder {
        command: &'static str,
        status: ItemStatus,
    },
    #[error("there are no drafts to publish")]
    NothingToPublish,
    #[error("the menu version cannot grow further")]
    VersionOverflow,
    #[error("a tax rate of {0} bp is outside 0 to {MAX_TAX_BP} bp")]
    TaxRateOutOfRange(u32),
}

impl CatalogError {
    /// The slug a problem document names the rule by.
    pub fn rule(&self) -> &'static str {
        match self {
            CatalogError::UnknownItem(_) => "unknown-item",
            CatalogError::UnknownVariant(_) => "unknown-variant",
            CatalogError::UnknownCategory(_) => "unknown-category",
            CatalogError::UnknownAllergen(_) => "unknown-allergen",
            CatalogError::MissingField { .. } => "missing-field",
            CatalogError::BadSlug(_) => "bad-slug",
            CatalogError::DuplicateSlug(_) => "duplicate-slug",
            CatalogError::BadName => "bad-name",
            CatalogError::NoVariants { .. } => "no-variants",
            CatalogError::PriceNotPositive { .. } => "price-not-positive",
            CatalogError::CakeLeadTooShort { .. } => "cake-lead-time",
            CatalogError::ClosedOnMonday => "closed-on-monday",
            CatalogError::StatusByEdit => "status-by-edit",
            CatalogError::Retired(_) => "retired",
            CatalogError::OutOfOrder { .. } => "out-of-order",
            CatalogError::NothingToPublish => "nothing-to-publish",
            CatalogError::VersionOverflow => "version-overflow",
            CatalogError::TaxRateOutOfRange(_) => "tax-rate-range",
        }
    }
}

/// One copy of the menu, in the order it is shown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Menu {
    items: Vec<Item>,
    variants: Vec<Variant>,
}

impl Menu {
    fn item(&self, slug: &str) -> Option<&Item> {
        self.items.iter().find(|i| i.slug == slug)
    }

    fn variants_of<'a>(&'a self, item: &'a str) -> impl Iterator<Item = &'a Variant> + 'a {
        self.variants.iter().filter(move |v| v.item == item)
    }

    /// Puts `item` and its variants in place, keeping the item's position if it had one.
    fn put(&mut self, item: Item, variants: Vec<Variant>) {
        match self.items.iter_mut().find(|i| i.slug == item.slug) {
            Some(slot) => *slot = item.clone(),
            None => self.items.push(item.clone()),
        }
        self.variants.retain(|v| v.item != item.slug);
        self.variants.extend(variants);
    }

    fn set_status(&mut self, slug: &str, status: ItemStatus) {
        if let Some(item) = self.items.iter_mut().find(|i| i.slug == slug) {
            item.status = status;
        }
    }

    fn listed(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.status != ItemStatus::Retired)
            .count()
    }
}

/// The catalog's state: the categories, the draft and published copies, the version, the items
/// with unpublished edits and the published tax rate. A state stored before the rate existed
/// reads it as [`DEFAULT_TAX_BP`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogState {
    categories: Vec<Category>,
    draft: Menu,
    published: Menu,
    version: u32,
    pending: BTreeSet<String>,
    #[serde(default = "default_tax_bp")]
    tax_bp: u32,
}

impl Default for CatalogState {
    fn default() -> Self {
        CatalogState {
            categories: Vec::new(),
            draft: Menu::default(),
            published: Menu::default(),
            version: 0,
            pending: BTreeSet::new(),
            tax_bp: DEFAULT_TAX_BP,
        }
    }
}

impl CatalogState {
    /// The published tax rate in basis points.
    pub fn tax_bp(&self) -> u32 {
        self.tax_bp
    }

    /// The published version; 0 before anything is published.
    pub fn version(&self) -> u32 {
        self.version
    }

    /// Slugs of items with edits not yet published.
    pub fn pending(&self) -> impl Iterator<Item = &str> {
        self.pending.iter().map(String::as_str)
    }

    /// The draft copy of an item and its variants, as the console edits it.
    pub fn draft_item(&self, slug: &str) -> Option<(&Item, Vec<&Variant>)> {
        let item = self.draft.item(slug)?;
        Some((item, self.draft.variants_of(&item.slug).collect()))
    }

    /// The draft copy of every item with edits not yet published, in slug order: what the
    /// console's menu editor shows as waiting for a publish. A pause or a resume is published at
    /// once, so it never lists an item on its own; a new item, never published, is listed.
    pub fn drafts(&self) -> Vec<(&Item, Vec<&Variant>)> {
        self.pending
            .iter()
            .filter_map(|s| self.draft_item(s))
            .collect()
    }

    /// An item's state on the date of `on`: its published copy's, or `draft` before it is first
    /// published; `scheduled` when available but out of season.
    pub fn item_state(&self, slug: &str, on: BusinessTime) -> Option<ItemState> {
        let Some(item) = self.published.item(slug) else {
            return self.draft.item(slug).map(|_| ItemState::Draft);
        };
        Some(match item.status {
            ItemStatus::Draft => ItemState::Draft,
            ItemStatus::Paused => ItemState::Paused,
            ItemStatus::Retired => ItemState::Retired,
            ItemStatus::Available => match item.season {
                Some(season) if !season.contains(on) => ItemState::Scheduled,
                _ => ItemState::Available,
            },
        })
    }

    /// The published menu as the storefront and `Order` read it, retired items left out.
    pub fn menu_view(&self) -> MenuView {
        let categories = self
            .categories
            .iter()
            .filter_map(|c| {
                let items: Vec<ItemView> = self
                    .published
                    .items
                    .iter()
                    .filter(|i| i.category == c.slug && i.status != ItemStatus::Retired)
                    .map(|i| ItemView {
                        slug: i.slug.clone(),
                        name: i.name.clone(),
                        allergens: i.allergens.clone(),
                        daily_cap: i.daily_cap,
                        days_baked: i.days_baked.clone(),
                        season: i.season,
                        bulk_lead: i.bulk_lead,
                        pickup_only: i.pickup_only,
                        status: i.status,
                        variants: self
                            .published
                            .variants_of(&i.slug)
                            .map(|v| VariantView {
                                slug: v.slug.clone(),
                                label: v.label.clone(),
                                price_cents: v.price_cents,
                                lead_minutes: v.lead_minutes,
                            })
                            .collect(),
                    })
                    .collect();
                (!items.is_empty()).then(|| CategoryView {
                    slug: c.slug.clone(),
                    name: c.name.clone(),
                    items,
                })
            })
            .collect();
        MenuView {
            version: self.version,
            tax_bp: self.tax_bp,
            categories,
        }
    }

    /// The published copy after publishing every draft: what `MenuPublished`'s count reads.
    fn published_with_drafts(&self) -> Menu {
        let mut menu = self.published.clone();
        for slug in &self.pending {
            if let Some(item) = self.draft.item(slug) {
                let mut item = item.clone();
                if item.status == ItemStatus::Draft {
                    item.status = ItemStatus::Available;
                }
                menu.put(item, self.draft.variants_of(slug).cloned().collect());
            }
        }
        menu
    }
}

/// The published menu for the storefront (docs/architecture.md, "Data ownership", the Menu row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MenuView {
    pub version: u32,
    /// The tax rate an order placed against this version pays, in basis points. A menu stored
    /// or sent before the field existed reads as [`DEFAULT_TAX_BP`].
    #[serde(default = "default_tax_bp")]
    pub tax_bp: u32,
    pub categories: Vec<CategoryView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryView {
    pub slug: String,
    pub name: String,
    pub items: Vec<ItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemView {
    pub slug: String,
    pub name: String,
    pub allergens: Vec<String>,
    pub daily_cap: u32,
    pub days_baked: Vec<Weekday>,
    pub season: Option<Season>,
    pub bulk_lead: Option<BulkLead>,
    pub pickup_only: bool,
    /// `available` or `paused`; retired items are not listed.
    pub status: ItemStatus,
    pub variants: Vec<VariantView>,
}

impl ItemView {
    /// Whether the item is baked on the bakery-local weekday of `t`.
    pub fn baked_on(&self, t: BusinessTime) -> bool {
        self.days_baked.contains(&Weekday::of(t))
    }

    /// Whether `t` falls in the item's season; an item with none is always in season.
    pub fn in_season_on(&self, t: BusinessTime) -> bool {
        self.season.is_none_or(|s| s.contains(t))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantView {
    pub slug: String,
    pub label: String,
    pub price_cents: Cents,
    pub lead_minutes: u32,
}

impl MenuView {
    /// The `ETag` the API serves for this menu: the version alone, quoted as HTTP writes a strong
    /// tag. It names no sandbox, because the cache key and the URL already do (docs/architecture.md,
    /// "Data ownership": the Cache API keyed by sandbox and version).
    pub fn etag(&self) -> String {
        format!("\"v{}\"", self.version)
    }

    /// The item and variant a variant slug names in this version.
    pub fn variant(&self, slug: &str) -> Option<(&ItemView, &VariantView)> {
        self.categories
            .iter()
            .flat_map(|c| &c.items)
            .find_map(|i| i.variants.iter().find(|v| v.slug == slug).map(|v| (i, v)))
    }
}

/// The aggregate hosted by `Catalog`.
pub struct Catalog;

impl Catalog {
    /// The catalog a sandbox is born with: every item checked against the rules, published as
    /// version 1. An item whose status is `draft` goes into the draft copy only, pending.
    pub fn seeded(
        categories: Vec<Category>,
        items: Vec<Item>,
        variants: Vec<Variant>,
    ) -> Result<CatalogState, CatalogError> {
        let mut seen = BTreeSet::new();
        for slug in categories
            .iter()
            .map(|c| &c.slug)
            .chain(items.iter().map(|i| &i.slug))
            .chain(variants.iter().map(|v| &v.slug))
        {
            if !seen.insert(slug.as_str()) {
                return Err(CatalogError::DuplicateSlug(slug.clone()));
            }
        }
        for c in &categories {
            check_slug(&c.slug)?;
            check_name(&c.name)?;
        }
        if let Some(orphan) = variants
            .iter()
            .find(|v| !items.iter().any(|i| i.slug == v.item))
        {
            return Err(CatalogError::UnknownItem(orphan.item.clone()));
        }
        let mut state = CatalogState {
            categories,
            version: 1,
            ..CatalogState::default()
        };
        for item in items {
            let own: Vec<Variant> = variants
                .iter()
                .filter(|v| v.item == item.slug)
                .cloned()
                .collect();
            validate(&item, &own, &state.categories)?;
            if item.status == ItemStatus::Draft {
                state.pending.insert(item.slug.clone());
            } else {
                state.published.put(item.clone(), own.clone());
            }
            state.draft.put(item, own);
        }
        Ok(state)
    }
}

impl Aggregate for Catalog {
    type State = CatalogState;
    type Command = CatalogCommand;
    type Event = CatalogEvent;
    type Error = CatalogError;

    fn decide(
        state: &CatalogState,
        cmd: &CatalogCommand,
        _ctx: &DecideContext,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        match cmd {
            CatalogCommand::EditItem { item, fields } => {
                if fields.status.is_some() {
                    return Err(CatalogError::StatusByEdit);
                }
                edit(state, item, fields.clone())
            }
            CatalogCommand::SetPrice { variant, price } => {
                let found = state
                    .draft
                    .variants
                    .iter()
                    .find(|v| v.slug == *variant)
                    .ok_or_else(|| CatalogError::UnknownVariant(variant.clone()))?;
                let variants = state
                    .draft
                    .variants_of(&found.item)
                    .map(|v| {
                        let mut v = v.clone();
                        if v.slug == *variant {
                            v.price_cents = *price;
                        }
                        v
                    })
                    .collect();
                let fields = ItemFields {
                    variants: Some(variants),
                    ..ItemFields::default()
                };
                edit(state, &found.item.clone(), fields)
            }
            CatalogCommand::SetAvailability {
                item,
                daily_cap,
                days_baked,
                season,
            } => {
                let fields = ItemFields {
                    daily_cap: *daily_cap,
                    days_baked: days_baked.clone(),
                    season: *season,
                    ..ItemFields::default()
                };
                edit(state, item, fields)
            }
            CatalogCommand::Pause { item } => set_status(
                state,
                cmd,
                item,
                &[ItemStatus::Available],
                ItemStatus::Paused,
            ),
            CatalogCommand::Resume { item } => set_status(
                state,
                cmd,
                item,
                &[ItemStatus::Paused],
                ItemStatus::Available,
            ),
            CatalogCommand::Retire { item } => set_status(
                state,
                cmd,
                item,
                &[ItemStatus::Available, ItemStatus::Paused],
                ItemStatus::Retired,
            ),
            CatalogCommand::PublishMenu => {
                if state.pending.is_empty() {
                    return Err(CatalogError::NothingToPublish);
                }
                Ok(vec![CatalogEvent::MenuPublished {
                    version: next_version(state)?,
                    items: count(state.published_with_drafts().listed()),
                    item: None,
                    tax_bp: None,
                }])
            }
            CatalogCommand::SetTaxRate { tax_bp } => {
                if *tax_bp > MAX_TAX_BP {
                    return Err(CatalogError::TaxRateOutOfRange(*tax_bp));
                }
                if *tax_bp == state.tax_bp {
                    return Ok(vec![]);
                }
                Ok(vec![CatalogEvent::MenuPublished {
                    version: next_version(state)?,
                    items: count(state.published.listed()),
                    item: None,
                    tax_bp: Some(*tax_bp),
                }])
            }
        }
    }

    fn evolve(mut state: CatalogState, event: &CatalogEvent) -> CatalogState {
        match event {
            CatalogEvent::MenuItemChanged { item, fields } => {
                if let Some(status) = fields.status {
                    state.draft.set_status(item, status);
                    state.published.set_status(item, status);
                } else {
                    let base = state.draft.item(item).cloned();
                    let variants: Vec<Variant> = state.draft.variants_of(item).cloned().collect();
                    let (merged, variants) = merge(item, base.as_ref(), &variants, fields);
                    state.draft.put(merged, variants);
                    state.pending.insert(item.clone());
                }
            }
            CatalogEvent::MenuPublished {
                version,
                item,
                tax_bp,
                ..
            } => {
                if let Some(bp) = tax_bp {
                    state.tax_bp = *bp;
                } else if item.is_none() {
                    state.published = state.published_with_drafts();
                    for slug in std::mem::take(&mut state.pending) {
                        state.draft.set_status(
                            &slug,
                            state
                                .published
                                .item(&slug)
                                .map_or(ItemStatus::Draft, |i| i.status),
                        );
                    }
                }
                state.version = *version;
            }
        }
        state
    }
}

fn next_version(state: &CatalogState) -> Result<u32, CatalogError> {
    state
        .version
        .checked_add(1)
        .ok_or(CatalogError::VersionOverflow)
}

/// A menu of 24 items is far from 65,535; saturate rather than wrap should one ever not be.
fn count(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

/// The decision for every draft edit: merge, check, and emit only a real change.
fn edit(
    state: &CatalogState,
    slug: &str,
    fields: ItemFields,
) -> Result<Vec<CatalogEvent>, CatalogError> {
    let base = state.draft.item(slug);
    if let Some(item) = base {
        if item.status == ItemStatus::Retired {
            return Err(CatalogError::Retired(slug.to_owned()));
        }
    } else {
        check_slug(slug)?;
        let required: [(&'static str, bool); 5] = [
            ("name", fields.name.is_some()),
            ("category", fields.category.is_some()),
            ("daily_cap", fields.daily_cap.is_some()),
            ("days_baked", fields.days_baked.is_some()),
            ("variants", fields.variants.is_some()),
        ];
        if let Some((field, _)) = required.iter().find(|(_, given)| !given) {
            return Err(CatalogError::MissingField { field });
        }
    }
    let variants: Vec<Variant> = state.draft.variants_of(slug).cloned().collect();
    let (merged, merged_variants) = merge(slug, base, &variants, &fields);
    validate(&merged, &merged_variants, &state.categories)?;
    if base == Some(&merged) && merged_variants == variants {
        return Ok(vec![]);
    }
    Ok(vec![CatalogEvent::MenuItemChanged {
        item: slug.to_owned(),
        fields,
    }])
}

fn set_status(
    state: &CatalogState,
    cmd: &CatalogCommand,
    slug: &str,
    from: &[ItemStatus],
    to: ItemStatus,
) -> Result<Vec<CatalogEvent>, CatalogError> {
    let item = state
        .published
        .item(slug)
        .ok_or_else(|| match state.draft.item(slug) {
            Some(_) => CatalogError::OutOfOrder {
                command: cmd.name(),
                status: ItemStatus::Draft,
            },
            None => CatalogError::UnknownItem(slug.to_owned()),
        })?;
    if item.status == to {
        return Ok(vec![]);
    }
    if !from.contains(&item.status) {
        return Err(CatalogError::OutOfOrder {
            command: cmd.name(),
            status: item.status,
        });
    }
    let mut after = state.published.clone();
    after.set_status(slug, to);
    Ok(vec![
        CatalogEvent::MenuItemChanged {
            item: slug.to_owned(),
            fields: ItemFields::status_only(to),
        },
        CatalogEvent::MenuPublished {
            version: next_version(state)?,
            items: count(after.listed()),
            item: Some(slug.to_owned()),
            tax_bp: None,
        },
    ])
}

/// `base` with `fields` applied; a new item takes defaults for what `fields` leaves out, which
/// `edit` refuses before it gets here and `evolve` never sees.
fn merge(
    slug: &str,
    base: Option<&Item>,
    variants: &[Variant],
    f: &ItemFields,
) -> (Item, Vec<Variant>) {
    let mut item = base.cloned().unwrap_or_else(|| Item {
        slug: slug.to_owned(),
        name: String::new(),
        category: String::new(),
        allergens: Vec::new(),
        daily_cap: 0,
        days_baked: Vec::new(),
        season: None,
        bulk_lead: None,
        pickup_only: false,
        status: ItemStatus::Draft,
    });
    if let Some(v) = &f.name {
        item.name = v.clone();
    }
    if let Some(v) = &f.category {
        item.category = v.clone();
    }
    if let Some(v) = &f.allergens {
        item.allergens = v.clone();
    }
    if let Some(v) = f.daily_cap {
        item.daily_cap = v;
    }
    if let Some(v) = &f.days_baked {
        item.days_baked = v.clone();
    }
    if let Some(v) = f.season {
        item.season = v;
    }
    if let Some(v) = f.bulk_lead {
        item.bulk_lead = v;
    }
    if let Some(v) = f.pickup_only {
        item.pickup_only = v;
    }
    if let Some(v) = f.status {
        item.status = v;
    }
    let variants = f.variants.clone().unwrap_or_else(|| variants.to_vec());
    (item, variants)
}

/// Every invariant one item and its variants must hold (docs/domain.md, "MenuItem
/// availability"): positive integer cents, a cake's 48 h, known categories and allergens, and
/// the bakery's opening days.
fn validate(
    item: &Item,
    variants: &[Variant],
    categories: &[Category],
) -> Result<(), CatalogError> {
    check_slug(&item.slug)?;
    check_name(&item.name)?;
    if !categories.iter().any(|c| c.slug == item.category) {
        return Err(CatalogError::UnknownCategory(item.category.clone()));
    }
    let mut allergens = BTreeSet::new();
    for a in &item.allergens {
        if !ALLERGENS.contains(&a.as_str()) {
            return Err(CatalogError::UnknownAllergen(a.clone()));
        }
        if !allergens.insert(a) {
            return Err(CatalogError::DuplicateSlug(a.clone()));
        }
    }
    // Open Tuesday to Sunday (docs/domain.md, "Money and time": the bakery day).
    if item.days_baked.contains(&Weekday::Mon) {
        return Err(CatalogError::ClosedOnMonday);
    }
    if variants.is_empty() {
        return Err(CatalogError::NoVariants {
            item: item.slug.clone(),
        });
    }
    let mut slugs = BTreeSet::new();
    for v in variants {
        let suffix = v
            .slug
            .strip_prefix(item.slug.as_str())
            .and_then(|rest| rest.strip_prefix('/'))
            .filter(|_| v.item == item.slug)
            .ok_or_else(|| CatalogError::BadSlug(v.slug.clone()))?;
        check_slug(suffix).map_err(|_| CatalogError::BadSlug(v.slug.clone()))?;
        if !slugs.insert(&v.slug) {
            return Err(CatalogError::DuplicateSlug(v.slug.clone()));
        }
        check_name(&v.label)?;
        if v.price_cents <= Cents::ZERO {
            return Err(CatalogError::PriceNotPositive {
                variant: v.slug.clone(),
            });
        }
        if item.category == CAKE_CATEGORY
            && suffix != SLICE_SUFFIX
            && v.lead_minutes < CAKE_MIN_LEAD_MINUTES
        {
            return Err(CatalogError::CakeLeadTooShort {
                variant: v.slug.clone(),
                min: CAKE_MIN_LEAD_MINUTES,
            });
        }
    }
    Ok(())
}

/// Lower-case letters, digits and single hyphens inside, as the seed's slugs are.
fn check_slug(slug: &str) -> Result<(), CatalogError> {
    let ok = !slug.is_empty()
        && slug.len() <= MAX_NAME_CHARS
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--");
    if ok {
        Ok(())
    } else {
        Err(CatalogError::BadSlug(slug.to_owned()))
    }
}

/// Item names and variant labels are typed by staff, so they get the free-text checker's four
/// classes too: a menu cannot carry a phone number either. One line, at most 64 characters.
fn check_name(name: &str) -> Result<(), CatalogError> {
    let chars = name.chars().count();
    let ok = (1..=MAX_NAME_CHARS).contains(&chars)
        && !name.chars().any(char::is_control)
        && name.trim() == name
        && check_free_text(name).is_ok();
    if ok {
        Ok(())
    } else {
        Err(CatalogError::BadName)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::Ulid;
    use crate::aggregate::{execute, replay_from};
    use proptest::prelude::*;

    pub(crate) fn md(text: &str) -> MonthDay {
        serde_json::from_value(serde_json::json!(text)).unwrap()
    }

    fn variant(item: &str, suffix: &str, label: &str, price: i64, lead: u32) -> Variant {
        Variant {
            slug: format!("{item}/{suffix}"),
            item: item.to_owned(),
            label: label.to_owned(),
            price_cents: Cents(price),
            lead_minutes: lead,
        }
    }

    fn item(slug: &str, name: &str, category: &str) -> Item {
        Item {
            slug: slug.to_owned(),
            name: name.to_owned(),
            category: category.to_owned(),
            allergens: vec!["wheat".to_owned()],
            daily_cap: 40,
            days_baked: vec![
                Weekday::Tue,
                Weekday::Wed,
                Weekday::Thu,
                Weekday::Fri,
                Weekday::Sat,
                Weekday::Sun,
            ],
            season: None,
            bulk_lead: None,
            pickup_only: false,
            status: ItemStatus::Available,
        }
    }

    /// A small hand-built catalog: a loaf with the bulk rule, a seasonal pastry, a cake with a
    /// slice and a pickup-only drink. Names are made up for the tests.
    pub(crate) fn fixture() -> CatalogState {
        let categories = [
            ("breads", "Breads"),
            ("pastries", "Pastries"),
            ("cakes", "Cakes"),
            ("drinks", "Drinks"),
        ]
        .map(|(slug, name)| Category {
            slug: slug.into(),
            name: name.into(),
        })
        .to_vec();
        let mut loaf = item("fern-loaf", "Fern loaf", "breads");
        loaf.bulk_lead = Some(BulkLead {
            over_qty: 4,
            lead_minutes: 720,
        });
        let mut knot = item("sorrel-knot", "Sorrel knot", "pastries");
        knot.season = Some(Season {
            from: md("10-15"),
            to: md("03-15"),
        });
        let mut cake = item("thyme-cake", "Thyme cake", "cakes");
        cake.days_baked = vec![Weekday::Wed, Weekday::Sat, Weekday::Sun];
        let mut tea = item("moss-tea", "Moss tea", "drinks");
        tea.allergens = vec![];
        tea.pickup_only = true;
        let variants = vec![
            variant("fern-loaf", "whole", "Whole", 950, 120),
            variant("fern-loaf", "half", "Half", 550, 120),
            variant("sorrel-knot", "single", "Single", 525, 120),
            variant("thyme-cake", "6-inch", "6-inch", 3_800, 2_880),
            variant("thyme-cake", "slice", "Slice", 650, 120),
            variant("moss-tea", "small", "Small", 300, 0),
        ];
        Catalog::seeded(categories, vec![loaf, knot, cake, tea], variants).unwrap()
    }

    fn ctx() -> DecideContext {
        DecideContext {
            now: at("2026-11-04T09:00:00-07:00"),
            id: Ulid::from_parts(1, 7),
        }
    }

    fn at(text: &str) -> BusinessTime {
        text.parse().unwrap()
    }

    fn run(
        state: CatalogState,
        cmd: CatalogCommand,
    ) -> Result<(CatalogState, Vec<CatalogEvent>), CatalogError> {
        execute::<Catalog>(state, &cmd, &ctx())
    }

    #[test]
    fn seeded_is_published_as_version_one() {
        let state = fixture();
        let view = state.menu_view();
        assert_eq!(view.version, 1);
        assert_eq!(view.etag(), "\"v1\"");
        assert_eq!(view.categories.len(), 4);
        assert_eq!(view.categories[0].slug, "breads");
        assert_eq!(view.categories[0].items[0].variants.len(), 2);
        assert_eq!(state.pending().count(), 0);
        let (item, v) = view.variant("thyme-cake/slice").unwrap();
        assert_eq!(
            (item.slug.as_str(), v.price_cents),
            ("thyme-cake", Cents(650))
        );
        assert!(view.variant("thyme-cake/9-inch").is_none());
    }

    #[test]
    fn seeded_refuses_what_the_rules_refuse() {
        let base = fixture();
        let cats = base.categories.clone();
        let mut cake = item("sage-cake", "Sage cake", "cakes");
        cake.days_baked = vec![Weekday::Sat];
        let short = variant("sage-cake", "9-inch", "9-inch", 6_400, 120);
        assert_eq!(
            Catalog::seeded(cats.clone(), vec![cake.clone()], vec![short]),
            Err(CatalogError::CakeLeadTooShort {
                variant: "sage-cake/9-inch".into(),
                min: 2_880
            })
        );
        let free = variant("sage-cake", "slice", "Slice", 0, 120);
        assert_eq!(
            Catalog::seeded(cats.clone(), vec![cake.clone()], vec![free])
                .unwrap_err()
                .rule(),
            "price-not-positive"
        );
        let orphan = variant("ghost", "single", "Single", 100, 0);
        assert_eq!(
            Catalog::seeded(cats.clone(), vec![], vec![orphan]),
            Err(CatalogError::UnknownItem("ghost".into()))
        );
        let mut monday = cake.clone();
        monday.days_baked = vec![Weekday::Mon];
        let ok = variant("sage-cake", "slice", "Slice", 600, 120);
        assert_eq!(
            Catalog::seeded(cats.clone(), vec![monday], vec![ok.clone()]),
            Err(CatalogError::ClosedOnMonday)
        );
        let mut nutty = cake.clone();
        nutty.allergens = vec!["acorns".into()];
        assert_eq!(
            Catalog::seeded(cats.clone(), vec![nutty], vec![ok.clone()])
                .unwrap_err()
                .rule(),
            "unknown-allergen"
        );
        let mut linked = cake;
        linked.name = "Order at cake-shop.com".into();
        assert_eq!(
            Catalog::seeded(cats, vec![linked], vec![ok]),
            Err(CatalogError::BadName)
        );
    }

    #[test]
    fn an_edit_is_a_draft_until_published() {
        let (state, events) = run(
            fixture(),
            CatalogCommand::SetPrice {
                variant: "fern-loaf/whole".into(),
                price: Cents(1_000),
            },
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name(), "MenuItemChanged");
        // The storefront still sees version 1 at the old price.
        let view = state.menu_view();
        assert_eq!(view.version, 1);
        assert_eq!(
            view.variant("fern-loaf/whole").unwrap().1.price_cents,
            Cents(950)
        );
        assert_eq!(state.pending().collect::<Vec<_>>(), ["fern-loaf"]);

        let (state, events) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert_eq!(
            events,
            [CatalogEvent::MenuPublished {
                version: 2,
                items: 4,
                item: None,
                tax_bp: None,
            }]
        );
        let view = state.menu_view();
        assert_eq!(view.etag(), "\"v2\"");
        assert_eq!(
            view.variant("fern-loaf/whole").unwrap().1.price_cents,
            Cents(1_000)
        );
        assert_eq!(state.pending().count(), 0);
    }

    #[test]
    fn a_sandbox_starts_at_the_default_tax_rate() {
        let state = fixture();
        assert_eq!(state.tax_bp(), DEFAULT_TAX_BP);
        assert_eq!(state.menu_view().tax_bp, 1_000);
    }

    #[test]
    fn set_tax_rate_publishes_at_once_and_leaves_drafts_waiting() {
        let (state, _) = run(
            fixture(),
            CatalogCommand::SetPrice {
                variant: "fern-loaf/whole".into(),
                price: Cents(1_000),
            },
        )
        .unwrap();
        let (state, events) = run(state, CatalogCommand::SetTaxRate { tax_bp: 850 }).unwrap();
        assert_eq!(
            events,
            [CatalogEvent::MenuPublished {
                version: 2,
                items: 4,
                item: None,
                tax_bp: Some(850),
            }]
        );
        let view = state.menu_view();
        assert_eq!((view.version, view.tax_bp), (2, 850));
        // The price draft still waits, and the published price is the old one.
        assert_eq!(state.pending().collect::<Vec<_>>(), ["fern-loaf"]);
        assert_eq!(
            view.variant("fern-loaf/whole").unwrap().1.price_cents,
            Cents(950)
        );
        // A later publish keeps the rate.
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert_eq!((state.version(), state.tax_bp()), (3, 850));
    }

    #[test]
    fn the_tax_rate_is_bounded_0_to_3000_bp() {
        for bp in [0, 1, 999, 2_999, MAX_TAX_BP] {
            let (state, _) = run(fixture(), CatalogCommand::SetTaxRate { tax_bp: bp }).unwrap();
            assert_eq!(state.tax_bp(), bp);
        }
        for bp in [3_001, 10_000, u32::MAX] {
            let refused = run(fixture(), CatalogCommand::SetTaxRate { tax_bp: bp }).unwrap_err();
            assert_eq!(refused, CatalogError::TaxRateOutOfRange(bp));
            assert_eq!(refused.rule(), "tax-rate-range");
        }
    }

    #[test]
    fn the_same_tax_rate_again_changes_nothing() {
        let (state, events) = run(
            fixture(),
            CatalogCommand::SetTaxRate {
                tax_bp: DEFAULT_TAX_BP,
            },
        )
        .unwrap();
        assert!(events.is_empty());
        assert_eq!(state.version(), 1);
    }

    #[test]
    fn a_state_and_a_menu_stored_before_the_rate_read_the_default() {
        let mut stored = serde_json::to_value(fixture()).unwrap();
        stored.as_object_mut().unwrap().remove("tax_bp");
        let state: CatalogState = serde_json::from_value(stored).unwrap();
        assert_eq!(state.tax_bp(), DEFAULT_TAX_BP);
        let mut menu = serde_json::to_value(fixture().menu_view()).unwrap();
        menu.as_object_mut().unwrap().remove("tax_bp");
        let menu: MenuView = serde_json::from_value(menu).unwrap();
        assert_eq!(menu.tax_bp, DEFAULT_TAX_BP);
        // An event written before the field existed has no rate and publishes the drafts.
        let old: CatalogEvent = serde_json::from_value(serde_json::json!({
            "type": "MenuPublished",
            "data": { "version": 2, "items": 4 }
        }))
        .unwrap();
        assert_eq!(
            old,
            CatalogEvent::MenuPublished {
                version: 2,
                items: 4,
                item: None,
                tax_bp: None,
            }
        );
        assert_eq!(
            serde_json::to_value(&old).unwrap()["data"],
            serde_json::json!({ "version": 2, "items": 4 })
        );
    }

    /// `(slug, status, [(variant, price)])`: one draft as the console reads it.
    type Draft = (String, ItemStatus, Vec<(String, i64)>);

    fn drafts(state: &CatalogState) -> Vec<Draft> {
        state
            .drafts()
            .into_iter()
            .map(|(item, variants)| {
                (
                    item.slug.clone(),
                    item.status,
                    variants
                        .iter()
                        .map(|v| (v.slug.clone(), v.price_cents.0))
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn the_drafts_list_each_pending_item_until_published() {
        assert!(fixture().drafts().is_empty());
        let mut state = fixture();
        for (variant, price) in [("moss-tea/small", 325), ("fern-loaf/whole", 1_000)] {
            state = run(
                state,
                CatalogCommand::SetPrice {
                    variant: variant.into(),
                    price: Cents(price),
                },
            )
            .unwrap()
            .0;
        }
        // In slug order, each with every variant's draft price.
        assert_eq!(
            drafts(&state),
            [
                (
                    "fern-loaf".to_owned(),
                    ItemStatus::Available,
                    vec![
                        ("fern-loaf/whole".to_owned(), 1_000),
                        ("fern-loaf/half".to_owned(), 550)
                    ]
                ),
                (
                    "moss-tea".to_owned(),
                    ItemStatus::Available,
                    vec![("moss-tea/small".to_owned(), 325)]
                ),
            ]
        );
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert!(state.drafts().is_empty());
    }

    #[test]
    fn a_pause_is_never_a_draft() {
        let (state, events) = run(
            fixture(),
            CatalogCommand::Pause {
                item: "thyme-cake".into(),
            },
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert!(state.drafts().is_empty());
        // A price drafted on a paused item lists it, paused.
        let (state, _) = run(
            state,
            CatalogCommand::SetPrice {
                variant: "thyme-cake/slice".into(),
                price: Cents(700),
            },
        )
        .unwrap();
        assert_eq!(
            drafts(&state),
            [(
                "thyme-cake".to_owned(),
                ItemStatus::Paused,
                vec![
                    ("thyme-cake/6-inch".to_owned(), 3_800),
                    ("thyme-cake/slice".to_owned(), 700)
                ]
            )]
        );
    }

    #[test]
    fn a_new_item_is_listed_as_a_draft() {
        let new = CatalogCommand::EditItem {
            item: "clover-bun".into(),
            fields: ItemFields {
                name: Some("Clover bun".into()),
                category: Some("pastries".into()),
                daily_cap: Some(30),
                days_baked: Some(vec![Weekday::Sat, Weekday::Sun]),
                variants: Some(vec![variant("clover-bun", "single", "Single", 475, 120)]),
                ..ItemFields::default()
            },
        };
        let (state, _) = run(fixture(), new).unwrap();
        assert_eq!(
            drafts(&state),
            [(
                "clover-bun".to_owned(),
                ItemStatus::Draft,
                vec![("clover-bun/single".to_owned(), 475)]
            )]
        );
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert!(state.drafts().is_empty());
    }

    #[test]
    fn an_edit_that_changes_nothing_emits_nothing() {
        let (_, events) = run(
            fixture(),
            CatalogCommand::SetPrice {
                variant: "fern-loaf/whole".into(),
                price: Cents(950),
            },
        )
        .unwrap();
        assert!(events.is_empty());
        assert_eq!(
            run(fixture(), CatalogCommand::PublishMenu).unwrap_err(),
            CatalogError::NothingToPublish
        );
    }

    #[test]
    fn edits_check_the_rules() {
        let neg = CatalogCommand::SetPrice {
            variant: "moss-tea/small".into(),
            price: Cents(-1),
        };
        assert_eq!(
            run(fixture(), neg).unwrap_err().rule(),
            "price-not-positive"
        );
        let quick_cake = CatalogCommand::EditItem {
            item: "thyme-cake".into(),
            fields: ItemFields {
                variants: Some(vec![variant(
                    "thyme-cake",
                    "6-inch",
                    "6-inch",
                    3_800,
                    1_440,
                )]),
                ..ItemFields::default()
            },
        };
        assert_eq!(
            run(fixture(), quick_cake).unwrap_err().rule(),
            "cake-lead-time"
        );
        let status = CatalogCommand::EditItem {
            item: "thyme-cake".into(),
            fields: ItemFields::status_only(ItemStatus::Paused),
        };
        assert_eq!(
            run(fixture(), status).unwrap_err(),
            CatalogError::StatusByEdit
        );
        let unknown = CatalogCommand::SetPrice {
            variant: "nope/single".into(),
            price: Cents(1),
        };
        assert_eq!(
            run(fixture(), unknown).unwrap_err().rule(),
            "unknown-variant"
        );
    }

    #[test]
    fn a_new_item_is_a_draft_then_available() {
        let new = CatalogCommand::EditItem {
            item: "clover-bun".into(),
            fields: ItemFields {
                name: Some("Clover bun".into()),
                category: Some("pastries".into()),
                daily_cap: Some(30),
                days_baked: Some(vec![Weekday::Sat, Weekday::Sun]),
                variants: Some(vec![variant("clover-bun", "single", "Single", 475, 120)]),
                ..ItemFields::default()
            },
        };
        let (state, _) = run(fixture(), new).unwrap();
        let now = at("2026-11-07T09:00:00-07:00");
        assert_eq!(state.item_state("clover-bun", now), Some(ItemState::Draft));
        assert!(state.menu_view().variant("clover-bun/single").is_none());
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert_eq!(
            state.item_state("clover-bun", now),
            Some(ItemState::Available)
        );
        assert!(state.menu_view().variant("clover-bun/single").is_some());

        let missing = CatalogCommand::EditItem {
            item: "bare-bun".into(),
            fields: ItemFields {
                name: Some("Bare bun".into()),
                ..ItemFields::default()
            },
        };
        assert_eq!(
            run(fixture(), missing).unwrap_err(),
            CatalogError::MissingField { field: "category" }
        );
    }

    #[test]
    fn pause_publishes_that_item_alone_and_leaves_drafts_pending() {
        let (state, _) = run(
            fixture(),
            CatalogCommand::SetPrice {
                variant: "moss-tea/small".into(),
                price: Cents(325),
            },
        )
        .unwrap();
        let (state, events) = run(
            state,
            CatalogCommand::Pause {
                item: "fern-loaf".into(),
            },
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1],
            CatalogEvent::MenuPublished {
                version: 2,
                items: 4,
                item: Some("fern-loaf".into()),
                tax_bp: None,
            }
        );
        let view = state.menu_view();
        assert_eq!(view.version, 2);
        assert_eq!(
            view.variant("fern-loaf/whole").unwrap().0.status,
            ItemStatus::Paused
        );
        // The tea's draft price is still a draft.
        assert_eq!(
            view.variant("moss-tea/small").unwrap().1.price_cents,
            Cents(300)
        );
        assert_eq!(state.pending().collect::<Vec<_>>(), ["moss-tea"]);
        // Pausing again changes nothing; resuming publishes again.
        let (state, again) = run(
            state,
            CatalogCommand::Pause {
                item: "fern-loaf".into(),
            },
        )
        .unwrap();
        assert!(again.is_empty());
        let (state, _) = run(
            state,
            CatalogCommand::Resume {
                item: "fern-loaf".into(),
            },
        )
        .unwrap();
        assert_eq!(state.version(), 3);
        assert_eq!(
            state
                .menu_view()
                .variant("fern-loaf/whole")
                .unwrap()
                .0
                .status,
            ItemStatus::Available
        );
    }

    #[test]
    fn retired_is_terminal_and_unlisted() {
        let (state, events) = run(
            fixture(),
            CatalogCommand::Retire {
                item: "moss-tea".into(),
            },
        )
        .unwrap();
        assert_eq!(
            events[1],
            CatalogEvent::MenuPublished {
                version: 2,
                items: 3,
                item: Some("moss-tea".into()),
                tax_bp: None,
            }
        );
        assert!(state.menu_view().variant("moss-tea/small").is_none());
        assert_eq!(
            run(
                state.clone(),
                CatalogCommand::Resume {
                    item: "moss-tea".into()
                }
            )
            .unwrap_err()
            .rule(),
            "out-of-order"
        );
        let edit = CatalogCommand::SetPrice {
            variant: "moss-tea/small".into(),
            price: Cents(1),
        };
        assert_eq!(run(state, edit).unwrap_err().rule(), "retired");
    }

    #[test]
    fn a_draft_item_cannot_be_paused() {
        let new = CatalogCommand::EditItem {
            item: "clover-bun".into(),
            fields: ItemFields {
                name: Some("Clover bun".into()),
                category: Some("pastries".into()),
                daily_cap: Some(30),
                days_baked: Some(vec![Weekday::Sat]),
                variants: Some(vec![variant("clover-bun", "single", "Single", 475, 120)]),
                ..ItemFields::default()
            },
        };
        let (state, _) = run(fixture(), new).unwrap();
        assert_eq!(
            run(
                state,
                CatalogCommand::Pause {
                    item: "clover-bun".into()
                }
            )
            .unwrap_err(),
            CatalogError::OutOfOrder {
                command: "Pause",
                status: ItemStatus::Draft
            }
        );
    }

    #[test]
    fn a_seasonal_item_is_scheduled_outside_its_window() {
        let state = fixture();
        assert_eq!(
            state.item_state("sorrel-knot", at("2026-11-07T09:00:00-07:00")),
            Some(ItemState::Available)
        );
        assert_eq!(
            state.item_state("sorrel-knot", at("2027-03-15T14:00:00-07:00")),
            Some(ItemState::Available)
        );
        assert_eq!(
            state.item_state("sorrel-knot", at("2027-03-16T07:00:00-06:00")),
            Some(ItemState::Scheduled)
        );
        assert_eq!(
            state.item_state("sorrel-knot", at("2026-10-14T23:59:59-06:00")),
            Some(ItemState::Scheduled)
        );
        let (_, knot) = state
            .menu_view()
            .variant("sorrel-knot/single")
            .map(|(i, v)| (v, i.clone()))
            .unwrap();
        assert!(knot.in_season_on(at("2026-12-25T09:00:00-07:00")));
        assert!(!knot.in_season_on(at("2026-07-04T09:00:00-06:00")));
        assert_eq!(
            state.item_state("nope", at("2026-11-07T09:00:00-07:00")),
            None
        );
    }

    #[test]
    fn availability_can_set_and_clear_a_season() {
        let summer = Season {
            from: md("05-01"),
            to: md("09-30"),
        };
        let set = CatalogCommand::SetAvailability {
            item: "fern-loaf".into(),
            daily_cap: Some(20),
            days_baked: None,
            season: Some(Some(summer)),
        };
        let (state, _) = run(fixture(), set).unwrap();
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        let loaf = state
            .menu_view()
            .variant("fern-loaf/half")
            .unwrap()
            .0
            .clone();
        assert_eq!((loaf.daily_cap, loaf.season), (20, Some(summer)));
        let clear = CatalogCommand::SetAvailability {
            item: "fern-loaf".into(),
            daily_cap: None,
            days_baked: None,
            season: Some(None),
        };
        let (state, events) = run(state, clear).unwrap();
        // `null` clears, and survives the trip through JSON.
        let data = events[0].to_data();
        assert_eq!(data["fields"]["season"], serde_json::Value::Null);
        assert_eq!(
            CatalogEvent::from_parts("MenuItemChanged", &data).unwrap(),
            events[0]
        );
        let (state, _) = run(state, CatalogCommand::PublishMenu).unwrap();
        assert_eq!(
            state
                .menu_view()
                .variant("fern-loaf/half")
                .unwrap()
                .0
                .season,
            None
        );
    }

    #[test]
    fn month_days_read_and_write_as_mm_dd() {
        assert_eq!(md("02-29").to_string(), "02-29");
        for bad in ["13-01", "04-31", "2-01", "02-1", "0a-01", "00-10", "02-30"] {
            assert!(
                serde_json::from_value::<MonthDay>(serde_json::json!(bad)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_menu_view_round_trips_through_json() {
        let view = fixture().menu_view();
        let text = serde_json::to_string(&view).unwrap();
        assert_eq!(serde_json::from_str::<MenuView>(&text).unwrap(), view);
        assert!(text.contains("\"days_baked\":[\"tue\""));
        assert!(text.contains("\"from\":\"10-15\""));
    }

    fn command() -> impl Strategy<Value = CatalogCommand> {
        let variants = prop::sample::select(vec![
            "fern-loaf/whole",
            "fern-loaf/half",
            "sorrel-knot/single",
            "thyme-cake/6-inch",
            "thyme-cake/slice",
            "moss-tea/small",
        ]);
        let items =
            prop::sample::select(vec!["fern-loaf", "sorrel-knot", "thyme-cake", "moss-tea"]);
        prop_oneof![
            (variants, -100i64..5_000).prop_map(|(v, p)| CatalogCommand::SetPrice {
                variant: v.into(),
                price: Cents(p)
            }),
            (items.clone(), 0u32..100).prop_map(|(i, cap)| CatalogCommand::SetAvailability {
                item: i.into(),
                daily_cap: Some(cap),
                days_baked: None,
                season: None
            }),
            items
                .clone()
                .prop_map(|i| CatalogCommand::Pause { item: i.into() }),
            items
                .clone()
                .prop_map(|i| CatalogCommand::Resume { item: i.into() }),
            items.prop_map(|i| CatalogCommand::Retire { item: i.into() }),
            Just(CatalogCommand::PublishMenu),
        ]
    }

    proptest! {
        #[test]
        fn every_published_menu_holds_the_invariants(cmds in proptest::collection::vec(command(), 0..40)) {
            let mut state = fixture();
            let mut log = Vec::new();
            for cmd in &cmds {
                let before = state.version();
                if let Ok((next, events)) = execute::<Catalog>(state.clone(), cmd, &ctx()) {
                    log.extend(events);
                    state = next;
                }
                // The version only grows, by one per publish.
                prop_assert!(state.version() == before || state.version() == before + 1);
                let view = state.menu_view();
                for item in view.categories.iter().flat_map(|c| &c.items) {
                    prop_assert_ne!(item.status, ItemStatus::Retired);
                    for v in &item.variants {
                        prop_assert!(v.price_cents > Cents::ZERO);
                        if item.slug == "thyme-cake" && !v.slug.ends_with("/slice") {
                            prop_assert!(v.lead_minutes >= CAKE_MIN_LEAD_MINUTES);
                        }
                    }
                }
            }
            // The state is the fold of its log.
            prop_assert_eq!(replay_from::<Catalog>(fixture(), &log), state);
        }
    }
}
