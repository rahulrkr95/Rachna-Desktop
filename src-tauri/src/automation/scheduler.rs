// NOTE: the actual scheduler/runner used at runtime lives on the TS side
// (services/automationService.ts + store/useAutomationStore.ts). This Rust
// module mirrors the canonical persisted shape:
//   { name, schedule, enabled, steps: [terminal|ai] }
// (see AutomationStep below and lib/automationScheduler.ts's
// AutomationStep/AutomationJsonSpec) for parity, but is not currently
// wired into main.rs.

// NOTE: the actual scheduler/runner used at runtime lives on the TS side
// (services/automationService.ts + lib/automationRunner.ts). This Rust
// module mirrors the canonical persisted shape:
//   { name, schedule, enabled, steps: [terminal|ai] }
// (see AutomationStep/Automation in types.rs) and the same
// registry-dispatch design (see ExecutorRegistry/AutomationRunner in
// runner.rs) for parity, but is not currently wired into main.rs.
//
// The scheduler itself does nothing AI-specific and never reads a `kind`
// field -- it just finds due automations and hands them to
// AutomationRunner, which dispatches each step by name via the registry
// the caller supplies.

use super::runner::{AutomationRunner, ExecutorRegistry};
use super::types::Automation;

pub struct Scheduler {
    tasks: Vec<Automation>,
    registry: ExecutorRegistry,
}

impl Scheduler {
    pub fn tick(&self) {
        for task in &self.tasks {
            if !task.enabled {
                continue;
            }

            if is_due(&task.schedule) {
                AutomationRunner::run(task, &self.registry);
            }
        }
    }
}