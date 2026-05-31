import { app } from "../../../scripts/app.js";
import {
    NODE_NAME,
    STORAGE_WIDGET,
    PROMPT_NODE_NAME,
    PROMPT_LORA_NODE_NAME,
    NODE_MIN_WIDTH,
    NODE_MIN_HEIGHT,
    NODE_CHROME_HEIGHT,
    DOM_HEIGHT_PADDING,
    DEFAULT_TEXT_HEIGHT,
    DEFAULT_PREVIEW_HEIGHT,
    findWidget,
    hideWidget,
    makeId,
    normalizeItems,
    normalizeTemplateList,
    referenceSelectedId,
    referenceListHidden,
    referenceFileName,
    referencePayloadFromState,
    imagePath,
    imageViewUrl,
    clamp,
    previewHeight,
    textHeight,
    stopCanvasEvent,
    createButton,
    createInput,
    makeEditableTitle,
    makeResizeHandle,
    attachBlockDrag,
    makeBulkToggleButton,
    uploadImage,
    copyTextToClipboard,
    showToast,
} from "./common.js";
import { fetchReferenceTemplateList, openReferenceTemplateFile, saveReferenceTemplateFile } from "./api.js";
import { setupPromptNode, syncPromptState } from "./prompt_template.js";
import { setupPromptLoraNode } from "./prompt_template_lora.js";

// ── Height calculation ─────────────────────────────────────────────────────────

function calculateEditorHeight(node) {
    const state = node.__templateReferenceState;
    if (!state) {
        return NODE_MIN_HEIGHT;
    }

    if (state.listHidden) {
        return NODE_MIN_HEIGHT;
    }

    const blockHeight = state.items.reduce((height, item) => {
        if (item.type === "image") {
            if (item.collapsed) {
                return height + 105;
            }
            return height + 137 + previewHeight(item.image);
        }
        if (item.collapsed) {
            return height + 82;
        }
        return height + 88 + textHeight(item);
    }, 0);
    return Math.max(NODE_MIN_HEIGHT, 76 + blockHeight);
}

function measuredEditorHeight(node) {
    const state = node.__templateReferenceState;
    const renderedHeight = state?.root ? Math.ceil(state.root.scrollHeight) + DOM_HEIGHT_PADDING : 0;
    return Math.max(NODE_MIN_HEIGHT, calculateEditorHeight(node), renderedHeight);
}

function updateNodeSize(node, options = {}) {
    const state = node.__templateReferenceState;
    if (options.defer !== false && state && !state.resizeQueued) {
        state.resizeQueued = true;
        requestAnimationFrame(() => {
            state.resizeQueued = false;
            updateNodeSize(node, { defer: false });
        });
    }

    const targetHeight = measuredEditorHeight(node) + NODE_CHROME_HEIGHT;
    const targetWidth = Math.max(node.size?.[0] || 0, NODE_MIN_WIDTH);
    const currentHeight = node.size?.[1] || 0;
    const currentWidth = node.size?.[0] || 0;

    if (Math.abs(currentHeight - targetHeight) > 1 || currentWidth < targetWidth) {
        node.setSize?.([targetWidth, targetHeight]);
    }

    node.onResize?.(node.size);
    app.graph?.setDirtyCanvas?.(true, true);
}

// ── State sync ─────────────────────────────────────────────────────────────────

function syncState(node) {
    const state = node.__templateReferenceState;
    const widget = findWidget(node, STORAGE_WIDGET);
    if (!state || !widget) {
        return;
    }

    ensureReferenceSelection(node);
    widget.value = JSON.stringify({ version: 1, selected_id: state.selectedId || "", list_hidden: Boolean(state.listHidden), file_name: state.fileName || "", items: state.items });
    if (widget.inputEl) {
        widget.inputEl.value = widget.value;
    }
    node.setDirtyCanvas?.(true, true);
}

function refreshNode(node) {
    syncState(node);
    render(node);
    updateNodeSize(node);
}

// ── File selector ──────────────────────────────────────────────────────────────

function updateReferenceFileSelector(state) {
    const selector = state?.fileSelector;
    if (!selector) {
        return;
    }
    const current = state.fileName || "";
    selector.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No file";
    selector.appendChild(empty);
    state.files.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        selector.appendChild(option);
    });
    selector.value = state.files.includes(current) ? current : "";
}

