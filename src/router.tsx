import { createHashRouter, Navigate, useOutletContext } from "react-router";
import { RootLayout, type LayoutContext } from "./App";
import { SqlLayout } from "./components/SqlLayout";
import { OverviewView } from "./components/OverviewView";
import { SchemaView } from "./components/SchemaView";
import { HistoryView } from "./components/HistoryView";
import { FlowsView } from "./components/FlowsView";
import { FetchXmlView } from "./components/FetchXmlView";
import { TracesView } from "./components/TracesView";
import { JobsView } from "./components/JobsView";
import { PluginsView } from "./components/PluginsView";
import { DependenciesView } from "./components/DependenciesView";
import { SecurityView } from "./components/SecurityView";
import { ROUTES, setNavigator } from "./lib/navigation";

function OverviewRoute() {
  const { openDiscover, openAdd, openEdit } = useOutletContext<LayoutContext>();
  return <OverviewView onDiscover={openDiscover} onAdd={openAdd} onEdit={openEdit} />;
}

// Hash history: a Tauri webview reload on a deep path needs no server fallback.
export const router = createHashRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Navigate to={ROUTES.overview} replace /> },
      {
        path: "sql",
        element: <SqlLayout />,
        children: [
          { index: true, element: <Navigate to={ROUTES.overview} replace /> },
          { path: "overview", element: <OverviewRoute /> },
          // Rendered by RootLayout itself so the editor never unmounts.
          { path: "query", element: null },
          { path: "schema", element: <SchemaView /> },
          { path: "history", element: <HistoryView /> },
        ],
      },
      { path: "flows/:flowId?", element: <FlowsView /> },
      { path: "fetchxml", element: <FetchXmlView /> },
      { path: "traces/:traceId?", element: <TracesView /> },
      { path: "jobs/:jobId?", element: <JobsView /> },
      { path: "plugins", element: <PluginsView /> },
      { path: "dependencies", element: <DependenciesView /> },
      { path: "security/:tab?", element: <SecurityView /> },
      { path: "*", element: <Navigate to={ROUTES.overview} replace /> },
    ],
  },
]);

setNavigator((to) => {
  void router.navigate(to);
});
