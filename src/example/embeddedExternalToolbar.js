import React from "react";

// ─────────────────────────────────────────────────────────────────────────
// Embedded external toolbar — headless content editing
//
// This example drives the content editor entirely through the headless
// `instance.contentEditor` namespace and the `contentEditor.stateChange`
// event, plus the session-level helpers on `Instance`:
//
//   Session:      instance.contentEditor.isActive()
//                 instance.saveContentEditingSession()
//                 instance.discardContentEditingSession()
//                 instance.hasUnsavedContentEditingChanges()
//                 instance.exportContentEditorPDF()
//   Blocks:       getBlocks() / getBlock() / getActiveBlock() / getSelectedBlock()
//                 selectBlock() / focusBlock()
//                 createTextBlock() / deleteBlock() / deleteActiveBlock()
//                 enterCreateMode() / exitCreateMode() / isInCreateMode()
//   Text:         getCurrentStyle() / setTextStyle({ bold, italic,
//                   strikethrough, family, size, color })
//                 selectAllText() / setTextSelection() / insertText()
//                 setListFormatting()
//   Layout:       setLayout({ alignment, lineSpacingFactor, maxWidth })
//   History:      undo() / redo() / canUndo()
//   Fonts:        getAvailableFonts() / getFontMismatches() / getSubsetFonts()
//
// `exportContentEditorPDF()` is standalone-only, so run this example in
// standalone mode to download an in-session snapshot.
// ─────────────────────────────────────────────────────────────────────────

let PSPDFKit = null;

async function getNutrientViewer() {
  if (PSPDFKit) {
    return PSPDFKit;
  }

  const module = await import("@nutrient-sdk/viewer");
  PSPDFKit = module.default || module;

  return PSPDFKit;
}

let instance = null;
let globalSetDownloadState = null;

const DOWNLOAD_PROXY_CLASS = "external-document-editor-download-proxy";

// Example paragraph-style presets for the first dropdown in the content editing
// toolbar. They intentionally don't force a font family, so the preset works
// with whatever fonts the current document/session exposes.
const PARAGRAPH_STYLE_PRESETS = [
  {
    id: "body",
    label: "Body Text",
    textStyle: { bold: false, italic: false, strikethrough: false, size: 16 },
    layout: { lineSpacingFactor: 1.5 },
  },
  {
    id: "h1",
    label: "Heading 1",
    textStyle: { bold: true, italic: false, strikethrough: false, size: 32 },
    layout: { lineSpacingFactor: 1.15 },
  },
  {
    id: "h2",
    label: "Heading 2",
    textStyle: { bold: true, italic: false, strikethrough: false, size: 24 },
    layout: { lineSpacingFactor: 1.15 },
  },
  {
    id: "h3",
    label: "Heading 3",
    textStyle: { bold: true, italic: false, strikethrough: false, size: 20 },
    layout: { lineSpacingFactor: 1.15 },
  },
];

// Signer placeholders inserted via `insertText()` at the cursor of the active
// text block.
const INSERT_SNIPPETS = [
  { id: "signer-name", label: "{{SignerName}}", text: "{{SignerName}}" },
  { id: "date", label: "{{Date}}", text: "{{Date}}" },
  { id: "signature-line", label: "Signature line", text: "\nX ____________________" },
];

function createDocumentEditorDownloadProxy() {
  const node = document.createElement("span");
  node.textContent = "Download";

  return {
    type: "custom",
    id: DOWNLOAD_PROXY_CLASS,
    node,
    className: DOWNLOAD_PROXY_CLASS,
    onPress: (_event, documentEditorUIHandler) => {
      if (!instance) {
        return;
      }

      documentEditorUIHandler.setOperations((operations) => {
        const pendingOperations = operations.flatten().toArray();
        const exportPromise = pendingOperations.length
          ? instance.exportPDFWithOperations(pendingOperations)
          : instance.exportPDF();

        exportAndDownload(exportPromise);

        return operations;
      }, false);
    },
  };
}

// Render the custom content editing secondary toolbar via the `tools.contextual`
// slot. The slot's `render()` is called once when the SDK mounts the secondary
// toolbar; we hand back a self-contained DOM tree that subscribes to the new
// `contentEditor.stateChange` and `viewState.change` events and reflects the live
// session state onto the controls (pressed states, available values, enablement).
//
// When the user isn't in content editing mode we hide the root via `display:none`
// — returning `null` from render would only work for the initial paint, since the
// SDK doesn't re-invoke `render()` on state changes.
function contextualToolsSlot(getInstance) {
  return {
    render: () => renderContentEditingToolbar(getInstance),
  };
}

