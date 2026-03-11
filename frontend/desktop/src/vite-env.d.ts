/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly DEV?: boolean;
    readonly MODE?: string;
    readonly PROD?: boolean;
    readonly SSR?: boolean;
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_LANGGRAPH_API_URL?: string;
    readonly VITE_INTERNAL_API_TOKEN?: string;
    readonly VITE_LOCAL_AGENT_TOKEN?: string;
    readonly VITE_APP_VERSION?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string;
  export default url;
}
