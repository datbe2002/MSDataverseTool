import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
// Bundle the Monaco editor worker locally so the app works fully offline
// (the default loader would fetch Monaco from a CDN).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { defineEditorThemes } from "./lib/monacoTheme";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    // Flow definitions are shown as JSON (folding, brackets need its worker).
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};

loader.config({ monaco });
defineEditorThemes(monaco);
// The bundled fonts load asynchronously; re-measure so the cursor lines up.
document.fonts?.ready.then(() => monaco.editor.remeasureFonts());

import { RouterProvider } from "react-router";
import { router } from "./router";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
