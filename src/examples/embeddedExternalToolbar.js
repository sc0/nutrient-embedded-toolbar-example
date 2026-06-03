import React from "react";

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
    textStyle: { bold: false, italic: false, size: 16 },
    layout: { lineSpacingFactor: 1.5 },
  },
  {
    id: "h1",
    label: "Heading 1",
    textStyle: { bold: true, italic: false, size: 32 },
    layout: { lineSpacingFactor: 1.15 },
  },
  {
    id: "h2",
    label: "Heading 2",
    textStyle: { bold: true, italic: false, size: 24 },
    layout: { lineSpacingFactor: 1.15 },
  },
  {
    id: "h3",
    label: "Heading 3",
    textStyle: { bold: true, italic: false, size: 20 },
    layout: { lineSpacingFactor: 1.15 },
  },
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

  const bodyTextSelect = makeSelectButton("Body Text");
  const fontSelect = makeSelectButton("Arial");
  const sizeSelect = makeSelectButton("16");

  const boldBtn = makeToggleButton("bold", makeBoldGlyph(), "Bold");
  const italicBtn = makeToggleButton("italic", makeItalicGlyph(), "Italic");
  const strikeBtn = makeToggleButton("strike", makeStrikeGlyph(), "Strikethrough");

  const colorBtn = makeColorButton(getInstance);

  const alignBtn = makeSelectButton(makeAlignGlyph(), { compact: true });
  const lineHeightBtn = makeSelectButton(makeLineHeightGlyph(), { compact: true });
  const listBtn = makeSelectButton(makeListGlyph(), { compact: true });

  const saveBtn = document.createElement("button");
  saveBtn.className = "ceToolbar__save";
  saveBtn.type = "button";
  saveBtn.textContent = "Save";

  const groupHistory = makeGroup([undoBtn, redoBtn]);
  const groupParagraph = makeGroup([bodyTextSelect]);
  const groupFont = makeGroup([fontSelect, sizeSelect]);
  const groupInline = makeGroup([boldBtn, italicBtn, strikeBtn, colorBtn]);
  const groupBlock = makeGroup([alignBtn, lineHeightBtn, listBtn]);

  inner.append(groupHistory, groupParagraph, groupFont, groupInline, groupBlock);

  root.append(saveBtn);

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
    saveBtn,
  } = els;

  // ── Subscribe to state changes and reflect them onto the controls ──
  let strikeStateRequest = 0;
  let currentToolbarStyle = null;

  const setTriggerLabel = (trigger, text) => {
    const el = trigger.querySelector(".ceToolbar__selectLabel");
    if (el) el.textContent = text;
  };

  const waitForNextFrame = () =>
    new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

  const waitForContentEditorStateChange = () =>
    new Promise((resolve) => {
      const timeout = window.setTimeout(done, 150);

      function done() {
        window.clearTimeout(timeout);
        viewerInstance.removeEventListener("contentEditor.stateChange", done);
        resolve();
      }

      viewerInstance.addEventListener("contentEditor.stateChange", done);
    });

  const getFocusedTextArea = () => {
    const doc = viewerInstance.contentDocument || document;
    const activeElement = doc.activeElement;

    if (activeElement?.tagName === "TEXTAREA") return activeElement;

    return doc.querySelector("textarea:focus") || doc.querySelector("textarea");
  };

  const selectWholeActiveBlockText = async () => {
    // Give React a chance to re-render the text block after `focusBlock()`.
    await waitForNextFrame();
    await waitForNextFrame();

    const textarea = getFocusedTextArea();

    if (!textarea) return;

    textarea.focus();

    // Start listening before dispatching the shortcut so we don't miss a fast
    // state update.
    const selectionChange = waitForContentEditorStateChange();

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    // The shortcut updates the SDK selection asynchronously via WASM; wait for
    // the resulting state update (or a short fallback timeout) before applying
    // the style so `setTextStyle()` sees a non-empty selection.
    await selectionChange;
  };

  const applySnapshot = (snapshot) => {
    const isActive = !!snapshot?.isActive;
    const blockId = snapshot?.activeBlockId || snapshot?.selectedBlockId || null;
    const selectedBlock = blockId ? viewerInstance.contentEditor.getBlock(blockId) : null;
    const style = snapshot?.currentStyle ?? selectedBlock?.style ?? null;
    currentToolbarStyle = style;

    // Enable formatting/layout controls whenever a content editing session is
    // active. Clicks fall through to no-ops at the API layer when no specific
    // block is in edit mode, so the user doesn't have to think about that.
    setDisabled(boldBtn, !isActive);
    setDisabled(italicBtn, !isActive);
    setDisabled(strikeBtn, !isActive);
    setDisabled(colorBtn, !isActive);
    setDisabled(fontSelect, !isActive);
    setDisabled(sizeSelect, !isActive);
    setDisabled(bodyTextSelect, !isActive);
    setDisabled(alignBtn, !isActive);
    setDisabled(lineHeightBtn, !isActive);
    setDisabled(listBtn, !isActive);
    setDisabled(undoBtn, !isActive);
    setDisabled(redoBtn, !isActive);

    setPressed(boldBtn, !!style?.bold);
    setPressed(italicBtn, !!style?.italic);

    const requestId = ++strikeStateRequest;

    if (selectedBlock) {
      getStrikeoutAnnotationsForBlock(viewerInstance, selectedBlock).then((annotations) => {
        if (requestId === strikeStateRequest) {
          setPressed(strikeBtn, annotations.size > 0);
        }
      });
    } else {
      setPressed(strikeBtn, false);
    }

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

    saveBtn.disabled = !isActive;
  };

  const applyVisibility = () => {
    const inContentEditor =
      viewerInstance.viewState.interactionMode === PSPDFKit.InteractionMode.CONTENT_EDITOR;
    root.style.display = inContentEditor ? "" : "none";
  };

  const refresh = () => {
    applyVisibility();
    applySnapshot(buildInitialSnapshot(viewerInstance));
  };

  refresh();

  const onChange = () => refresh();
  const onViewStateChange = () => refresh();

  // We listen to `contentEditor.stateChange` (precise, fires once per relevant
  // state delta) AND fall back on a low-frequency poll. The poll guarantees
  // the UI stays consistent even if an event is missed during the first few
  // ticks of session activation.
  viewerInstance.addEventListener("contentEditor.stateChange", onChange);
  viewerInstance.addEventListener("viewState.change", onViewStateChange);
  const pollId = window.setInterval(refresh, 250);

  // Clean up the listeners and poll when the slot's DOM node is removed.
  const observer = new MutationObserver(() => {
    // The toolbar can be mounted inside the viewer's shadow/document tree, so
    // `document.body.contains(root)` may be false even while the toolbar is
    // still connected. Use `isConnected` to avoid removing the listeners/poll
    // after save, which would prevent the toolbar from appearing again when
    // content editing is re-entered.
    if (!root.isConnected) {
      viewerInstance.removeEventListener("contentEditor.stateChange", onChange);
      viewerInstance.removeEventListener("viewState.change", onViewStateChange);
      window.clearInterval(pollId);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Wire interactions ──────────────────────────────────────────────
  //
  // The formatting methods that mutate live state (setTextStyle in particular)
  // assert that a text block is in Active state (cursor inside). If the user
  // has only single-clicked a block (Selected state, not Active), we promote
  // it to Active first via `focusBlock` so style changes land on the
  // intended block.
  const ensureActiveBlock = () => {
    const activeId = viewerInstance.contentEditor.getActiveBlock();
    if (activeId) return activeId;
    const selectedId = viewerInstance.contentEditor.getSelectedBlock();
    if (selectedId) {
      viewerInstance.contentEditor.focusBlock(selectedId);
      return selectedId;
    }
    return null;
  };

  // `setTextStyle()` applies to the current text selection inside an active
  // block. For the "whole block is selected" case (single-clicked block,
  // not editing a text range), the toolbar promotes the block to Active and
  // selects the block's entire text before applying the style. If a block is
  // already Active, we leave its current cursor/range untouched so formatting
  // still works for a particular text selection.
  const applyStyleToCurrentTarget = async (style) => {
    const activeId = viewerInstance.contentEditor.getActiveBlock();

    if (activeId) {
      viewerInstance.contentEditor.setTextStyle(style);
      return activeId;
    }

    const selectedId = viewerInstance.contentEditor.getSelectedBlock();

    if (!selectedId) return null;

    viewerInstance.contentEditor.focusBlock(selectedId);
    await selectWholeActiveBlockText();
    viewerInstance.contentEditor.setTextStyle(style);

    return selectedId;
  };

  const applyParagraphStylePreset = async (preset) => {
    const targetId =
      viewerInstance.contentEditor.getActiveBlock() || viewerInstance.contentEditor.getSelectedBlock();

    if (!targetId) return false;

    if (!viewerInstance.contentEditor.getActiveBlock()) {
      viewerInstance.contentEditor.focusBlock(targetId);
    }

    // Paragraph presets are block-level controls: applying "Heading 1" should
    // update the complete text block, not just the cursor insertion style or a
    // partial text selection.
    await selectWholeActiveBlockText();
    viewerInstance.contentEditor.setTextStyle(preset.textStyle);

    return true;
  };

  undoBtn.addEventListener("click", () => {
    if (!ensureActiveBlock()) return;
    viewerInstance.contentEditor.undo();
  });
  redoBtn.addEventListener("click", () => {
    if (!ensureActiveBlock()) return;
    viewerInstance.contentEditor.redo();
  });

  boldBtn.addEventListener("click", () => {
    const style = viewerInstance.contentEditor.getCurrentStyle();
    applyStyleToCurrentTarget({ bold: !style?.bold });
  });

  italicBtn.addEventListener("click", () => {
    const style = viewerInstance.contentEditor.getCurrentStyle();
    applyStyleToCurrentTarget({ italic: !style?.italic });
  });

  strikeBtn.addEventListener("click", async () => {
    const targetId =
      viewerInstance.contentEditor.getActiveBlock() || viewerInstance.contentEditor.getSelectedBlock();

    if (!targetId) return;

    const enabled = await toggleBlockStrikethrough(viewerInstance, targetId);
    setPressed(strikeBtn, enabled);
  });

  colorBtn.addEventListener("click", () => {
    const colorInput = colorBtn.querySelector("input[type='color']");
    colorInput?.click();
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
      applyStyleToCurrentTarget({ color: value });
    });
  }

  // ── Dropdown menus ─────────────────────────────────────────────────
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
        lineHeightBtn.dataset.selectedId = String(item.layout.lineSpacingFactor);
      }
    },
  });

  attachDropdown(root, fontSelect, {
    getItems: () => {
      const fonts = viewerInstance.contentEditor.getAvailableFonts();
      const families = Array.from(new Set(fonts.map((f) => f.family))).sort();
      return families.map((family) => ({ id: family, label: family }));
    },
    getSelectedId: () => currentToolbarStyle?.family ?? null,
    onSelect: (item) => {
      applyStyleToCurrentTarget({ family: item.id });
      // Update the trigger immediately; the snapshot-driven refresh would only
      // beat us to it on the synchronous code path, and even there
      // selectionStyleInfo can shadow the just-applied value.
      setTriggerLabel(fontSelect, item.label);
    },
    itemStyle: (item) => ({ fontFamily: item.id }),
  });

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
      applyStyleToCurrentTarget({ size: item.meta });
      setTriggerLabel(sizeSelect, item.label);
    },
  });

  attachDropdown(root, alignBtn, {
    getItems: () => [
      { id: "begin", label: "Left" },
      { id: "center", label: "Center" },
      { id: "end", label: "Right" },
      { id: "justified", label: "Justify" },
    ],
    getSelectedId: () => alignBtn.dataset.selectedId ?? null,
    onSelect: async (item) => {
      const targetId = ensureActiveBlock();
      if (!targetId) return;
      await applyTextBlockLayout(viewerInstance, targetId, { alignment: item.id });
      alignBtn.dataset.selectedId = item.id;
    },
  });

  attachDropdown(root, lineHeightBtn, {
    getItems: () =>
      [1, 1.15, 1.5, 2].map((factor) => ({
        id: String(factor),
        label: `${factor}×`,
        meta: factor,
      })),
    getSelectedId: () => {
      return lineHeightBtn.dataset.selectedId ?? null;
    },
    onSelect: async (item) => {
      const targetId = ensureActiveBlock();
      if (!targetId) return;
      await applyTextBlockLayout(viewerInstance, targetId, { lineSpacingFactor: item.meta });
      lineHeightBtn.dataset.selectedId = item.id;
    },
  });

  attachDropdown(root, listBtn, {
    getItems: () => [
      { id: "none", label: "No list" },
      { id: "bullet", label: "Bulleted" },
      { id: "numbered", label: "Numbered" },
    ],
    getSelectedId: () => listBtn.dataset.selectedId ?? "none",
    onSelect: (item) => {
      // No SDK-side backing for list styles yet — track selection locally.
      listBtn.dataset.selectedId = item.id;
    },
  });

  saveBtn.addEventListener("click", () => {
    viewerInstance
      .saveContentEditingSession()
      .then(() => refresh())
      .catch((err) => {
        console.error("Failed to save content editing session:", err);
      });
  });
}

