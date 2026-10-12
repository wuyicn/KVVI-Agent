import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const source = (path) => fileURLToPath(new URL(`../../../../vendor/dsh/packages/${path}`, import.meta.url));
const local = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom", "clsx", "immer", "zustand", "zod", "picomatch"],
    alias: {
      "@dsh-right": source("client/ui-sidebar-right/src/client"),
      "@dsh-primitives": source("client/ui-primitives/src"),
      "@dsh-theme": source("client/ui-theme/src/styles"),
      "@deepseek-ai/dsh-client-ui-dockkit": source("client/ui-dockkit/src/index.ts"),
      "@deepseek-ai/dsh-client-store": source("client/store/src/index.ts"),
      "@deepseek-ai/dsh-util-crypto": source("util/crypto/src/index.ts"),
      "@deepseek-ai/dsh-client-ui-primitives": local("./src/dsh/primitives.js"),
    },
  },
  test: { include: ["tests/**/*.test.js"], environment: "node" },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    fs: { allow: [local("../../../../")] },
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
