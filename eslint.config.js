import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  localStorage: "readonly",
  EventSource: "readonly",
  Event: "readonly",
  fetch: "readonly",
  crypto: "readonly",
  console: "readonly",
  URLSearchParams: "readonly",
  Intl: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

const serverGlobals = {
  process: "readonly",
  Buffer: "readonly",
  console: "readonly",
  URL: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
};

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.venv/**", "API/legacy_python/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["API/**/*.js"],
    languageOptions: {
      globals: serverGlobals,
    },
  },
  {
    files: ["UI/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: browserGlobals,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["UI/src/main.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
