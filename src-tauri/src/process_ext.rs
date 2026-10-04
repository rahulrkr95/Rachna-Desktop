// ── Windows: suppress console windows for background process spawns ──────────
//
// On Windows, spawning a console subprocess (cmd, powershell, node, npm,
// npx, git, `where`, ...) from a GUI app briefly flashes a visible console
// window, because CreateProcess allocates a new console when the child is a
// console app and none is already attached. That's the "many terminal
// windows on startup" symptom: every Doctor check, PATH/version probe, git
// call, and one-shot `run_terminal_command` invocation was opening (and
// quickly closing) its own console.
//
// None of those are meant to be visible — their stdout/stderr is captured
// and shown inside the app. The ONE thing that should stay a real, visible
// terminal is the in-app PTY session (`pty_create` in commands.rs), and
// that already avoids this problem because portable-pty drives it through
// the Windows ConPTY API rather than a normal allocated console.
//
// `.no_window()` below opts every other spawn out of the console window via
// CREATE_NO_WINDOW. It's a no-op on macOS/Linux.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    /// Prevent this child process from flashing a console window on Windows.
    /// Call this on every background/one-shot spawn (version checks, git,
    /// npm/npx, installers, the agent's run_terminal_command, ...).
    /// Do NOT call this on portable_pty::CommandBuilder — the in-app
    /// terminal already handles this correctly via ConPTY.
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

impl NoWindow for tokio::process::Command {
    // tokio::process::Command exposes its own inherent `creation_flags` on
    // Windows (it forwards to the same std API internally), so no extra
    // trait import is needed here.
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