function renderContentEditingToolbar(getInstance) {
  const root = document.createElement("div");
  root.className = "ceToolbar";
  // Start hidden — `bindToolbar` will reveal the toolbar once content editing
  // becomes active.
  root.style.display = "none";

  // The SDK deactivates the currently-edited text block on any `mousedown`
  // that lands outside it. Pre-empt that on every toolbar element so a click
  // on a button or dropdown trigger keeps the active block alive — otherwise
  // `setTextStyle()` would no-op because the block is no longer in Active state
  // by the time the click handler runs.
  //
  // `preventDefault` blocks the focus shift (so the hidden textarea inside the
  // active block keeps focus and remains in Active state); `stopPropagation`
  // stops the SDK's document-level pointer handlers from dispatching a
  // "deactivate text block" action when they see a pointerdown outside any
  // text block.
  const swallowMouseDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("mousedown", swallowMouseDown);
  root.addEventListener("pointerdown", swallowMouseDown);

  const inner = document.createElement("div");
  inner.className = "ceToolbar__inner";
  root.appendChild(inner);

  // Build all of the static markup once; the only thing that changes between
  // renders is the values inside controls and the disabled / pressed states.
  const undoBtn = makeIconButton("undo", "↺", "Undo");
  const redoBtn = makeIconButton("redo", "↻", "Redo");

  const addBtn = makeSelectButton(makeAddGlyph(), { compact: true, ariaLabel: "Add text block" });
  const deleteBtn = makeIconButton("delete", makeTrashGlyph(), "Delete block");

  const bodyTextSelect = makeSelectButton("Body Text");
  const fontSelect = makeSelectButton("Arial");
  const sizeSelect = makeSelectButton("16");

  const boldBtn = makeToggleButton("bold", makeBoldGlyph(), "Bold");
  const italicBtn = makeToggleButton("italic", makeItalicGlyph(), "Italic");
  const strikeBtn = makeToggleButton("strikethrough", makeStrikethroughGlyph(), "Strikethrough");

  const colorBtn = makeColorButton(getInstance);

  const alignBtn = makeSelectButton(makeAlignGlyph(), { compact: true, ariaLabel: "Alignment" });
  const lineHeightBtn = makeSelectButton(makeLineHeightGlyph(), {
    compact: true,
    ariaLabel: "Line height",
  });
  const listBtn = makeSelectButton(makeListGlyph(), { compact: true, ariaLabel: "List" });

  const selectionBtn = makeSelectButton(makeSelectionGlyph(), {
    compact: true,
    ariaLabel: "Selection",
  });
  const insertBtn = makeSelectButton(makeInsertGlyph(), { compact: true, ariaLabel: "Insert text" });
  const infoBtn = makeIconButton("info", makeInfoGlyph(), "Document & font info");

  const dirtyDot = document.createElement("span");
  dirtyDot.className = "ceToolbar__dirtyDot";
  dirtyDot.title = "Unsaved changes";

  const discardBtn = document.createElement("button");
  discardBtn.className = "ceToolbar__discard";
  discardBtn.type = "button";
  discardBtn.textContent = "Discard";

  const saveBtn = document.createElement("button");
  saveBtn.className = "ceToolbar__save";
  saveBtn.type = "button";
  saveBtn.textContent = "Save";

  const groupHistory = makeGroup([undoBtn, redoBtn]);
  const groupBlocks = makeGroup([addBtn, deleteBtn]);
  const groupParagraph = makeGroup([bodyTextSelect]);
  const groupFont = makeGroup([fontSelect, sizeSelect]);
  const groupInline = makeGroup([boldBtn, italicBtn, strikeBtn, colorBtn]);
  const groupBlockLayout = makeGroup([alignBtn, lineHeightBtn, listBtn]);
  const groupText = makeGroup([selectionBtn, insertBtn]);
  const groupInspect = makeGroup([infoBtn]);

  inner.append(
    groupHistory,
    groupBlocks,
    groupParagraph,
    groupFont,
    groupInline,
    groupBlockLayout,
    groupText,
    groupInspect,
  );

  const actions = document.createElement("div");
  actions.className = "ceToolbar__actions";
  actions.append(dirtyDot, discardBtn, saveBtn);
  root.append(actions);

  // The SDK invokes `render()` once, before the instance is necessarily
  // available. Poll until `getInstance()` returns the loaded instance, then
  // wire up listeners and event handlers.
  let bound = false;
  const tryBind = () => {
    if (bound) return;
    const viewerInstance = getInstance();
    if (!viewerInstance || !viewerInstance.contentEditor) return;
    bound = true;
    bindToolbar(viewerInstance, root, {
      undoBtn,
      redoBtn,
      addBtn,
      deleteBtn,
      boldBtn,
      italicBtn,
      strikeBtn,
      colorBtn,
      fontSelect,
      sizeSelect,
      bodyTextSelect,
      alignBtn,
      lineHeightBtn,
      listBtn,
      selectionBtn,
      insertBtn,
      infoBtn,
      dirtyDot,
      discardBtn,
      saveBtn,
    });
  };

  tryBind();
  if (!bound) {
    const interval = window.setInterval(() => {
      tryBind();
      if (bound) window.clearInterval(interval);
    }, 50);
    // Stop polling after 30s; the slot is harmless if we never bind.
    window.setTimeout(() => window.clearInterval(interval), 30_000);
  }

  return root;
}

