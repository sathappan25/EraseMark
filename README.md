# EraseMark

EraseMark is a Manifest V3 Chrome extension for cleaning overlays on images **you own or are authorized to edit**. Paint over an unwanted overlay or damaged region, run local inpainting, preview before/after, and download the result.

This is an image restoration editor. It is **not** a tool for bypassing stock-photo licensing, paywalls, attribution requirements, DRM, or website access controls.

## What it does

- Upload a PNG, JPEG, or WEBP image from the popup or editor
- Right-click an image and choose **EraseMark → Clean This Image** for automatic cleanup + download (no editor tab)
- Or open the popup and use the **manual editor** to paint a mask, preview, and download
- Select an image from the current page with a hover highlighter (manual editor)
- Run browser-side inpainting (OpenCV.js Telea / Navier-Stokes, with a built-in JS fallback)
- Compare original and restored images with a before/after slider in the editor
- Quick clean downloads `erasemark-YYYY-MM-DD-HH-mm-ss.png`
- Manual editor can download `restored-image-YYYY-MM-DD-HH-MM-SS.png` or JPEG

All processing happens locally in your browser whenever possible. The extension does not upload images to a server and does not include analytics.

## Installation

```bash
npm install
npm run build
```

`npm install` also:

- Generates PNG icons
- Copies `public/opencv.js` from `@techstark/opencv-js` for `cv.inpaint()`

If OpenCV.js is missing, the extension still works with the built-in restoration engine.

## Development

```bash
npm install
npm run dev
```

`npm run dev` rebuilds `dist/` in watch mode. Reload the extension on `chrome://extensions` after each rebuild.

Chrome APIs (`chrome.contextMenus`, `chrome.downloads`, content scripts) only work when `dist/` is loaded as an unpacked extension.

## Build

```bash
npm run build
```

This type-checks the project and writes a loadable extension to `dist/`.

```bash
npm run preview
```

Previews the production Vite build in a browser. For real extension testing, load `dist/` in Chrome.

## Loading the unpacked extension in Chrome

1. Run `npm install` and `npm run build`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `dist` folder inside this project:

   `C:\Users\satha\OneDrive\Desktop\Image_Restore\dist`

6. Pin **EraseMark** from the puzzle-piece extensions menu.
7. Open any page, click the extension icon, and upload an image you are allowed to edit.

After code changes, run `npm run build` again, then click **Reload** on `chrome://extensions`.

## Permissions explanation

The extension requests only what the MVP needs:

| Permission | Why |
| --- | --- |
| `activeTab` | Access the current tab after you click the extension or context menu, so page images can be captured |
| `scripting` | Inject the page image picker / capture helper only when you invoke the extension |
| `contextMenus` | Add **EraseMark → Clean This Image** |
| `downloads` | Save restored files |
| `notifications` | Show quick-restore progress and results |
| `offscreen` | Run canvas / OpenCV processing in a hidden document (service workers cannot use DOM APIs) |
| `storage` | Save settings, recent thumbnails, and the active editor image id |
| `host_permissions` (`http://*/*`, `https://*/*`) | Required so the hidden offscreen document can `fetch()` a right-clicked image URL locally. This is not `<all_urls>` and is not used to bypass CORS proxies or site access controls. |

If Chrome still cannot read a particular image (CORS / canvas taint), quick restore shows:

> This image cannot be accessed directly. Try Manual Restore.

The extension does not use CORS proxies or external servers.

## Architecture

```
Quick restore (context menu)
  → background service worker
  → capture image in the active tab
  → hidden offscreen document
  → overlay detector + OpenCV.js inpaint()
  → chrome.downloads.download()
  → notification
  (no editor.html, no new tab)

Manual restore (popup)
  → IndexedDB image store
  → editor.html
  → paint mask
  → preview / download
```

Heavy work never runs inside the popup. Context-menu restore never opens a visible page.

Key files:

