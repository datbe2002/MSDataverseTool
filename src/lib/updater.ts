// In-app updates, the Claude Desktop way: check GitHub Releases in the
// background, download a newer signed installer quietly, then offer
// "Restart to update". The feed (latest.json) and signatures are made by
// .github/workflows/release.yml; the public key is in tauri.conf.json.
// The download runs in Rust (src-tauri/src/update.rs): the plugin's JS
// download sends one message per network chunk and crawls.
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface UpdateInfo {
  version: string;
  notes: string | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  /** Downloaded and verified; installs on restart. */
  | "ready"
  | "installing"
  | "upToDate"
  | "error";

interface UpdaterStore {
  currentVersion: string | null;
  status: UpdateStatus;
  /** Version on offer, once one is found. */
  version: string | null;
  notes: string | null;
  /** 0..1 while downloading, when the size is known. */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  /** Look for an update; a newer one is downloaded straight away. */
  checkNow: () => Promise<void>;
  /** Install the downloaded update. On Windows this exits the app and reopens the new version. */
  install: () => Promise<void>;
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  currentVersion: null,
  status: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
  checkedAt: null,

  checkNow: async () => {
    const { status } = get();
    // Already have one, or busy getting it.
    if (status === "checking" || status === "downloading" || status === "ready" || status === "installing") return;
    set({ status: "checking", error: null });
    try {
      const update = await invoke<UpdateInfo | null>("check_update");
      set({ checkedAt: Date.now() });
      if (!update) {
        set({ status: "upToDate" });
        return;
      }
      set({ status: "downloading", version: update.version, notes: update.notes, progress: null });
      const unlisten = await listen<number>("update-progress", (e) => set({ progress: e.payload }));
      try {
        await invoke("download_update");
      } finally {
        unlisten();
      }
      set({ status: "ready", progress: 1 });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },

  install: async () => {
    if (get().status !== "ready") return;
    set({ status: "installing", error: null });
    try {
      await invoke("install_update");
    } catch (e) {
      set({ status: "ready", error: String(e) });
    }
  },
}));

const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

/** Reads the running version, then checks shortly after start and every few hours. */
export function startUpdateChecks(): () => void {
  getVersion()
    .then((v) => useUpdater.setState({ currentVersion: v }))
    .catch(() => {});
  // `npm run tauri dev` has no signed feed to compare against; check by hand from Settings.
  if (import.meta.env.DEV) return () => {};
  const quiet = () => {
    // Background checks stay silent on failure (offline, GitHub down…).
    useUpdater.getState().checkNow().then(() => {
      if (useUpdater.getState().status === "error") useUpdater.setState({ status: "idle" });
    });
  };
  const first = window.setTimeout(quiet, FIRST_CHECK_MS);
  const timer = window.setInterval(quiet, EVERY_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(timer);
  };
}