function bindToolbar(viewerInstance, root, els) {
  const {
    undoBtn,
    redoBtn,
    addBtn,
    deleteBtn,
    boldBtn,
    italicBtn,
    strikeBtn,
    colorBtn,
    fontSelect,
    sizeSelect,
    bodyTextSelect,
    alignBtn,
    lineHeightBtn,
    listBtn,
    selectionBtn,
    insertBtn,
    infoBtn,
    dirtyDot,
    discardBtn,
    saveBtn,
  } = els;

  const ce = () => viewerInstance.contentEditor;

  // ── Subscribe to state changes and reflect them onto the controls ──
  let currentToolbarStyle = null;
  let currentAlignment = null;
  let currentLineSpacing = null;

  const setTriggerLabel = (trigger, text) => {
    const el = trigger.querySelector(".ceToolbar__selectLabel");
    if (el) el.textContent = text;
  };

  const applySnapshot = (snapshot) => {
    const isActive = !!snapshot?.isActive;
    const blockId = snapshot?.activeBlockId || snapshot?.selectedBlockId || null;
    const selectedBlock = blockId ? ce().getBlock(blockId) : null;
    const style = snapshot?.currentStyle ?? selectedBlock?.style ?? null;
    currentToolbarStyle = style;

    // Alignment and line spacing are reported through `currentStyle` for the
    // cursor/selection and through `getBlock(id).layout` at block level.
    currentAlignment =
      snapshot?.currentStyle?.alignment ?? selectedBlock?.layout?.alignment ?? null;
    currentLineSpacing =
      snapshot?.currentStyle?.lineSpacingFactor ?? selectedBlock?.layout?.lineSpacingFactor ?? null;

    // Enable formatting/layout controls whenever a content editing session is
    // active. Clicks fall through to no-ops at the API layer when no specific
    // block is in edit mode, so the user doesn't have to think about that.
    for (const btn of [
      boldBtn,
      italicBtn,
      strikeBtn,
      colorBtn,
      fontSelect,
      sizeSelect,
      bodyTextSelect,
      alignBtn,
      lineHeightBtn,
      listBtn,
      selectionBtn,
      insertBtn,
      infoBtn,
      addBtn,
    ]) {
      setDisabled(btn, !isActive);
    }

    // Delete only makes sense with a target block.
    setDisabled(deleteBtn, !isActive || !blockId);

    // canUndo() reports whether a block can receive history commands; redo
    // availability is not reported separately (core exposes no stack depth),
    // so the redo button follows the same signal.
    setDisabled(undoBtn, !isActive || !ce().canUndo());
    setDisabled(redoBtn, !isActive || !ce().canUndo());

    // Reflect create-mode as a pressed state on the Add button.
    setPressed(addBtn, isActive && ce().isInCreateMode());

    setPressed(boldBtn, !!style?.bold);
    setPressed(italicBtn, !!style?.italic);
    setPressed(strikeBtn, !!style?.strikethrough);

    // Update labels only when the snapshot reports a concrete value. For an
    // active block, `currentStyle` is the cursor/selection style. For a block
    // that was only single-clicked, `currentStyle` is null, so we fall back to
    // `getBlock(id).style`, which reports uniform block-level values and null
    // for mixed values.
    if (style?.family) {
      setTriggerLabel(fontSelect, style.family);
    }

    if (typeof style?.size === "number") {
      setTriggerLabel(sizeSelect, String(style.size));
    }

    setSwatch(colorBtn, style?.color ?? "#1a1a1a");

    // Session-level dirty flag drives the unsaved-changes indicator.
    const dirty = isActive && !!snapshot?.isDirty;
    dirtyDot.classList.toggle("is-visible", dirty);

    saveBtn.disabled = !isActive;
    discardBtn.disabled = !isActive;
  };

  const applyVisibility = () => {
    const inContentEditor =
      viewerInstance.viewState.interactionMode === PSPDFKit.InteractionMode.CONTENT_EDITOR;
    root.style.display = inContentEditor ? "" : "none";
  };

  let didConnect = false;
  let observer = null;

  function cleanupToolbar() {
    viewerInstance.removeEventListener("contentEditor.stateChange", onStateChange);
    viewerInstance.removeEventListener("viewState.change", onViewStateChange);
    observer?.disconnect();
  }

  // The toolbar can be mounted inside the viewer's shadow/document tree, so
  // `document.body.contains(root)` may be false even while the toolbar is
  // still connected. Track connectivity via `isConnected` and only clean up
  // after the node was seen connected once — otherwise the listeners would be
  // removed right after save, preventing the toolbar from appearing again when
  // content editing is re-entered.
  const checkConnected = () => {
    if (root.isConnected) {
      didConnect = true;
      return true;
    }
    if (didConnect) {
      cleanupToolbar();
      return false;
    }
    return true;
  };

  const refresh = () => {
    if (!checkConnected()) return;
    applyVisibility();
    applySnapshot(buildInitialSnapshot(viewerInstance));
  };

  refresh();

  // `contentEditor.stateChange` delivers a complete, deduplicated snapshot of
  // the session state (active/dirty flags, block ids, current style), so the
  // event payload alone drives the toolbar. `viewState.change` only toggles
  // visibility when the interaction mode flips.
  const onStateChange = (snapshot) => {
    if (!checkConnected()) return;
    applyVisibility();
    applySnapshot(snapshot);
  };
  const onViewStateChange = () => refresh();

  viewerInstance.addEventListener("contentEditor.stateChange", onStateChange);
  viewerInstance.addEventListener("viewState.change", onViewStateChange);

  // Clean up the listeners when the slot's DOM node is removed.
  observer = new MutationObserver(() => checkConnected());
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Wire interactions ──────────────────────────────────────────────
  //
  // The formatting methods that mutate live state (setTextStyle in particular)
  // assert that a text block is in Active state (cursor inside). If the user
  // has only single-clicked a block (Selected state, not Active), we promote
  // it to Active first via `focusBlock` so style changes land on the
  // intended block.
  const ensureActiveBlock = () => {
    const activeId = ce().getActiveBlock();
    if (activeId) return activeId;
    const selectedId = ce().getSelectedBlock();
    if (selectedId) {
      ce().focusBlock(selectedId);
      return selectedId;
    }
    return null;
  };

  // `setTextStyle()` applies to the current text selection inside an active
  // block. For the "whole block is selected" case (single-clicked block,
  // not editing a text range), the toolbar selects the block's entire text via
  // `selectAllText()` — which also promotes the block to Active — before
  // applying the style. If a block is already Active, we leave its current
  // cursor/range untouched so formatting still works for a particular text
  // selection.
  const applyStyleToCurrentTarget = async (style) => {
    const activeId = ce().getActiveBlock();

    if (activeId) {
      ce().setTextStyle(style);
      return activeId;
    }

    const selectedId = ce().getSelectedBlock();

    if (!selectedId) return null;

    await ce().selectAllText(selectedId);
    ce().setTextStyle(style);

    return selectedId;
  };

  const applyTextCommandToCurrentTarget = async (command) => {
    const activeId = ce().getActiveBlock();

    if (activeId) {
      await command();
      return activeId;
    }

    const selectedId = ce().getSelectedBlock();

    if (!selectedId) return null;

    ce().focusBlock(selectedId);
    await command();

    return selectedId;
  };

  const applyParagraphStylePreset = async (preset) => {
    const targetId = ce().getActiveBlock() || ce().getSelectedBlock();

    if (!targetId) return false;

    // Paragraph presets are block-level controls: applying "Heading 1" should
    // update the complete text block, not just the cursor insertion style or a
    // partial text selection. `selectAllText()` activates the block if needed.
    await ce().selectAllText(targetId);
    ce().setTextStyle(preset.textStyle);
    await ce().setLayout(targetId, preset.layout);

    return true;
  };

  // ── History ────────────────────────────────────────────────────────
  undoBtn.addEventListener("click", () => {
    if (!ensureActiveBlock()) return;
    ce().undo();
  });
  redoBtn.addEventListener("click", () => {
    if (!ensureActiveBlock()) return;
    ce().redo();
  });

  // ── Inline styles ──────────────────────────────────────────────────
  boldBtn.addEventListener("click", () => {
    void applyStyleToCurrentTarget({ bold: !ce().getCurrentStyle()?.bold });
  });

  italicBtn.addEventListener("click", () => {
    void applyStyleToCurrentTarget({ italic: !ce().getCurrentStyle()?.italic });
  });

  strikeBtn.addEventListener("click", () => {
    void applyStyleToCurrentTarget({ strikethrough: !ce().getCurrentStyle()?.strikethrough });
  });

  // Update the color input's onInput handler too — the existing one in
  // makeColorButton only applies to the cursor/selection; for the whole-block
  // intent of the top toolbar, do select-all first.
  const colorInput = colorBtn.querySelector("input[type='color']");
  if (colorInput) {
    colorInput.replaceWith(colorInput.cloneNode(true));
    const fresh = colorBtn.querySelector("input[type='color']");
    fresh.addEventListener("input", (event) => {
      const value = event.target.value;
      setSwatch(colorBtn, value);
      void applyStyleToCurrentTarget({ color: value });
    });
  }

  // ── Blocks: create-mode + direct create ────────────────────────────
  attachDropdown(root, addBtn, {
    getItems: () => [
      { id: "draw", label: ce().isInCreateMode() ? "Stop drawing text boxes" : "Draw a text box" },
      { id: "center", label: "Add a text box at page center" },
    ],
    getSelectedId: () => (ce().isInCreateMode() ? "draw" : null),
    onSelect: async (item) => {
      if (item.id === "draw") {
        // enterCreateMode / exitCreateMode / isInCreateMode
        if (ce().isInCreateMode()) ce().exitCreateMode();
        else ce().enterCreateMode();
        return;
      }

      // createTextBlock returns the id of the new block; focus it so the user
      // can type straight away.
      const pageIndex = viewerInstance.viewState.currentPageIndex ?? 0;
      const { width, height } = viewerInstance.pageInfoForIndex(pageIndex);
      const newId = await ce().createTextBlock({
        pageIndex,
        anchor: { x: width / 2, y: height / 2 },
      });
      ce().focusBlock(newId);
    },
  });

  // ── Blocks: delete ─────────────────────────────────────────────────
  deleteBtn.addEventListener("click", async () => {
    if (!ce().getActiveBlock() && !ce().getSelectedBlock()) return;
    try {
      await ce().deleteActiveBlock();
    } catch (err) {
      console.error("Failed to delete block:", err);
    }
  });

  // ── Paragraph presets ──────────────────────────────────────────────
  attachDropdown(root, bodyTextSelect, {
    getItems: () => PARAGRAPH_STYLE_PRESETS,
    getSelectedId: () => bodyTextSelect.dataset.selectedId ?? "body",
    onSelect: async (item) => {
      const applied = await applyParagraphStylePreset(item);

      // Keep the paragraph-style trigger in sync immediately. The actual style
      // changes are applied above to the active/selected text block when one is
      // available.
      bodyTextSelect.dataset.selectedId = item.id;
      setTriggerLabel(bodyTextSelect, item.label);

      // Reflect the preset in related controls right away; the snapshot-driven
      // refresh will keep them correct after the SDK state catches up.
      if (applied) {
        setTriggerLabel(sizeSelect, String(item.textStyle.size));
        setPressed(boldBtn, item.textStyle.bold);
        setPressed(italicBtn, item.textStyle.italic);
        setPressed(strikeBtn, !!item.textStyle.strikethrough);
      }
    },
  });

  // ── Font family (getAvailableFonts) ────────────────────────────────
  attachDropdown(root, fontSelect, {
    getItems: () => {
      const fonts = ce().getAvailableFonts();
      const families = Array.from(new Set(fonts.map((f) => f.family))).sort((a, b) =>
        a.localeCompare(b),
      );
      return families.map((family) => ({ id: family, label: family }));
    },
    getSelectedId: () => currentToolbarStyle?.family ?? null,
    onSelect: (item) => {
      void applyStyleToCurrentTarget({ family: item.id });
      // Update the trigger immediately; the snapshot-driven refresh would only
      // beat us to it on the synchronous code path, and even there
      // selectionStyleInfo can shadow the just-applied value.
      setTriggerLabel(fontSelect, item.label);
    },
    itemStyle: (item) => ({ fontFamily: item.id }),
  });

  // ── Font size ──────────────────────────────────────────────────────
  attachDropdown(root, sizeSelect, {
    getItems: () =>
      [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64].map((size) => ({
        id: String(size),
        label: String(size),
        meta: size,
      })),
    getSelectedId: () => {
      const size = currentToolbarStyle?.size;
      return typeof size === "number" ? String(size) : null;
    },
    onSelect: (item) => {
      void applyStyleToCurrentTarget({ size: item.meta });
      setTriggerLabel(sizeSelect, item.label);
    },
  });

  // ── Alignment (setLayout) ──────────────────────────────────────────
  attachDropdown(root, alignBtn, {
    getItems: () => [
      { id: "begin", label: "Left" },
      { id: "center", label: "Center" },
      { id: "end", label: "Right" },
      { id: "justified", label: "Justify" },
    ],
    getSelectedId: () => currentAlignment,
    onSelect: async (item) => {
      const targetId = ensureActiveBlock();
      if (!targetId) return;
      await ce().setLayout(targetId, { alignment: item.id });
    },
  });

  // ── Line height (setLayout) ────────────────────────────────────────
  attachDropdown(root, lineHeightBtn, {
    getItems: () =>
      [1, 1.15, 1.5, 2].map((factor) => ({
        id: String(factor),
        label: `${factor}×`,
        meta: factor,
      })),
    getSelectedId: () =>
      // Match against the preset factors while tolerating float noise from the
      // reported layout state.
      typeof currentLineSpacing === "number"
        ? String(Math.round(currentLineSpacing * 100) / 100)
        : null,
    onSelect: async (item) => {
      const targetId = ensureActiveBlock();
      if (!targetId) return;
      await ce().setLayout(targetId, { lineSpacingFactor: item.meta });
    },
  });

  // ── List formatting (setListFormatting) ────────────────────────────
  attachDropdown(root, listBtn, {
    getItems: () => [
      { id: "none", label: "No list" },
      { id: "bullet", label: "Bulleted" },
      { id: "numbered", label: "Numbered" },
    ],
    getSelectedId: () => listBtn.dataset.selectedId ?? "none",
    onSelect: async (item) => {
      const targetId = await applyTextCommandToCurrentTarget(() =>
        ce().setListFormatting(item.id),
      );

      if (targetId) listBtn.dataset.selectedId = item.id;
    },
  });

  // ── Selection (selectAllText / setTextSelection) ───────────────────
  attachDropdown(root, selectionBtn, {
    getItems: () => [
      { id: "all", label: "Select all text" },
      { id: "first-line", label: "Select first line" },
      { id: "clear", label: "Clear selection" },
    ],
    getSelectedId: () => null,
    onSelect: (item) => {
      const targetId = ensureActiveBlock();
      if (!targetId) return;

      if (item.id === "all") {
        // selectAllText works whether or not the block is already Active.
        ce().selectAllText(targetId);
        return;
      }

      if (item.id === "clear") {
        // setTextSelection(id, null) clears the selection.
        ce().setTextSelection(targetId, null);
        return;
      }

      // setTextSelection(id, { begin, end }) over a character range.
      const block = ce().getBlock(targetId);
      const text = block?.text ?? "";
      const newline = text.indexOf("\n");
      const end = newline === -1 ? text.length : newline;
      ce().setTextSelection(targetId, { begin: 0, end });
    },
  });

  // ── Insert text (insertText) ───────────────────────────────────────
  attachDropdown(root, insertBtn, {
    getItems: () => INSERT_SNIPPETS,
    getSelectedId: () => null,
    onSelect: (item) => {
      // `focusBlock()` inside ensureActiveBlock takes effect synchronously, so
      // the block is Active by the time `insertText()` runs.
      if (!ensureActiveBlock()) return;
      ce().insertText(item.text);
    },
  });

  // ── Introspection panel ────────────────────────────────────────────
  infoBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (infoBtn.dataset.open === "true") {
      closeOpenDropdown();
      return;
    }
    closeOpenDropdown();
    openInfoPanel(root, infoBtn, viewerInstance);
  });

  // ── Session save / discard ─────────────────────────────────────────
  saveBtn.addEventListener("click", () => {
    viewerInstance
      .saveContentEditingSession()
      .then(() => refresh())
      .catch((err) => {
        console.error("Failed to save content editing session:", err);
      });
  });

  discardBtn.addEventListener("click", () => {
    if (viewerInstance.hasUnsavedContentEditingChanges()) {
      const ok = window.confirm("Discard all unsaved content editing changes?");
      if (!ok) return;
    }
    viewerInstance
      .discardContentEditingSession()
      .then(() => refresh())
      .catch((err) => console.error("Failed to discard content editing session:", err));
  });
}

