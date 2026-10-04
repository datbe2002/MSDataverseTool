import type * as Monaco from "monaco-editor";

// Client API typings (@types/xrm) for web resource scripts: `Xrm.`, `formContext.`,
// `GetGlobalContext()` complete and show docs on hover. The .d.ts (~290 KB) is its
// own chunk, loaded the first time a script opens; the TS worker picks it up live.
let loading: Promise<void> | null = null;

export function ensureXrmTypes(monaco: typeof Monaco): Promise<void> {
  loading ??= import("../../node_modules/@types/xrm/index.d.ts?raw")
    .then(({ default: dts }) => {
      const ts = monaco.languages.typescript;
      ts.javascriptDefaults.addExtraLib(dts, "file:///node_modules/@types/xrm/index.d.ts");
      ts.typescriptDefaults.addExtraLib(dts, "file:///node_modules/@types/xrm/index.d.ts");
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}
