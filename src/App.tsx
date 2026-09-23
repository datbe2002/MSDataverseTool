import { useEffect, useState } from "react";
import { Outlet, useMatch } from "react-router";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { QueryView } from "./components/QueryView";
import { Toasts } from "./components/Toasts";
import {
  AddConnectionModal,
  CloseTabConfirmModal,
  DmlConfirmModal,
  EditConnectionModal,
  EnvironmentPickerModal,
  ProjectModal,
  SettingsModal,
  SignOutConfirmModal,
  SwitchConfirmModal,
} from "./components/Modals";
import { matchesBinding } from "./lib/keys";
import { ROUTES } from "./lib/navigation";
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

  const [addOpen, setAddOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  // null = closed; { project: null } = create; { project } = edit
  const [projectModal, setProjectModal] = useState<{ project: Project | null } | null>(null);

  useEffect(() => {
    init();
    loadSettings();
  }, [init, loadSettings]);

  // User-configurable run shortcut. Capture phase so F5 beats the webview's
  // reload and Monaco's own handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesBinding(e, runBindings)) {
        e.preventDefault();
        e.stopPropagation();
        run();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveActiveTab();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [run, runBindings, saveActiveTab]);

  const outletContext: LayoutContext = {
    openDiscover: () => setEnvOpen(true),
    openAdd: () => setAddOpen(true),
    openEdit: setEditing,
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      <Sidebar onSettings={() => setSettingsOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onEdit={setEditing}
          onAdd={() => setAddOpen(true)}
          onDiscover={() => setEnvOpen(true)}
          onAddProject={() => setProjectModal({ project: null })}
          onEditProject={(project) => setProjectModal({ project })}
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {editing && <EditConnectionModal connection={editing} onClose={() => setEditing(null)} />}
      {projectModal && (
        <ProjectModal project={projectModal.project} onClose={() => setProjectModal(null)} />
      )}
      <DmlConfirmModal />
      <SwitchConfirmModal />
      <CloseTabConfirmModal />
      {/* After the project modal, so it stacks on top when opened from there. */}
      <SignOutConfirmModal />
      <Toasts />
    </div>
  );
}