async function loadReferenceTemplateFiles(node, selectedName = "") {
    const state = node.__templateReferenceState;
    if (!state) {
        return;
    }
    try {
        state.files = await fetchReferenceTemplateList();
        if (selectedName) {
            state.fileName = selectedName;
        }
        updateReferenceFileSelector(state);
    } catch (error) {
        console.error(error);
    }
}

function makeReferenceFileControls(node) {
    const state = node.__templateReferenceState;
    const row = document.createElement("div");
    row.className = "tr-file-controls";

    const nameInput = createInput(state.fileName || "", "json file name");
    nameInput.className = "tr-file-title";
    nameInput.addEventListener("input", () => {
        state.fileName = nameInput.value;
        syncState(node);
    });

    const selector = document.createElement("select");
    selector.className = "tr-file-selector";
    selector.addEventListener("change", () => {
        state.fileName = selector.value;
        nameInput.value = state.fileName;
        syncState(node);
    });
    state.fileSelector = selector;

    const openButton = createButton("Open", "tr-open");
    openButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const name = selector.value;
        if (!name) {
            state.items = [];
            state.selectedId = "";
            state.listHidden = false;
            state.fileName = "";
            state.fileSelector = null;
            refreshNode(node);
            await loadReferenceTemplateFiles(node);
            return;
        }

        openButton.disabled = true;
        try {
            const payload = await openReferenceTemplateFile(name);
            const data = payload.data || {};
            state.items = normalizeItems(JSON.stringify(data));
            state.selectedId = referenceSelectedId(JSON.stringify(data));
            state.listHidden = referenceListHidden(JSON.stringify(data));
            state.fileName = payload.name || name;
            state.fileSelector = null;
            refreshNode(node);
            await loadReferenceTemplateFiles(node, state.fileName);
        } catch (error) {
            showToast(error?.message || String(error), "error");
        } finally {
            openButton.disabled = false;
        }
    });

    const saveButton = createButton("Save", "tr-save");
    saveButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.fileName = nameInput.value.trim();
        if (!state.fileName) {
            showToast("Enter a Template Reference file name before saving.", "error");
            return;
        }

        saveButton.disabled = true;
        try {
            syncState(node);
            const payload = await saveReferenceTemplateFile(state.fileName, referencePayloadFromState(state));
            const data = payload.data || {};
            state.items = normalizeItems(JSON.stringify(data));
            state.selectedId = referenceSelectedId(JSON.stringify(data));
            state.listHidden = referenceListHidden(JSON.stringify(data));
            state.fileName = payload.name || state.fileName;
            nameInput.value = state.fileName;
            state.files = normalizeTemplateList(payload);
            updateReferenceFileSelector(state);
            refreshNode(node);
        } catch (error) {
            showToast(error?.message || String(error), "error");
        } finally {
            saveButton.disabled = false;
        }
    });

    row.append(nameInput, selector, openButton, saveButton);
    updateReferenceFileSelector(state);
    return row;
}

// ── Selection ──────────────────────────────────────────────────────────────────

function ensureReferenceSelection(node) {
    const state = node.__templateReferenceState;
    if (!state) {
        return "";
    }
    if (state.selectedId && !state.items.some((item) => item.id === state.selectedId)) {
        state.selectedId = "";
    }
    return state.selectedId;
}

function updateReferenceSelectorOptions(node) {
    const state = node.__templateReferenceState;
    const selector = state?.selector;
    if (!state || !selector) {
        return;
    }

    const selectedId = ensureReferenceSelection(node);
    selector.innerHTML = "";

    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "none";
    selector.appendChild(noneOption);

    state.items.forEach((item, index) => {
        const option = document.createElement("option");
        option.value = item.id;
        const fallback = item.type === "image" ? `Image ${index + 1}` : `Text ${index + 1}`;
        option.textContent = item.title?.trim() || fallback;
        selector.appendChild(option);
    });
    selector.value = selectedId;
}

function makeReferenceSelector(node) {
    const row = document.createElement("div");
    row.className = "tr-selector-row";

    const label = document.createElement("span");
    label.className = "tr-selector-label";
    label.textContent = "Output";

    const selector = document.createElement("select");
    selector.className = "tr-selector";
    selector.addEventListener("change", () => {
        node.__templateReferenceState.selectedId = selector.value;
        syncState(node);
    });

    row.append(label, selector);
    node.__templateReferenceState.selector = selector;
    updateReferenceSelectorOptions(node);
    return row;
}

// ── Controls ───────────────────────────────────────────────────────────────────

