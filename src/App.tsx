import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useMatch } from "react-router";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QueryView } from "./components/QueryView";
import { Toasts } from "./components/Toasts";
import { SettingsModal, type SettingsSection } from "./components/SettingsDialog";
import { CommandPalette, usePaletteShortcut, type PaletteOpeners } from "./components/CommandPalette";
import {
  AddConnectionModal,
  CloseTabConfirmModal,
  DmlConfirmModal,
  EditConnectionModal,
  EnvironmentPickerModal,
  ProjectModal,
  ReauthModal,
  SignOutConfirmModal,
  SwitchConfirmModal,
} from "./components/Modals";
import { matchesBinding } from "./lib/keys";
import { ROUTES } from "./lib/navigation";
import { startUpdateChecks } from "./lib/updater";
import { useFetchXml } from "./lib/fetchXmlStore";
import type { Connection, Project } from "./types";

/** Modal openers handed to routed views through the outlet context. */
export interface LayoutContext {
  openDiscover: () => void;
  openAdd: () => void;
  openEdit: (c: Connection) => void;
}

export function RootLayout() {
  const init = useStore((s) => s.init);
  const loadSettings = useStore((s) => s.loadSettings);
  const run = useStore((s) => s.run);
  const saveActiveTab = useStore((s) => s.saveActiveTab);
  const runBindings = useStore((s) => s.keybindings.run);
  const isQuery = useMatch(ROUTES.query) !== null;
  const isFetchXml = useMatch(ROUTES.fetchxml) !== null;

  const [addOpen, setAddOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  // null = closed; otherwise the section Settings opens at (undefined = the last one shown).
  const [settingsOpen, setSettingsOpen] = useState<{ section?: SettingsSection } | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  // null = closed; { project: null } = create; { project } = edit
  const [projectModal, setProjectModal] = useState<{ project: Project | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  usePaletteShortcut(togglePalette);
  const paletteOpeners = useMemo<PaletteOpeners>(
    () => ({
      openSettings: (section) => setSettingsOpen({ section }),
      openDiscover: () => setEnvOpen(true),
      openAdd: () => setAddOpen(true),
    }),
    []
  );

  useEffect(() => {
    init();
    loadSettings();
  }, [init, loadSettings]);

  useEffect(() => startUpdateChecks(), []);

  // User-configurable run shortcut. Capture phase so F5 beats the webview's
  // reload and Monaco's own handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesBinding(e, runBindings)) {
        e.preventDefault();
        e.stopPropagation();
        // The FetchXML tool runs its own query; elsewhere Run means the SQL tool.
        if (isFetchXml) void useFetchXml.getState().run();
        else run();
      } else if (isFetchXml && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        // The FetchXML tool saves to a .xml file (Shift = Save as), not a SQL tab.
        e.preventDefault();
        e.stopPropagation();
        void useFetchXml.getState().save(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveActiveTab();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [run, runBindings, saveActiveTab, isFetchXml]);

  const outletContext: LayoutContext = {
    openDiscover: () => setEnvOpen(true),
    openAdd: () => setAddOpen(true),
    openEdit: setEditing,
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      <Sidebar onSettings={() => setSettingsOpen({})} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onEdit={setEditing}
          onAdd={() => setAddOpen(true)}
          onDiscover={() => setEnvOpen(true)}
          onAddProject={() => setProjectModal({ project: null })}
          onEditProject={(project) => setProjectModal({ project })}
          onPalette={() => setPaletteOpen(true)}
        />
        <main className="min-h-0 flex-1 overflow-hidden">
          {/* Stays mounted (hidden) in every tool so the editor keeps its state. */}
          <div className={isQuery ? "flex h-full flex-col" : "hidden"}>
            <QueryView />
          </div>
          {!isQuery && <Outlet context={outletContext} />}
        </main>
      </div>

      {addOpen && <AddConnectionModal onClose={() => setAddOpen(false)} />}
      {envOpen && <EnvironmentPickerModal onClose={() => setEnvOpen(false)} />}
      {settingsOpen && <SettingsModal section={settingsOpen.section} onClose={() => setSettingsOpen(null)} />}
      {editing && <EditConnectionModal connection={editing} onClose={() => setEditing(null)} />}
      {projectModal && (
        <ProjectModal project={projectModal.project} onClose={() => setProjectModal(null)} />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} openers={paletteOpeners} />}
      <DmlConfirmModal />
      <SwitchConfirmModal />
      <CloseTabConfirmModal />
      {/* After the project modal, so it stacks on top when opened from there. */}
      <SignOutConfirmModal />
      {/* Last: an expired sign-in can interrupt anything, dialogs included. */}
      <ReauthModal />
      <Toasts />
    </div>
  );
}
