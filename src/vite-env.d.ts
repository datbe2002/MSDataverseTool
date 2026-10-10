/// <reference types="vite/client" />

import type { Environment } from "monaco-editor";

declare global {
  interface Window {
    MonacoEnvironment?: Environment;
  }
  namespace JSX {
    interface IntrinsicElements {
      /** Customizable <select>: the browser fills it with a copy of the picked option. */
      selectedcontent: React.HTMLAttributes<HTMLElement>;
    }
  }
}

export {};