// ── Introspection panel (getBlocks / getBlock / getActiveBlock /
//    getSelectedBlock / selectBlock / focusBlock / deleteBlock /
//    getCurrentStyle / getFontMismatches / getSubsetFonts /
//    getAvailableFonts) ──────────────────────────────────────────────────
function openInfoPanel(toolbarRoot, trigger, viewerInstance) {
  const ce = viewerInstance.contentEditor;

  const panel = document.createElement("div");
  panel.className = "ceToolbar__dropdown ceInfoPanel";

  const rebuild = () => {
    panel.innerHTML = "";

    const pageIndex = viewerInstance.viewState.currentPageIndex ?? 0;
    const pageBlocks = ce.getBlocks(pageIndex);
    const allBlocks = ce.getBlocks();
    const activeId = ce.getActiveBlock();
    const selectedId = ce.getSelectedBlock();
    const style = ce.getCurrentStyle();
    const fonts = ce.getAvailableFonts();
    const mismatches = ce.getFontMismatches();
    const subsets = ce.getSubsetFonts();

    panel.appendChild(
      makeInfoSection("Session", [
        `Active: ${ce.isActive() ? "yes" : "no"}`,
        `Blocks on page ${pageIndex + 1}: ${pageBlocks.length}`,
        `Blocks in document: ${allBlocks.length}`,
        `Active block: ${activeId ?? "—"}`,
        `Selected block: ${selectedId ?? "—"}`,
      ]),
    );

    if (style) {
      panel.appendChild(
        makeInfoSection("Current style", [
          `Font: ${style.family ?? "mixed"}`,
          `Size: ${style.size ?? "mixed"}`,
          `Bold: ${describeTri(style.bold)}  Italic: ${describeTri(style.italic)}  Strike: ${describeTri(style.strikethrough)}`,
          `Color: ${style.color ?? "mixed"}`,
          `Align: ${style.alignment ?? "—"}  Line: ${style.lineSpacingFactor ?? "—"}`,
        ]),
      );
    }

    panel.appendChild(
      makeInfoSection("Fonts", [
        `Available faces: ${fonts.length}`,
        `Mismatches: ${mismatches.length}`,
        ...mismatches.map(
          (m) => `  • ${m.unavailableFaceName ?? "(unnamed)"} — block ${short(m.textBlockId)}`,
        ),
        `Subset fonts: ${subsets.length}`,
        ...subsets.map((s) => `  • ${s.demangledName} (${s.originalName})`),
      ]),
    );

    // Block list with per-block actions.
    const blocksSection = document.createElement("div");
    blocksSection.className = "ceInfoPanel__section";
    const heading = document.createElement("div");
    heading.className = "ceInfoPanel__heading";
    heading.textContent = `Text blocks on page ${pageIndex + 1}`;
    blocksSection.appendChild(heading);

    if (pageBlocks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ceInfoPanel__line";
      empty.textContent = "No blocks detected yet — click into the page.";
      blocksSection.appendChild(empty);
    }

    for (const block of pageBlocks) {
      const row = document.createElement("div");
      row.className = "ceInfoPanel__block";

      const label = document.createElement("span");
      label.className = "ceInfoPanel__blockText";
      const preview = block.text.trim().replace(/\s+/g, " ").slice(0, 32) || "(empty)";
      label.textContent = preview;
      if (block.id === activeId) label.classList.add("is-active");
      else if (block.id === selectedId) label.classList.add("is-selected");

      const selectAction = makeMiniButton("Select", () => {
        ce.selectBlock(block.id); // Selected state (clicked, not editing).
        rebuild();
      });
      const editAction = makeMiniButton("Edit", () => {
        ce.focusBlock(block.id); // Active state (cursor inside).
        rebuild();
      });
      const deleteAction = makeMiniButton("Delete", async () => {
        try {
          await ce.deleteBlock(block.id); // Delete a specific block by id.
        } catch (err) {
          console.error("Failed to delete block:", err);
        }
        rebuild();
      });

      const actions = document.createElement("span");
      actions.className = "ceInfoPanel__blockActions";
      actions.append(selectAction, editAction, deleteAction);

      row.append(label, actions);
      blocksSection.appendChild(row);
    }

    panel.appendChild(blocksSection);
  };

  rebuild();

  const rect = trigger.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  panel.style.top = `${Math.round(rect.bottom + 4)}px`;
  panel.style.zIndex = "9999";

  toolbarRoot.appendChild(panel);
  trigger.dataset.open = "true";
  trigger.classList.add("is-open");

  const closeOnOutside = (event) => {
    if (panel.contains(event.target) || trigger.contains(event.target)) return;
    closeOpenDropdown();
  };
  const closeOnEsc = (event) => {
    if (event.key === "Escape") closeOpenDropdown();
  };

  const ownerDocument = toolbarRoot.ownerDocument || document;
  ownerDocument.addEventListener("mousedown", closeOnOutside, true);
  ownerDocument.addEventListener("keydown", closeOnEsc, true);

  openDropdownCloser = () => {
    ownerDocument.removeEventListener("mousedown", closeOnOutside, true);
    ownerDocument.removeEventListener("keydown", closeOnEsc, true);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    delete trigger.dataset.open;
    trigger.classList.remove("is-open");
    openDropdownCloser = null;
  };
}

