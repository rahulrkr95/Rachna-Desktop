use std::collections::HashMap;

use super::types::{Automation, AutomationStep};

/// Registry of step executors, keyed by the same `executor` name used in
/// the persisted JSON ("terminal", "ai", ...) -- mirrors
/// lib/automationRunner.ts's `ExecutorRegistry` exactly: steps are
/// dispatched by name, never by matching on job/automation `kind`.
pub struct ExecutorRegistry {
    executors: HashMap<&'static str, Box<dyn Fn(&AutomationStep) + Send + Sync>>,
}

impl ExecutorRegistry {
    pub fn new() -> Self {
        Self { executors: HashMap::new() }
    }

    pub fn register<F>(&mut self, name: &'static str, executor: F)
    where
        F: Fn(&AutomationStep) + Send + Sync + 'static,
    {
        self.executors.insert(name, Box::new(executor));
    }

    fn resolve(&self, name: &str) -> Option<&Box<dyn Fn(&AutomationStep) + Send + Sync>> {
        self.executors.get(name)
    }

    /// Returns the `executor` name for a step -- the ONLY thing used to
    /// look up a handler. No AI-specific branching here or in
    /// AutomationRunner below.
    fn executor_name(step: &AutomationStep) -> &'static str {
        match step {
            AutomationStep::Terminal { .. } => "terminal",
            AutomationStep::Ai { .. } => "ai",
        }
    }

    pub fn dispatch(&self, step: &AutomationStep) {
        let name = Self::executor_name(step);
        match self.resolve(name) {
            Some(executor) => executor(step),
            None => panic!("No executor registered for step type \"{name}\"."),
        }
    }
}

/// AutomationRunner -- the single place that actually executes an
/// Automation's `steps`. Contains no AI-specific logic and never reads a
/// `kind` field (there isn't one on this struct -- see types.rs): every
/// step is dispatched purely by its own executor name via
/// ExecutorRegistry, exactly mirroring lib/automationRunner.ts.
pub struct AutomationRunner;

impl AutomationRunner {
    pub fn run(task: &Automation, registry: &ExecutorRegistry) {
        for step in &task.steps {
            registry.dispatch(step);
        }
    }
}
