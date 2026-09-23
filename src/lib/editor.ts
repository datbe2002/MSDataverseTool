// Bridge to the mounted Monaco editor so non-React code (the store) can read
// the current selection for "run selection" behaviour.
import type { editor as MonacoEditor } from "monaco-editor";

let editor: MonacoEditor.IStandaloneCodeEditor | null = null;

export function setEditor(instance: MonacoEditor.IStandaloneCodeEditor | null) {
  editor = instance;
}

/** Only clear if `instance` is still the active editor (guards StrictMode churn). */
export function clearEditor(instance: MonacoEditor.IStandaloneCodeEditor | null) {
  if (editor === instance) editor = null;
}

/** The currently selected text, or "" when nothing is selected. */
export function getSelectedSql(): string {
  if (!editor) return "";
  const sel = editor.getSelection();
  if (!sel || sel.isEmpty()) return "";
  return editor.getModel()?.getValueInRange(sel) ?? "";
}

export function hasSelection(): boolean {
  const sel = editor?.getSelection();
  return !!sel && !sel.isEmpty();
}