function makeInfoSection(title, lines) {
  const section = document.createElement("div");
  section.className = "ceInfoPanel__section";

  const heading = document.createElement("div");
  heading.className = "ceInfoPanel__heading";
  heading.textContent = title;
  section.appendChild(heading);

  for (const line of lines) {
    const el = document.createElement("div");
    el.className = "ceInfoPanel__line";
    el.textContent = line;
    section.appendChild(el);
  }
  return section;
}

function makeMiniButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ceInfoPanel__miniBtn";
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function describeTri(value) {
  if (value === null || value === undefined) return "mixed";
  return value ? "yes" : "no";
}

function short(id) {
  return typeof id === "string" ? id.slice(0, 6) : String(id);
}

// ── Dropdown helper ─────────────────────────────────────────────────────

let openDropdownCloser = null;

function attachDropdown(toolbarRoot, trigger, opts) {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();

    if (trigger.dataset.open === "true") {
      closeOpenDropdown();
      return;
    }

    closeOpenDropdown();
    openDropdown(toolbarRoot, trigger, opts);
  });
}

function openDropdown(toolbarRoot, trigger, { getItems, getSelectedId, onSelect, itemStyle }) {
  const items = getItems();
  if (!items.length) return;

  const selectedId = getSelectedId?.();

  const menu = document.createElement("div");
  menu.className = "ceToolbar__dropdown";

  for (const item of items) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "ceToolbar__dropdownItem";
    option.textContent = item.label;
    if (itemStyle) {
      Object.assign(option.style, itemStyle(item));
    }
    if (item.id === selectedId) {
      option.classList.add("is-selected");
    }
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(item);
      closeOpenDropdown();
    });
    menu.appendChild(option);
  }

  // Position the menu under the trigger using fixed positioning so it isn't
  // clipped by toolbar overflow. Fixed coordinates are viewport-relative,
  // which works correctly even inside a shadow root.
  const rect = trigger.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.minWidth = `${Math.max(120, Math.round(rect.width))}px`;
  menu.style.zIndex = "9999";

  toolbarRoot.appendChild(menu);
  trigger.dataset.open = "true";
  trigger.classList.add("is-open");

  const closeOnOutside = (event) => {
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeOpenDropdown();
  };
  const closeOnEsc = (event) => {
    if (event.key === "Escape") closeOpenDropdown();
  };

  // Use capture phase so we beat React/SDK handlers and close cleanly.
  const ownerDocument = toolbarRoot.ownerDocument || document;
  ownerDocument.addEventListener("mousedown", closeOnOutside, true);
  ownerDocument.addEventListener("keydown", closeOnEsc, true);

  openDropdownCloser = () => {
    ownerDocument.removeEventListener("mousedown", closeOnOutside, true);
    ownerDocument.removeEventListener("keydown", closeOnEsc, true);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    delete trigger.dataset.open;
    trigger.classList.remove("is-open");
    openDropdownCloser = null;
  };
}