// ── Dropdown helper ─────────────────────────────────────────────────────

let openDropdownCloser = null;

function attachDropdown(toolbarRoot, trigger, { getItems, getSelectedId, onSelect, itemStyle }) {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();

    if (trigger.dataset.open === "true") {
      closeOpenDropdown();
      return;
    }

    closeOpenDropdown();
    openDropdown(toolbarRoot, trigger, { getItems, getSelectedId, onSelect, itemStyle });
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
  return {
    isActive: viewerInstance.contentEditor.isActive(),
    isDirty: viewerInstance.hasUnsavedContentEditingChanges(),
    mode: null,
    activeBlockId: viewerInstance.contentEditor.getActiveBlock(),
    selectedBlockId: viewerInstance.contentEditor.getSelectedBlock(),
    currentStyle: viewerInstance.contentEditor.getCurrentStyle(),
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

async function applyTextBlockLayout(viewerInstance, blockId, layoutUpdate) {
  const block = viewerInstance.contentEditor.getBlock(blockId);

  if (!block) return;

  await viewerInstance.contentEditor.setLayout(blockId, layoutUpdate);

  // The public layout API currently recalculates the block when `maxWidth` is
  // supplied. For alignment / line-height, follow up with the existing width so
  // the text block is laid out again using the updated layout state.
  if (layoutUpdate.alignment !== undefined || layoutUpdate.lineSpacingFactor !== undefined) {
    const maxWidth = block.layout?.maxWidth;

    if (typeof maxWidth === "number") {
      await viewerInstance.contentEditor.setLayout(blockId, { maxWidth });
    }
  }
}

const STRIKEOUT_CUSTOM_DATA_KEY = "embeddedExternalToolbarStrikeoutBlockId";

async function toggleBlockStrikethrough(viewerInstance, blockId) {
  const block = viewerInstance.contentEditor.getBlock(blockId);

  if (!block || block.type !== "text") return false;

  const existing = await getStrikeoutAnnotationsForBlock(viewerInstance, block);

  if (existing.size > 0) {
    await viewerInstance.delete(existing.map((annotation) => annotation.id));
    return false;
  }

  const rects = makeStrikeoutRects(block);

  if (rects.size === 0) return false;

  await viewerInstance.create(
    new PSPDFKit.Annotations.StrikeOutAnnotation({
      pageIndex: block.pageIndex,
      rects,
      boundingBox: PSPDFKit.Geometry.Rect.union(rects),
      color: colorFromHex(block.style.color || "#1a1a1a"),
      customData: {
        [STRIKEOUT_CUSTOM_DATA_KEY]: block.id,
      },
    }),
  );

  return true;
}

async function getStrikeoutAnnotationsForBlock(viewerInstance, block) {
  const annotations = await viewerInstance.getAnnotations(block.pageIndex);

  return annotations.filter(
    (annotation) =>
      annotation instanceof PSPDFKit.Annotations.StrikeOutAnnotation &&
      annotation.customData?.[STRIKEOUT_CUSTOM_DATA_KEY] === block.id,
  );
}

function makeStrikeoutRects(block) {
  const { left, top, width, height } = block.boundingBox;
  const fontSize = block.style.size || 12;
  const approximateLineHeight = Math.max(fontSize * 1.2, 1);
  const lineCount = Math.max(1, Math.round(height / approximateLineHeight));
  const rectHeight = height / lineCount;
  const rects = [];

  for (let index = 0; index < lineCount; index++) {
    rects.push(
      new PSPDFKit.Geometry.Rect({
        left,
        top: top + index * rectHeight,
        width,
        height: rectHeight,
      }),
    );
  }

  return PSPDFKit.Immutable.List(rects);
}

function colorFromHex(hex) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized,
    16,
  );

  if (Number.isNaN(value)) return PSPDFKit.Color.BLACK;

  return new PSPDFKit.Color({
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  });
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

function makeStrikeGlyph() {
  return makeSvg(
    `<path d="M3 9.25h14v1.5H3v-1.5Zm6.4-4.5c-1.6 0-2.5.8-2.5 1.9 0 .8.4 1.3 1.8 1.6l-1.9.45c-1.1-.5-1.5-1.3-1.5-2.05C5.3 4.7 7 3.5 9.4 3.5c1.6 0 2.85.55 3.4 1.6l-1.4.85c-.4-.65-1.1-1.2-2-1.2Zm.5 6.55 1.9-.45c1.1.5 1.5 1.3 1.5 2.05 0 1.95-1.7 3.1-4.1 3.1-1.7 0-3-.55-3.55-1.65l1.4-.85c.4.7 1.2 1.2 2.15 1.2 1.55 0 2.5-.7 2.5-1.8 0-.8-.4-1.3-1.8-1.6Z" fill="currentColor"/>`,
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
    if (!viewerInstance || !PSPDFKit) return;
    // Use the new namespaced API where available. Falls back to the view-state
    // mutation path otherwise.
    if (viewerInstance.contentEditor?.enter) {
      viewerInstance.contentEditor.enter();
      return;
    }
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
    flex: 1;
    min-height: 0;
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