function makeControls(node) {
    const controls = document.createElement("div");
    controls.className = "tr-controls";

    const state = node.__templateReferenceState;
    const listToggle = createButton(state.listHidden ? "List On" : "List Off", "tr-list-toggle");
    listToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.listHidden = !state.listHidden;
        refreshNode(node);
    });

    const toggleAll = makeBulkToggleButton(node.__templateReferenceState.items, () => refreshNode(node));
    toggleAll.disabled = toggleAll.disabled || state.listHidden;
    const addText = createButton("Add Textbox", "tr-add");
    const addImage = createButton("Add LoadImage", "tr-add");

    addText.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.__templateReferenceState.items.push({
            id: makeId(),
            type: "text",
            title: "Title",
            text: "",
            text_height: DEFAULT_TEXT_HEIGHT,
            collapsed: false,
        });
        refreshNode(node);
    });

    addImage.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.__templateReferenceState.items.push({
            id: makeId(),
            type: "image",
            title: "Title",
            collapsed: false,
            image: { name: "", subfolder: "", type: "input", path: "", preview_height: DEFAULT_PREVIEW_HEIGHT },
        });
        refreshNode(node);
    });

    controls.append(listToggle, toggleAll, addText, addImage);
    return controls;
}

// ── Text block ─────────────────────────────────────────────────────────────────

function makeTextBlock(node, item, index) {
    const block = document.createElement("section");
    block.className = "tr-block tr-text-block";

    const header = document.createElement("div");
    header.className = "tr-block-header";

    const label = document.createElement("span");
    label.className = "tr-block-type";
    label.textContent = "Text";
    attachBlockDrag(block, label, node.__templateReferenceState, item, () => refreshNode(node));

    const toggleButton = createButton(item.collapsed ? "Show" : "Hide", "tr-toggle");
    const copyButton = createButton("Copy", "tr-copy");
    const fitButton = createButton("Fit", "tr-fit-text");
    const deleteButton = createButton("Delete", "tr-delete");
    const headerActions = document.createElement("div");
    headerActions.className = "tr-header-actions";

    toggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.collapsed = !item.collapsed;
        refreshNode(node);
    });

    deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.__templateReferenceState.items.splice(index, 1);
        refreshNode(node);
    });

    copyButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const originalLabel = copyButton.textContent;
        copyButton.disabled = true;
        try {
            await copyTextToClipboard(item.text || "");
            copyButton.textContent = "Copied";
            setTimeout(() => {
                copyButton.textContent = originalLabel;
                copyButton.disabled = false;
            }, 900);
        } catch (error) {
            copyButton.textContent = "Failed";
            setTimeout(() => {
                copyButton.textContent = originalLabel;
                copyButton.disabled = false;
            }, 1200);
        }
    });

    headerActions.append(toggleButton, copyButton, fitButton, deleteButton);
    header.append(label, headerActions);

    const title = makeEditableTitle(item.title, (value) => {
        item.title = value;
        syncState(node);
        updateReferenceSelectorOptions(node);
    });

    const textarea = document.createElement("textarea");
    textarea.className = "tr-text";
    textarea.value = item.text || "";
    textarea.placeholder = "text";
    textarea.spellcheck = false;
    textarea.style.height = `${textHeight(item)}px`;
    textarea.style.minHeight = `${textHeight(item)}px`;

    const applyTextHeight = (height) => {
        item.text_height = clamp(Math.round(height), DEFAULT_TEXT_HEIGHT - 24, 420);
        textarea.style.height = `${item.text_height}px`;
        textarea.style.minHeight = `${item.text_height}px`;
        syncState(node);
        updateNodeSize(node);
        return item.text_height;
    };

    const fitTextHeight = () => {
        textarea.style.height = "auto";
        applyTextHeight(textarea.scrollHeight + 2);
    };

    textarea.addEventListener("input", () => {
        item.text = textarea.value;
        syncState(node);
    });

    fitButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fitTextHeight();
    });

    const resizeHandle = makeResizeHandle("Drag to resize text area", (height) => {
        if (height === undefined) {
            return textHeight(item);
        }
        return applyTextHeight(height);
    });

    block.append(header, title);
    if (!item.collapsed) {
        block.append(textarea, resizeHandle);
    }
    return block;
}

// ── Image block ────────────────────────────────────────────────────────────────