function closeOpenDropdown() {
  if (openDropdownCloser) openDropdownCloser();
}

function buildInitialSnapshot(viewerInstance) {
  const ce = viewerInstance.contentEditor;
  return {
    isActive: ce.isActive(),
    isDirty: viewerInstance.hasUnsavedContentEditingChanges(),
    mode: null,
    activeBlockId: ce.getActiveBlock(),
    selectedBlockId: ce.getSelectedBlock(),
    currentStyle: ce.getCurrentStyle(),
  };
}

function setDisabled(button, disabled) {
  button.disabled = !!disabled;
  button.classList.toggle("is-disabled", !!disabled);
}

function setPressed(button, pressed) {
  if (pressed) {
    button.dataset.pressed = "true";
    button.classList.add("is-pressed");
  } else {
    delete button.dataset.pressed;
    button.classList.remove("is-pressed");
  }
}

function setSwatch(button, color) {
  const swatch = button.querySelector(".ceToolbar__colorSwatch");
  if (swatch) swatch.style.background = color;
  const input = button.querySelector("input[type='color']");
  if (input) input.value = color;
}

function makeIconButton(id, glyph, ariaLabel) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ceToolbar__iconBtn";
  btn.dataset.id = id;
  btn.setAttribute("aria-label", ariaLabel);

  if (typeof glyph === "string") {
    btn.textContent = glyph;
  } else {
    btn.appendChild(glyph);
  }
  return btn;
}

function makeToggleButton(id, glyph, ariaLabel) {
  const btn = makeIconButton(id, glyph, ariaLabel);
  btn.classList.add("ceToolbar__toggleBtn");
  return btn;
}

function makeSelectButton(label, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ceToolbar__select";
  if (opts.compact) btn.classList.add("ceToolbar__select--compact");
  if (opts.ariaLabel) btn.setAttribute("aria-label", opts.ariaLabel);

  const labelEl = document.createElement("span");
  labelEl.className = "ceToolbar__selectLabel";
  if (typeof label === "string") {
    labelEl.textContent = label;
  } else {
    labelEl.appendChild(label);
  }

  const chevron = document.createElement("span");
  chevron.className = "ceToolbar__chevron";
  chevron.textContent = "⌄";

  btn.append(labelEl, chevron);
  return btn;
}