- `manifest.json` — Manifest V3 metadata
- `src/background/background.ts` — service worker, context menu, messaging
- `src/background/restoreAndDownload.ts` — quick restore orchestration
- `src/offscreen/offscreen.ts` — hidden canvas / OpenCV processing
- `src/utils/watermarkDetector.ts` — conservative automatic overlay detector
- `src/content/imageSelector.ts` — on-demand page image picker / capture
- `src/popup/Popup.tsx` — launcher UI
- `src/editor/Editor.tsx` — full manual editor
- `src/utils/inpaint.ts` — OpenCV initialization and restore pipeline
- `src/settings/Settings.tsx` — theme, brush, radius, output defaults

## How inpainting works

1. The original image is drawn onto a canvas at native resolution.
2. Your brush strokes are stored on a second mask canvas of the same pixel size.
3. Painted pixels are white; untouched pixels are black.
4. The visible overlay is only a semi-transparent preview. The original pixels stay untouched until Restore.
5. `initializeOpenCV()` loads `opencv.js` and waits until the runtime is ready.
6. `restoreImage()` reads both canvases into OpenCV `Mat`s, runs `cv.inpaint()` with `cv.INPAINT_TELEA` (or `cv.INPAINT_NS`), converts the result back to `ImageData`, and calls `Mat.delete()` on every allocated matrix.
7. If OpenCV is unavailable, `src/utils/inpaintFallback.ts` fills the masked region locally.

Inpainting radius options: 3, 5. Default: 3. Quick clean always uses Telea with radius 3.

Painting stays aligned when the display size differs from the image size, including zoom, pan, and device pixel ratio. Coordinates are mapped from the viewport back to original image pixels.

Quick clean uses a conservative overlay detector (`src/utils/watermarkDetector.ts`). It only inpaints when confidence is at least **0.80**, the mask contains pixels, and the mask covers at most **15%** of the image. Inpainting runs on a tight padded crop (8px) with radius **3** (`cv.INPAINT_TELEA`), then only masked pixels are copied back onto the original image. If detection is uncertain or the mask is too large, the original is not downloaded and you are asked to use Manual Restore.

## Privacy

Images are processed locally in your browser whenever possible. Images are not uploaded to a server by this extension.

Settings are stored with `chrome.storage.local`. Full images are kept in IndexedDB on your machine. There is no telemetry.

## Known limitations

- Inpainting quality depends on the surrounding pixels. Large, textured, or high-contrast overlays may leave visible artifacts.
- Very large images can be slow or memory-intensive. A warning is shown when the image is extremely large.
- Undo/redo stores up to 20 mask states.
- JPEG download uses a quality slider; PNG is lossless.
- OpenCV.js is a large optional file. Without it, the JS fallback still runs but may look softer.
- Automatic quick clean is conservative. Many images will correctly report that no editable area was selected. Use the manual editor for those.

## CORS limitations

Chrome may block reading images hosted on another origin if that origin does not allow canvas/pixel access.

When that happens, EraseMark will not try to work around browser security. Quick clean shows a notification asking you to download the image and use the manual editor if you are authorized to edit it.

The picker also cannot run on internal Chrome pages such as `chrome://extensions`.

## Chrome Web Store preparation

Before submitting:

1. Build a clean `dist/` with `npm run build`.
2. Zip the **contents** of `dist/` (including `manifest.json`, HTML, JS, icons, and `opencv.js` if present).
3. Create 1280×800 or 640×400 screenshots of the popup, editor mask, before/after slider, and settings/privacy text.
4. Write a store listing that clearly says this is a local restoration editor for images the user owns or is authorized to edit.
5. Host a privacy policy stating that images are processed locally and are not uploaded.
6. Confirm the requested permissions match the listing explanation.
7. Test on a fresh Chrome profile: upload, context menu, page select, CORS failure message, restore, download, dark/light theme.
8. Do not market the extension as a watermark stripper or license-bypass tool.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm install` | Install dependencies, generate icons, copy OpenCV.js |
| `npm run dev` | Watch-build `dist/` for Chrome |
| `npm run build` | Type-check and produce `dist/` |
| `npm run preview` | Preview the production web build |

## License

Use this extension only on images you own or have permission to modify.