function makeImageBlock(node, item, index) {
    const block = document.createElement("section");
    block.className = "tr-block tr-image-block";

    const header = document.createElement("div");
    header.className = "tr-block-header";

    const label = document.createElement("span");
    label.className = "tr-block-type";
    label.textContent = "Image";
    attachBlockDrag(block, label, node.__templateReferenceState, item, () => refreshNode(node));

    const toggleButton = createButton(item.collapsed ? "Show" : "Hide", "tr-toggle");
    const deleteButton = createButton("Delete", "tr-delete");
    const headerActions = document.createElement("div");
    headerActions.className = "tr-header-actions";

    toggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.collapsed = !item.collapsed;
        refreshNode(node);
    });

    deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.__templateReferenceState.items.splice(index, 1);
        refreshNode(node);
    });

    headerActions.append(toggleButton, deleteButton);
    header.append(label, headerActions);

    const title = makeEditableTitle(item.title, (value) => {
        item.title = value;
        syncState(node);
        updateReferenceSelectorOptions(node);
    });

    const imageName = createButton(imagePath(item.image) || "image", "tr-image-name");
    imageName.disabled = true;
    imageName.style.opacity = "1";

    const uploadButton = createButton("Upload", "tr-upload");
    const fitButton = createButton("Fit", "tr-fit-height");
    fitButton.disabled = true;
    const fileRow = document.createElement("div");
    fileRow.className = "tr-file-row";
    fileRow.append(imageName, uploadButton, fitButton);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";

    const preview = document.createElement("div");
    preview.className = "tr-preview";
    let currentImage = null;

    const applyPreviewHeight = () => {
        const height = previewHeight(item.image);
        preview.style.height = `${height}px`;
        preview.style.minHeight = `${height}px`;
    };

    const setPreviewHeight = (height) => {
        item.image.preview_height = clamp(Math.round(height), 96, 380);
        applyPreviewHeight();
        syncState(node);
        updateNodeSize(node);
        return item.image.preview_height;
    };

    const fitPreviewHeight = () => {
        if (!currentImage?.naturalWidth || !currentImage?.naturalHeight) {
            return;
        }

        const width = Math.max(preview.clientWidth || 260, 120);
        setPreviewHeight(
            Math.round((width * currentImage.naturalHeight) / currentImage.naturalWidth),
        );
    };

    const drawPreview = () => {
        imageName.textContent = imagePath(item.image) || "image";
        preview.innerHTML = "";
        currentImage = null;
        applyPreviewHeight();

        const url = imageViewUrl(item.image);
        if (!url) {
            const empty = document.createElement("div");
            empty.className = "tr-preview-empty";
            empty.textContent = "Upload image";
            preview.appendChild(empty);
            fitButton.disabled = true;
            return;
        }

        const img = document.createElement("img");
        img.src = url;
        img.alt = imagePath(item.image);
        img.addEventListener("load", () => {
            currentImage = img;
            fitButton.disabled = false;
            updateNodeSize(node);
        });
        preview.appendChild(img);
    };

    const handleFiles = async (files) => {
        const file = files?.[0];
        if (!file) {
            return;
        }

        uploadButton.disabled = true;
        uploadButton.textContent = "Uploading...";
        try {
            item.image = await uploadImage(file);
            item.image.preview_height = DEFAULT_PREVIEW_HEIGHT;
            syncState(node);
            drawPreview();
        } catch (error) {
            showToast(error?.message || String(error), "error");
        } finally {
            uploadButton.disabled = false;
            uploadButton.textContent = "Upload";
            fileInput.value = "";
        }
    };

    uploadButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fileInput.click();
    });

    fitButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fitPreviewHeight();
    });

    fileInput.addEventListener("change", () => handleFiles(Array.from(fileInput.files || [])));

    block.addEventListener("dragover", (event) => {
        if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file")) {
            event.preventDefault();
            event.stopPropagation();
            block.classList.add("tr-dragover");
        }
    });
    block.addEventListener("dragleave", () => block.classList.remove("tr-dragover"));
    block.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        block.classList.remove("tr-dragover");
        handleFiles(Array.from(event.dataTransfer?.files || []));
    });

    drawPreview();
    const resizeHandle = makeResizeHandle("Drag to resize image preview", (height) => {
        if (height === undefined) {
            return previewHeight(item.image);
        }
        return setPreviewHeight(height);
    });

    block.append(header, title, fileRow);
    if (!item.collapsed) {
        block.append(preview, resizeHandle);
    }
    block.append(fileInput);
    return block;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render(node) {
    const state = node.__templateReferenceState;
    if (!state?.root) {
        return;
    }

    state.root.innerHTML = "";
    state.root.appendChild(makeReferenceFileControls(node));
    state.root.appendChild(makeReferenceSelector(node));
    state.root.appendChild(makeControls(node));

    if (state.listHidden) {
        return;
    }

    const list = document.createElement("div");
    list.className = "tr-list";
    state.items.forEach((item, index) => {
        list.appendChild(item.type === "image" ? makeImageBlock(node, item, index) : makeTextBlock(node, item, index));
    });
    state.root.appendChild(list);
}