function makeColorButton(getInstance) {
  const btn = document.createElement("label");
  btn.className = "ceToolbar__iconBtn ceToolbar__color";

  const glyph = document.createElement("span");
  glyph.className = "ceToolbar__colorGlyph";
  glyph.textContent = "A";

  const swatch = document.createElement("span");
  swatch.className = "ceToolbar__colorSwatch";

  const input = document.createElement("input");
  input.type = "color";
  input.className = "ceToolbar__colorInput";
  input.value = "#1a1a1a";
  input.addEventListener("input", (event) => {
    const value = event.target.value;
    setSwatch(btn, value);
    const viewerInstance = getInstance();
    if (!viewerInstance?.contentEditor?.getActiveBlock()) return;
    viewerInstance.contentEditor.setTextStyle({ color: value });
  });

  btn.append(glyph, swatch, input);
  return btn;
}

function makeGroup(children) {
  const group = document.createElement("div");
  group.className = "ceToolbar__group";
  for (const child of children) group.appendChild(child);
  return group;
}

function makeBoldGlyph() {
  return makeSvg(
    `<path d="M5.5 3h5a3.25 3.25 0 0 1 1.85 5.93A3.5 3.5 0 0 1 10.5 15h-5a.5.5 0 0 1-.5-.5v-11A.5.5 0 0 1 5.5 3Zm1.5 5h3.25a1.75 1.75 0 0 0 0-3.5H7V8Zm0 5.5h3.5a2 2 0 0 0 0-4H7v4Z" fill="currentColor"/>`,
  );
}

function makeItalicGlyph() {
  return makeSvg(
    `<path d="M7 3.5h6v1.5h-2.3l-2.4 8h2.2V14.5H4.5V13h2.3l2.4-8H7V3.5Z" fill="currentColor"/>`,
  );
}

function makeStrikethroughGlyph() {
  return makeSvg(
    `<path d="M3 9.25h14v1.5H3v-1.5Zm7-5.75c1.9 0 3.4 1 3.9 2.6l-1.45.5C12.1 5.6 11.2 5 10 5c-1.3 0-2.25.65-2.25 1.6 0 .7.5 1.1 1.5 1.4h-2.6A2.6 2.6 0 0 1 6.25 6.5C6.25 4.7 7.8 3.5 10 3.5Zm.8 8.5c1.1.3 1.7.75 1.7 1.55 0 1-1 1.7-2.4 1.7-1.55 0-2.6-.7-3-1.95l-1.5.5C6.1 15.4 7.75 16.5 10.1 16.5c2.35 0 4-1.2 4-3 0-.6-.18-1.1-.5-1.5h-2.8Z" fill="currentColor"/>`,
  );
}

function makeAlignGlyph() {
  return makeSvg(
    `<path d="M3 4h14v1.5H3V4Zm0 3.5h10V9H3V7.5Zm0 3.5h14v1.5H3V11Zm0 3.5h10V16H3v-1.5Z" fill="currentColor"/>`,
  );
}

function makeLineHeightGlyph() {
  return makeSvg(
    `<path d="M7 4h10v1.5H7V4Zm0 5.25h10v1.5H7v-1.5ZM7 14.5h10V16H7v-1.5ZM3.5 3.5h1.25l-.75 1h1v8h-1l.75 1H3.5l-1.25-1.5H3v-7h-.75L3.5 3.5Z" fill="currentColor"/>`,
  );
}

function makeListGlyph() {
  return makeSvg(
    `<path d="M7 4.5h10V6H7V4.5Zm0 4.75h10v1.5H7v-1.5ZM7 14h10v1.5H7V14ZM4.5 5.25a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm0 4.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm0 4.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" fill="currentColor"/>`,
  );
}

function makeAddGlyph() {
  return makeSvg(
    `<path d="M4 4h12v1.6H4V4Zm0 4.2h8v1.6H4V8.2Zm0 4.2h6V14H4v-1.6Zm10.25-1.2h1.5v2.55H18.3v1.5h-2.55V18h-1.5v-2.45H11.7v-1.5h2.55V11.2Z" fill="currentColor"/>`,
  );
}

function makeTrashGlyph() {
  return makeSvg(
    `<path d="M8 3h4a1 1 0 0 1 1 1v1h3v1.5h-1.1l-.7 8.7A2 2 0 0 1 12.2 18H7.8a2 2 0 0 1-2-1.8l-.7-8.7H4V5h3V4a1 1 0 0 1 1-1Zm.5 2h3V4.5h-3V5Zm-1.85 1.5.66 8.55a.5.5 0 0 0 .5.45h4.38a.5.5 0 0 0 .5-.45l.66-8.55H6.65ZM8.75 8h1.5v6h-1.5V8Zm2.5 0h1.5v6h-1.5V8Z" fill="currentColor"/>`,
  );
}

function makeSelectionGlyph() {
  return makeSvg(
    `<path d="M3 3h4v1.6H4.6V7H3V3Zm10 0h4v4h-1.6V4.6H13V3ZM3 13h1.6v2.4H7V17H3v-4Zm13.4 0H17v4h-4v-1.6h2.4V13ZM6.5 6.5h7v7h-7v-7Zm1.5 1.5v4h4v-4H8Z" fill="currentColor"/>`,
  );
}

function makeInsertGlyph() {
  return makeSvg(
    `<path d="M9.25 3h1.5v6.25H17v1.5h-6.25V17h-1.5v-6.25H3v-1.5h6.25V3Z" fill="currentColor"/>`,
  );
}

function makeInfoGlyph() {
  return makeSvg(
    `<path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 1.6a5.9 5.9 0 1 1 0 11.8 5.9 5.9 0 0 1 0-11.8ZM9.2 8.5h1.6v5H9.2v-5Zm0-2.6h1.6v1.6H9.2V5.9Z" fill="currentColor"/>`,
  );
}

function makeSvg(innerHTML) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = innerHTML;
  return svg;
}

export async function load(defaultConfiguration) {
  await getNutrientViewer();

  const initialViewState = new PSPDFKit.ViewState({
    showToolbar: false,
  });

  return PSPDFKit.load({
    ...defaultConfiguration,
    initialViewState,
    documentEditorToolbarItems: [],
    documentEditorConfiguration: {
      thumbnailDefaultSize: 250,
      thumbnailMaxSize: 250,
      thumbnailMinSize: 240,
    },
    documentEditorFooterItems: [
      ...PSPDFKit.defaultDocumentEditorFooterItems.filter((item) => item.type !== "save-as"),
      createDocumentEditorDownloadProxy(),
    ],
    ui: {
      ...(defaultConfiguration.ui || {}),
      tools: {
        ...((defaultConfiguration.ui && defaultConfiguration.ui.tools) || {}),
        contextual: contextualToolsSlot,
      },
    },
    styleSheets: [
      ...(defaultConfiguration.styleSheets || []),
      "/embedded-external-toolbar/static/styles.css",
    ],
  }).then((_instance) => {
    instance = _instance;

    return instance;
  });
}

