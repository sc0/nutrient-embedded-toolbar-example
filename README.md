## Nutrient Web SDK — Embedded External Toolbar Example

This React app demonstrates a DocuSign-style editing workflow with the Nutrient Web SDK build from this checkout.

The app hides the default viewer toolbar and provides external controls for:

- Entering content editing mode.
- Creating and deleting text blocks.
- Formatting text with the current headless content editor APIs: paragraph presets, font family, size, bold, italic, strikethrough, color, alignment, line height, and list formatting.
- Inserting signer placeholders (`{{SignerName}}`, `{{Date}}`, and a signature line) into the active text block.
- Opening document/page reordering.
- Downloading the current PDF, including active content-editing or document-editor changes.

## Local SDK Link

`@nutrient-sdk/viewer` is linked to the local Web SDK build at:

```text
../PSPDFKit/web/web/dist/production/package
```

Build or refresh that package from `/Users/kdebowski/code/nutrient/PSPDFKit/web/web` before running this example:

```bash
SKIP_ACKNOWLEDGEMENTS=true pnpm build:no-cleanup
```

The build currently needs a small local package wrapper because declaration generation fails on this branch. The wrapper files live in the generated `dist/production/package` directory and are not committed.

## Running the Example

Install dependencies:

```bash
pnpm install --no-frozen-lockfile
```

Start the development server:

```bash
pnpm start
```

Build for production:

```bash
pnpm build
```

`prestart` and `prebuild` copy `dist/nutrient-viewer-lib` from the linked package into `public/nutrient-viewer-lib`, removing stale SDK assets first.

## Key Files

- `src/components/PdfViewerComponent.js` — React adapter that loads/unloads the example.
- `src/example/embeddedExternalToolbar.js` — Custom toolbar and content editor integration.
- `public/embedded-external-toolbar/static/styles.css` — Styles injected into the SDK contextual toolbar.
- `public/document.pdf` — Example document.

## License

This software is licensed under a [modified BSD license](LICENSE).
