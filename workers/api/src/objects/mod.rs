//! Durable Object classes. No timers and no wall-clock reads in here: time comes from the clock
//! adapter and later work from alarms (AGENTS.md; docs/architecture.md, "The rules").

pub mod control;