export function unload(container) {
  instance = null;

  if (PSPDFKit) {
    PSPDFKit.unload(container);
  }
}

export const CustomContainer = React.forwardRef(({ instance: loaded }, ref) => {
  const viewerInstance = getViewerInstance(loaded);
  const [interactionMode, setInteractionMode] = React.useState(null);
  const [downloadState, setDownloadState] = React.useState({
    isDownloading: false,
    error: null,
  });

  React.useEffect(() => {
    globalSetDownloadState = setDownloadState;

    return () => {
      if (globalSetDownloadState === setDownloadState) {
        globalSetDownloadState = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!viewerInstance) {
      return;
    }

    setInteractionMode(viewerInstance.viewState.interactionMode);

    const handleViewStateChange = (viewState) => {
      setInteractionMode(viewState.interactionMode);
    };

    viewerInstance.addEventListener("viewState.change", handleViewStateChange);

    return () => {
      viewerInstance.removeEventListener("viewState.change", handleViewStateChange);
    };
  }, [viewerInstance]);

  const isEditing =
    PSPDFKit &&
    (interactionMode === PSPDFKit.InteractionMode.CONTENT_EDITOR ||
      interactionMode === PSPDFKit.InteractionMode.DOCUMENT_EDITOR);

  return (
    <div className="embeddedExample">
      {!isEditing && (
        <div className="externalToolbar" aria-label="External toolbar">
          <button
            className="toolbarButton"
            disabled={!viewerInstance}
            onClick={() => startContentEditor()}
          >
            Edit document
          </button>
          <button
            className="toolbarButton"
            disabled={!viewerInstance}
            onClick={() => startInteractionMode(PSPDFKit.InteractionMode.DOCUMENT_EDITOR)}
          >
            Reorder pages
          </button>
        </div>
      )}

      <div className="viewer" ref={ref} />

      <div className="downloadBar">
        <button
          className="downloadButton"
          disabled={!viewerInstance || downloadState.isDownloading}
          onClick={downloadCurrentDocument}
        >
          {downloadState.isDownloading ? "Preparing download…" : "Download"}
        </button>
        {downloadState.error && (
          <span className="downloadError" role="alert">
            {downloadState.error}
          </span>
        )}
      </div>

      <style>{styles}</style>
    </div>
  );

  function startInteractionMode(mode) {
    if (!viewerInstance || !PSPDFKit) return;
    viewerInstance.setViewState((viewState) => viewState.set("interactionMode", mode));
  }

  function startContentEditor() {
    // Content editing is entered through the interaction mode; the
    // `contentEditor` namespace intentionally has no enter/exit methods.
    startInteractionMode(PSPDFKit.InteractionMode.CONTENT_EDITOR);
  }

  function downloadCurrentDocument() {
    if (!viewerInstance || !PSPDFKit) {
      return;
    }

    if (interactionMode === PSPDFKit.InteractionMode.CONTENT_EDITOR) {
      if (typeof viewerInstance.exportContentEditorPDF !== "function") {
        showDownloadError(
          "Downloading active content editing changes requires exportContentEditorPDF().",
        );
        return;
      }

      exportAndDownload(viewerInstance.exportContentEditorPDF());
      return;
    }

    if (interactionMode === PSPDFKit.InteractionMode.DOCUMENT_EDITOR) {
      const proxyButton = viewerInstance.contentDocument.querySelector(`.${DOWNLOAD_PROXY_CLASS}`);

      if (proxyButton && typeof proxyButton.click === "function") {
        proxyButton.click();
      } else {
        showDownloadError("The document editor download action is not ready yet.");
      }

      return;
    }

    exportAndDownload(viewerInstance.exportPDF());
  }
});

function getViewerInstance(loaded) {
  return loaded?.instance || instance;
}

function exportAndDownload(exportPromise) {
  setGlobalDownloadState({ isDownloading: true, error: null });

  exportPromise
    .then((buffer) => {
      downloadBuffer(buffer, "edited-document.pdf");
    })
    .catch((error) => {
      console.error(error);
      showDownloadError(error.message || "Could not export the PDF.");
    })
    .finally(() => {
      setGlobalDownloadState({ isDownloading: false });
    });
}

function downloadBuffer(buffer, fileName) {
  const blob = new Blob([buffer], { type: "application/pdf" });
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

function showDownloadError(message) {
  setGlobalDownloadState({ error: message });
}

function setGlobalDownloadState(update) {
  if (globalSetDownloadState) {
    globalSetDownloadState((state) => ({ ...state, ...update }));
  }
}

const styles = `
  .embeddedExample {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #f6f8fa;
  }

  .externalToolbar,
  .downloadBar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: #ffffff;
    border-color: #d8dee4;
  }

  .externalToolbar {
    border-bottom: 1px solid #d8dee4;
  }

  .downloadBar {
    border-top: 1px solid #d8dee4;
  }

  .viewer {
    position: relative;
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .toolbarButton,
  .downloadButton {
    border: 1px solid #8c959f;
    border-radius: 6px;
    background: #ffffff;
    color: #24292f;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 8px 12px;
  }

  .toolbarButton:hover:not(:disabled),
  .downloadButton:hover:not(:disabled) {
    background: #f3f4f6;
  }

  .toolbarButton:disabled,
  .downloadButton:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .downloadButton {
    background: #4537de;
    border-color: #4537de;
    color: #ffffff;
  }

  .downloadButton:hover:not(:disabled) {
    background: #372bb1;
  }

  .downloadError {
    color: #cf222e;
    font-size: 13px;
  }

  @media (prefers-color-scheme: dark) {
    .embeddedExample {
      background: #4d525d;
    }

    .externalToolbar,
    .downloadBar {
      background: #1f2328;
      border-color: #3d444d;
    }

    .toolbarButton {
      background: #2f3338;
      border-color: #6e7681;
      color: #f0f3f6;
    }
  }
`;
