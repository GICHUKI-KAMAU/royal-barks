import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "..");

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const apiProxyTarget = environment.API_PROXY_TARGET || "http://127.0.0.1:8001";

  return {
    envDir: repositoryRoot,
    plugins: [react()],
    server: {
      proxy: {
        "/api": apiProxyTarget,
      },
    },
  };
});
