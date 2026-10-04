// services/appManager/appManager.ts
import { invoke } from "@tauri-apps/api/core";
export interface RunningApp {
  pid: number;
  exeName: string;
  exePath?: string;

  hwnd?: number;
  title?: string;

  isVisible: boolean;
  isFocused: boolean;

  windows: number[];
}

class AppManager {
  private apps = new Map<number, RunningApp>();

  async refresh() {
    const runningApps = await invoke<RunningApp[]>("list_running_apps");

    this.apps.clear();

    for (const app of runningApps) {
      this.apps.set(app.pid, app);
    }
  }

  getAll() {
    return [...this.apps.values()];
  }

  get(pid: number) {
    return this.apps.get(pid);
  }

  isRunning(name: string) {
    return [...this.apps.values()].some(
      a => a.exeName.toLowerCase() === name.toLowerCase()
    );
  }

  clear() {
    this.apps.clear();
  }
}

export const appManager = new AppManager(); 