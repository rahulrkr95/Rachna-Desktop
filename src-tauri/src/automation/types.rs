use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Mirrors lib/automationScheduler.ts's `AutomationJsonSpec` field-for-field
/// so the two sides serialize/deserialize the exact same JSON without any
/// lossy conversion. `schedule` is kept as a raw JSON value (rather than a
/// typed enum here) because the canonical shape of `AutomationSchedule`
/// lives on the TS side (see lib/automationScheduler.ts) -- this struct
/// only needs to round-trip it, never interpret it.
///
/// `kind` is intentionally NOT present here: it is a classification/
/// planning-time concern only (see lib/agenticClassifier.ts). The
/// scheduler/runner never reads it -- every step already carries its own
/// executor name, which is all AutomationRunner needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub name: String,
    pub schedule: Value,
    pub enabled: bool,
    pub steps: Vec<AutomationStep>,
}

/// One unit of work -- tagged by `executor`, exactly mirroring
/// lib/automationScheduler.ts's `AutomationStep` union. Never flattened to
/// a string: `command`/`prompt` are preserved as their own fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "executor")]
pub enum AutomationStep {
    #[serde(rename = "terminal")]
    Terminal {
        command: String,
    },

    #[serde(rename = "ai")]
    Ai {
        prompt: String,
    },
}