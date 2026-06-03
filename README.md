## Nutrient Web SDK — Embedded External Toolbar Example

This React app migrates catalog example 81 (`81-embedded-external-toolbar`) into a standalone Create React App project.

It embeds Nutrient Web SDK with the primary viewer toolbar hidden and provides an external toolbar for:

- Starting content editing.
- Opening document/page reordering.
- Downloading the current PDF, including active content-editing or document-editor changes.

## Running the Example

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm start
```

Build for production:

```bash
npm run build
```

## Key Files

- `src/components/PdfViewerComponent.js` — React adapter that loads/unloads the migrated catalog example.
- `src/examples/embeddedExternalToolbar.js` — Migrated catalog example logic.
- `public/embedded-external-toolbar/static/styles.css` — Styles injected into the SDK contextual toolbar.
- `public/document.pdf` — Example document.

## License

This software is licensed under a [modified BSD license](LICENSE).