// ── Editor creation ────────────────────────────────────────────────────────────

function createEditor(node) {
    const container = document.createElement("div");
    container.className = "template-reference-editor";

    const root = document.createElement("div");
    root.className = "tr-root";
    container.appendChild(root);

    for (const eventName of ["mousedown", "pointerdown", "dblclick", "wheel"]) {
        container.addEventListener(eventName, stopCanvasEvent);
    }

    node.__templateReferenceState = {
        root,
        items: normalizeItems(findWidget(node, STORAGE_WIDGET)?.value),
        selectedId: referenceSelectedId(findWidget(node, STORAGE_WIDGET)?.value),
        listHidden: referenceListHidden(findWidget(node, STORAGE_WIDGET)?.value),
        fileName: referenceFileName(findWidget(node, STORAGE_WIDGET)?.value),
        files: [],
        fileSelector: null,
        selector: null,
        draggingId: "",
    };

    return container;
}

function setupNode(node) {
    node.serialize_widgets = true;

    const storageWidget = findWidget(node, STORAGE_WIDGET);
    hideWidget(storageWidget);

    if (!node.__templateReferenceState) {
        const editor = createEditor(node);
        node.addDOMWidget("template_reference_editor", "div", editor, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => measuredEditorHeight(node),
            onDraw: () => {
                editor.style.pointerEvents = "auto";
            },
        });
    } else {
        node.__templateReferenceState.items = normalizeItems(storageWidget?.value);
        node.__templateReferenceState.selectedId = referenceSelectedId(storageWidget?.value);
        node.__templateReferenceState.listHidden = referenceListHidden(storageWidget?.value);
        node.__templateReferenceState.fileName = referenceFileName(storageWidget?.value) || node.__templateReferenceState.fileName || "";
    }

    node.syncTemplateReference = () => syncState(node);
    render(node);
    updateNodeSize(node);
    loadReferenceTemplateFiles(node, node.__templateReferenceState.fileName);
}

// ── LGraph serialization patch (#9 — documented) ──────────────────────────────
// This patches LGraph.prototype.onBeforeSerialize to ensure widget state is
// synced before the graph is serialized. The original method is preserved and
// called via apply() to maintain compatibility with other extensions that may
// also patch this method.
const onBeforeSerialize = LGraph.prototype.onBeforeSerialize;
LGraph.prototype.onBeforeSerialize = function () {
    onBeforeSerialize?.apply(this, arguments);
    for (const node of app.graph?.findNodesByType?.(NODE_NAME) || []) {
        node.syncTemplateReference?.();
    }
    for (const node of app.graph?.findNodesByType?.(PROMPT_NODE_NAME) || []) {
        node.syncPromptTemplate?.();
    }
    for (const node of app.graph?.findNodesByType?.(PROMPT_LORA_NODE_NAME) || []) {
        node.syncPromptTemplateLoRA?.();
    }
};

// ── Extension registration ─────────────────────────────────────────────────────

app.registerExtension({
    name: "Comfy.TemplateReference",
    init() {
        // Load external CSS (#10)
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = new URL("../css/styles.css", import.meta.url).href;
        document.head.appendChild(link);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_NAME) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                setupNode(this);
                return result;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                const result = onConfigure?.apply(this, arguments);
                setupNode(this);
                return result;
            };
        }

        if (nodeData.name === PROMPT_NODE_NAME) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                setupPromptNode(this);
                return result;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                const result = onConfigure?.apply(this, arguments);
                setupPromptNode(this);
                return result;
            };
        }

        if (nodeData.name === PROMPT_LORA_NODE_NAME) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                setupPromptLoraNode(this);
                return result;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                const result = onConfigure?.apply(this, arguments);
                setupPromptLoraNode(this);
                return result;
            };
        }
    },
});
