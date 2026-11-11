import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      },
      "/healthz": {
        target: "http://localhost:8080"
      },
      "/api": {
        target: "http://localhost:8080"
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          yjs: ["yjs"],
          codemirror: [
            "codemirror",
            "@codemirror/view",
            "@codemirror/state",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/theme-one-dark"
          ],
          languages: [
            "@codemirror/lang-javascript",
            "@codemirror/lang-python",
            "@codemirror/lang-go",
            "@codemirror/lang-java",
            "@codemirror/lang-rust",
            "@codemirror/lang-sql",
            "@codemirror/lang-json",
            "@codemirror/lang-html",
            "@codemirror/lang-css",
            "@codemirror/lang-markdown",
            "@codemirror/legacy-modes/mode/clike",
            "@codemirror/legacy-modes/mode/swift"
          ]
        }
      }
    }
  }
});
