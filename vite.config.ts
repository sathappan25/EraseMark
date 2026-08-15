import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as esbuild from "esbuild";

const rootDir = dirname(fileURLToPath(import.meta.url));

function chromeExtensionPlugin(): Plugin {
  return {
    name: "chrome-extension-mv3",
    closeBundle: async () => {
      const dist = resolve(rootDir, "dist");
      mkdirSync(dist, { recursive: true });

      await esbuild.build({
        entryPoints: [resolve(rootDir, "src/background/background.ts")],
        bundle: true,
        outfile: resolve(dist, "background.js"),
        format: "esm",
        target: "es2022",
        platform: "browser",
        sourcemap: false,
      });

      mkdirSync(resolve(dist, "content"), { recursive: true });
      await esbuild.build({
        entryPoints: [resolve(rootDir, "src/content/imageSelector.ts")],
        bundle: true,
        outfile: resolve(dist, "content/imageSelector.js"),
        format: "iife",
        target: "es2022",
        platform: "browser",
        sourcemap: false,
      });

      mkdirSync(resolve(dist, "offscreen"), { recursive: true });
      await esbuild.build({
        entryPoints: [resolve(rootDir, "src/offscreen/offscreen.ts")],
        bundle: true,
        outfile: resolve(dist, "offscreen/offscreen.js"),
        format: "iife",
        target: "es2022",
        platform: "browser",
        sourcemap: false,
      });
      cpSync(
        resolve(rootDir, "src/offscreen/offscreen.html"),
        resolve(dist, "offscreen/offscreen.html"),
      );

      const manifest = JSON.parse(
        readFileSync(resolve(rootDir, "manifest.json"), "utf-8"),
      ) as Record<string, unknown>;
      writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

      for (const file of ["opencv.js", "opencv_js.wasm", "icon16.png", "icon32.png", "icon48.png", "icon128.png"]) {
        const src = resolve(rootDir, "public", file);
        if (existsSync(src)) {
          cpSync(src, resolve(dist, file));
        }
      }
      const publicIcons = resolve(rootDir, "public", "icons");
      if (existsSync(publicIcons)) {
        cpSync(publicIcons, resolve(dist, "icons"), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), chromeExtensionPlugin()],
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
        editor: resolve(rootDir, "editor.html"),
        options: resolve(rootDir, "options.html"),
      },
    },
  },
});
