import { app } from "../../../scripts/app.js";
import {
    PROMPT_STORAGE_WIDGET,
    NODE_MIN_WIDTH,
    NODE_MIN_HEIGHT,
    NODE_CHROME_HEIGHT,
    DOM_HEIGHT_PADDING,
    DEFAULT_TEXT_HEIGHT,
    DEFAULT_PREVIEW_HEIGHT,
    MIN_PREVIEW_HEIGHT,
    MAX_PREVIEW_HEIGHT,
    findWidget,
    hideWidget,
    makeId,
    normalizeImage,
    normalizePromptLoraItems,
    normalizeLora,
    normalizeTemplateList,
    promptSelectedId,
    promptListHidden,
    promptFileName,
    promptPayloadFromState,
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
import { fetchLoraList, fetchPromptTemplateLoraList, openPromptTemplateLoraFile, savePromptTemplateLoraFile } from "./api.js";

// ── Height calculation ─────────────────────────────────────────────────────────

function calculatePromptEditorHeight(node) {
    const state = node.__promptTemplateState;
    if (!state) {
        return NODE_MIN_HEIGHT;
    }

    if (state.listHidden) {
        return NODE_MIN_HEIGHT;
    }

    const blockHeight = state.items.reduce((height, item) => {
        if (item.collapsed) {
            return height + 82;
        }
        return (
            height +
            88 +
            textHeight(item) +
            (item.image_collapsed ? 0 : 52 + previewHeight(item.image)) +
            (item.lora_collapsed ? 0 : 54)
        );
    }, 0);
    return Math.max(NODE_MIN_HEIGHT, 76 + blockHeight);
}

function measuredPromptEditorHeight(node) {
    const state = node.__promptTemplateState;
    const renderedHeight = state?.root ? Math.ceil(state.root.scrollHeight) + DOM_HEIGHT_PADDING : 0;
    return Math.max(NODE_MIN_HEIGHT, calculatePromptEditorHeight(node), renderedHeight);
}

function updatePromptNodeSize(node, options = {}) {
    const state = node.__promptTemplateState;
    if (options.defer !== false && state && !state.resizeQueued) {
        state.resizeQueued = true;
        requestAnimationFrame(() => {
            state.resizeQueued = false;
            updatePromptNodeSize(node, { defer: false });
        });
    }

    const targetHeight = measuredPromptEditorHeight(node) + NODE_CHROME_HEIGHT;
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

export function syncPromptState(node) {
    const state = node.__promptTemplateState;
    const widget = findWidget(node, PROMPT_STORAGE_WIDGET);
    if (!state || !widget) {
        return;
    }

    ensurePromptSelection(node);
    widget.value = JSON.stringify({ ...promptPayloadFromState(state), file_name: state.fileName || "" });
    if (widget.inputEl) {
        widget.inputEl.value = widget.value;
    }
    node.setDirtyCanvas?.(true, true);
}

function refreshPromptNode(node) {
    syncPromptState(node);
    renderPromptNode(node);
    updatePromptNodeSize(node);
}

// ── File selector ──────────────────────────────────────────────────────────────

function updatePromptFileSelector(state) {
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

async function loadPromptTemplateFiles(node, selectedName = "") {
    const state = node.__promptTemplateState;
    if (!state) {
        return;
    }
    try {
        state.files = await fetchPromptTemplateLoraList();
        if (selectedName) {
            state.fileName = selectedName;
        }
        updatePromptFileSelector(state);
    } catch (error) {
        console.error(error);
    }
}

function makePromptFileControls(node) {
    const state = node.__promptTemplateState;
    const row = document.createElement("div");
    row.className = "tr-file-controls";

    const nameInput = createInput(state.fileName || "", "json file name");
    nameInput.className = "tr-file-title";
    nameInput.addEventListener("input", () => {
        state.fileName = nameInput.value;
        syncPromptState(node);
    });

    const selector = document.createElement("select");
    selector.className = "tr-file-selector";
    selector.addEventListener("change", () => {
        state.fileName = selector.value;
        nameInput.value = state.fileName;
        syncPromptState(node);
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
            refreshPromptNode(node);
            await loadPromptTemplateFiles(node);
            return;
        }

        openButton.disabled = true;
        try {
            const payload = await openPromptTemplateLoraFile(name);
            const data = payload.data || {};
            state.items = normalizePromptLoraItems(JSON.stringify(data));
            state.selectedId = promptSelectedId(JSON.stringify(data));
            state.listHidden = promptListHidden(JSON.stringify(data));
            state.fileName = payload.name || name;
            state.fileSelector = null;
            refreshPromptNode(node);
            await loadPromptTemplateFiles(node, state.fileName);
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
            showToast("Enter a template file name before saving.", "error");
            return;
        }

        saveButton.disabled = true;
        try {
            syncPromptState(node);
            const payload = await savePromptTemplateLoraFile(state.fileName, promptPayloadFromState(state));
            const data = payload.data || {};
            state.items = normalizePromptLoraItems(JSON.stringify(data));
            state.selectedId = promptSelectedId(JSON.stringify(data));
            state.listHidden = promptListHidden(JSON.stringify(data));
            state.fileName = payload.name || state.fileName;
            nameInput.value = state.fileName;
            state.files = normalizeTemplateList(payload);
            updatePromptFileSelector(state);
            refreshPromptNode(node);
        } catch (error) {
            showToast(error?.message || String(error), "error");
        } finally {
            saveButton.disabled = false;
        }
    });

    row.append(nameInput, selector, openButton, saveButton);
    updatePromptFileSelector(state);
    return row;
}

// ── Controls ───────────────────────────────────────────────────────────────────

function makePromptControls(node) {
    const controls = document.createElement("div");
    controls.className = "tr-controls";

    const state = node.__promptTemplateState;
    const listToggle = createButton(state.listHidden ? "List On" : "List Off", "tr-list-toggle");
    listToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.listHidden = !state.listHidden;
        refreshPromptNode(node);
    });

    const toggleAll = makeBulkToggleButton(node.__promptTemplateState.items, () => refreshPromptNode(node));
    toggleAll.disabled = toggleAll.disabled || state.listHidden;
    const addTemplate = createButton("Add Template", "tr-add");
    addTemplate.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = {
            id: makeId(),
            type: "text",
            title: "Title",
            text: "",
            text_height: DEFAULT_TEXT_HEIGHT,
            collapsed: false,
            image_collapsed: true,
            lora_collapsed: true,
            lora: normalizeLora(),
            image: normalizeImage(),
        };
        node.__promptTemplateState.items.push(item);
        refreshPromptNode(node);
    });

    controls.append(listToggle, toggleAll, addTemplate);
    return controls;
}

// ── Selection ──────────────────────────────────────────────────────────────────

function ensurePromptSelection(node) {
    const state = node.__promptTemplateState;
    if (!state) {
        return "";
    }

    if (state.selectedId && !state.items.some((item) => item.id === state.selectedId)) {
        state.selectedId = "";
    }
    return state.selectedId;
}

function updatePromptSelectorOptions(node) {
    const state = node.__promptTemplateState;
    const selector = state?.selector;
    if (!state || !selector) {
        return;
    }

    const selectedId = ensurePromptSelection(node);
    selector.innerHTML = "";

    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "none";
    selector.appendChild(noneOption);

    state.items.forEach((item, index) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.title?.trim() || `Template ${index + 1}`;
        selector.appendChild(option);
    });
    selector.value = selectedId;
}

function makePromptSelector(node) {
    const row = document.createElement("div");
    row.className = "tr-selector-row";

    const label = document.createElement("span");
    label.className = "tr-selector-label";
    label.textContent = "Output";

    const selector = document.createElement("select");
    selector.className = "tr-selector";
    selector.addEventListener("change", () => {
        node.__promptTemplateState.selectedId = selector.value;
        syncPromptState(node);
    });

    row.append(label, selector);
    node.__promptTemplateState.selector = selector;
    updatePromptSelectorOptions(node);
    return row;
}

// ── Reference image block (per-prompt optional image) ──────────────────────────

function makePromptReferenceImage(node, item) {
    item.image = normalizeImage(item.image);

    const section = document.createElement("div");
    section.className = "tr-prompt-image";

    const imageName = createButton(imagePath(item.image) || "reference image", "tr-image-name");
    imageName.disabled = true;
    imageName.style.opacity = "1";

    const uploadButton = createButton("Upload", "tr-upload");
    const fitButton = createButton("Fit", "tr-fit-height");
    const deleteImageButton = createButton("Delete", "tr-delete tr-image-delete");
    fitButton.disabled = true;
    const fileRow = document.createElement("div");
    fileRow.className = "tr-file-row tr-prompt-image-row";
    fileRow.append(imageName, uploadButton, fitButton, deleteImageButton);

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
        item.image.preview_height = clamp(Math.round(height), MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
        applyPreviewHeight();
        syncPromptState(node);
        updatePromptNodeSize(node);
        return item.image.preview_height;
    };

    const fitPreviewHeight = () => {
        if (!currentImage?.naturalWidth || !currentImage?.naturalHeight) {
            return;
        }

        const width = Math.max(preview.clientWidth || 260, 120);
        setPreviewHeight(Math.round((width * currentImage.naturalHeight) / currentImage.naturalWidth));
    };

    const drawPreview = () => {
        const hasImage = Boolean(imagePath(item.image));
        imageName.textContent = hasImage ? imagePath(item.image) : "reference image";
        preview.innerHTML = "";
        currentImage = null;
        applyPreviewHeight();
        deleteImageButton.disabled = !hasImage;

        const url = imageViewUrl(item.image);
        if (!url) {
            const empty = document.createElement("div");
            empty.className = "tr-preview-empty";
            empty.textContent = "Upload reference image";
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
            updatePromptNodeSize(node);
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
            syncPromptState(node);
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

    deleteImageButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.image = normalizeImage();
        fileInput.value = "";
        syncPromptState(node);
        drawPreview();
        updatePromptNodeSize(node);
    });

    fileInput.addEventListener("change", () => handleFiles(Array.from(fileInput.files || [])));

    section.addEventListener("dragover", (event) => {
        if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file")) {
            event.preventDefault();
            event.stopPropagation();
            section.classList.add("tr-dragover");
        }
    });
    section.addEventListener("dragleave", () => section.classList.remove("tr-dragover"));
    section.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        section.classList.remove("tr-dragover");
        handleFiles(Array.from(event.dataTransfer?.files || []));
    });

    drawPreview();
    const resizeHandle = makeResizeHandle("Drag to resize reference image", (height) => {
        if (height === undefined) {
            return previewHeight(item.image);
        }
        return setPreviewHeight(height);
    });

    section.append(fileRow, preview, resizeHandle, fileInput);
    return section;
}

// ── LoRA block ────────────────────────────────────────────────────────────────

function splitLoraPath(name) {
    const parts = String(name || "").replaceAll("\\", "/").split("/").filter(Boolean);
    if (parts.length <= 1) {
        return { folder: "Root", file: parts[0] || "" };
    }
    return { folder: parts.slice(0, -1).join("/"), file: parts[parts.length - 1] };
}

function loraFileName(name) {
    return splitLoraPath(name).file || "No LoRA";
}

function buildLoraTree(names) {
    const root = { folders: new Map(), files: [] };
    for (const name of names) {
        const parts = String(name || "").replaceAll("\\", "/").split("/").filter(Boolean);
        if (!parts.length) {
            continue;
        }
        let current = root;
        for (const part of parts.slice(0, -1)) {
            if (!current.folders.has(part)) {
                current.folders.set(part, { folders: new Map(), files: [] });
            }
            current = current.folders.get(part);
        }
        current.files.push({ name, label: parts[parts.length - 1] });
    }
    return root;
}

function loraNamesForNode(node, item) {
    const names = new Set(node.__promptTemplateState.loras || []);
    if (item.lora.name) {
        names.add(item.lora.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

function makeLoraMenuList(tree, onSelect) {
    const list = document.createElement("ul");
    list.className = "tr-lora-menu-list";

    const folders = [...tree.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [folder, childTree] of folders) {
        const item = document.createElement("li");
        item.className = "tr-lora-menu-folder";
        const button = createButton(folder, "tr-lora-menu-item");
        const submenu = makeLoraMenuList(childTree, onSelect);
        submenu.classList.add("tr-lora-submenu");
        item.addEventListener("mouseenter", () => {
            item.classList.remove("tr-lora-open-left");
            requestAnimationFrame(() => {
                const rect = submenu.getBoundingClientRect();
                if (rect.right > window.innerWidth - 8) {
                    item.classList.add("tr-lora-open-left");
                }
            });
        });
        item.append(button, submenu);
        list.appendChild(item);
    }

    const files = [...tree.files].sort((a, b) => a.label.localeCompare(b.label));
    for (const file of files) {
        const item = document.createElement("li");
        item.className = "tr-lora-menu-file";
        const button = createButton(file.label, "tr-lora-menu-item");
        button.title = file.name;
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(file.name);
        });
        item.appendChild(button);
        list.appendChild(item);
    }

    return list;
}

function makeLoraSearchResults(names, query, onSelect) {
    const results = document.createElement("div");
    results.className = "tr-lora-search-results";
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return results;
    }

    const matches = names.filter((name) => name.toLowerCase().includes(normalized)).slice(0, 60);
    if (!matches.length) {
        const empty = document.createElement("div");
        empty.className = "tr-lora-empty";
        empty.textContent = "No results";
        results.appendChild(empty);
        return results;
    }

    for (const name of matches) {
        const button = createButton(name, "tr-lora-search-item");
        button.title = name;
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(name);
        });
        results.appendChild(button);
    }
    return results;
}

function makeLoraPicker(node, item) {
    item.lora = normalizeLora(item.lora);
    const picker = document.createElement("div");
    picker.className = "tr-lora-picker";

    const button = createButton(item.lora.name ? loraFileName(item.lora.name) : "No LoRA", "tr-lora-select");
    button.title = item.lora.name || "No LoRA";
    const menu = document.createElement("div");
    menu.className = "tr-lora-menu";

    const names = loraNamesForNode(node, item);
    const tree = buildLoraTree(names);

    const closeMenu = () => {
        picker.classList.remove("tr-lora-open");
        menu.classList.remove("tr-lora-menu-open");
        menu.remove();
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        window.removeEventListener("resize", closeMenu, true);
        window.removeEventListener("scroll", closeMenu, true);
    };
    const selectLora = (name) => {
        item.lora = normalizeLora({ ...item.lora, name });
        button.textContent = name ? loraFileName(name) : "No LoRA";
        button.title = name || "No LoRA";
        syncPromptState(node);
        closeMenu();
    };
    const onDocumentPointerDown = (event) => {
        if (!picker.contains(event.target) && !menu.contains(event.target)) {
            closeMenu();
        }
    };

    const positionMenu = () => {
        const buttonRect = button.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const gap = 4;
        let left = buttonRect.left;
        let top = buttonRect.bottom + gap;

        if (left + menuRect.width > window.innerWidth - gap) {
            left = Math.max(gap, window.innerWidth - menuRect.width - gap);
        }
        if (top + menuRect.height > window.innerHeight - gap) {
            top = Math.max(gap, buttonRect.top - menuRect.height - gap);
        }

        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    };

    const rebuildMenu = (query = "") => {
        menu.innerHTML = "";
        const search = createInput(query, "Filter list");
        search.className = "tr-lora-filter";
        search.addEventListener("input", () => rebuildMenu(search.value));
        search.addEventListener("keydown", (event) => event.stopPropagation());

        const noneButton = createButton("None", "tr-lora-menu-item tr-lora-none");
        noneButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            selectLora("");
        });

        menu.append(search, noneButton);
        if (query.trim()) {
            menu.appendChild(makeLoraSearchResults(names, query, selectLora));
        } else {
            menu.appendChild(makeLoraMenuList(tree, selectLora));
        }
        requestAnimationFrame(() => search.focus());
    };

    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picker.classList.contains("tr-lora-open")) {
            closeMenu();
            return;
        }
        rebuildMenu();
        picker.classList.add("tr-lora-open");
        menu.classList.add("tr-lora-menu-open");
        document.body.appendChild(menu);
        positionMenu();
        requestAnimationFrame(positionMenu);
        document.addEventListener("pointerdown", onDocumentPointerDown, true);
        window.addEventListener("resize", closeMenu, true);
        window.addEventListener("scroll", closeMenu, true);
    });

    picker.append(button);
    return picker;
}

function makePromptLoraPanel(node, item) {
    item.lora = normalizeLora(item.lora);
    const section = document.createElement("div");
    section.className = "tr-lora-panel";

    const select = makeLoraPicker(node, item);
    const label = document.createElement("span");
    label.className = "tr-lora-label";
    label.textContent = "strength";

    const strength = document.createElement("input");
    strength.className = "tr-lora-strength";
    strength.type = "number";
    strength.step = "0.01";
    strength.value = String(item.lora.strength);
    strength.addEventListener("input", () => {
        const value = Number(strength.value);
        if (Number.isFinite(value)) {
            item.lora = normalizeLora({ ...item.lora, strength: value });
            syncPromptState(node);
        }
    });

    section.append(select, label, strength);
    return section;
}

// ── Prompt template block ──────────────────────────────────────────────────────

function makePromptTemplateBlock(node, item, index) {
    const block = document.createElement("section");
    block.className = "tr-block tr-text-block";

    const header = document.createElement("div");
    header.className = "tr-block-header";

    const label = document.createElement("span");
    label.className = "tr-block-type";
    label.textContent = "Template";
    attachBlockDrag(block, label, node.__promptTemplateState, item, () => refreshPromptNode(node));

    const toggleButton = createButton(item.collapsed ? "Show" : "Hide", "tr-toggle");
    const imageToggleButton = createButton("Image", "tr-toggle tr-image-toggle");
    const loraToggleButton = createButton("LoRA", "tr-toggle tr-lora-toggle");
    const copyButton = createButton("Copy", "tr-copy");
    const fitButton = createButton("Fit", "tr-fit-text");
    const deleteButton = createButton("Delete", "tr-delete");
    const headerActions = document.createElement("div");
    headerActions.className = "tr-header-actions";

    toggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.collapsed = !item.collapsed;
        refreshPromptNode(node);
    });

    imageToggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.image_collapsed = !item.image_collapsed;
        refreshPromptNode(node);
    });

    loraToggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.lora_collapsed = !item.lora_collapsed;
        refreshPromptNode(node);
    });

    deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.__promptTemplateState.items.splice(index, 1);
        refreshPromptNode(node);
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

    headerActions.append(toggleButton, imageToggleButton, loraToggleButton, copyButton, fitButton, deleteButton);
    header.append(label, headerActions);

    const title = makeEditableTitle(item.title, (value) => {
        item.title = value;
        syncPromptState(node);
        updatePromptSelectorOptions(node);
    });

    const textarea = document.createElement("textarea");
    textarea.className = "tr-text";
    textarea.value = item.text || "";
    textarea.placeholder = "prompt template";
    textarea.spellcheck = false;
    textarea.style.height = `${textHeight(item)}px`;
    textarea.style.minHeight = `${textHeight(item)}px`;

    const applyTextHeight = (height) => {
        item.text_height = clamp(Math.round(height), DEFAULT_TEXT_HEIGHT - 24, 420);
        textarea.style.height = `${item.text_height}px`;
        textarea.style.minHeight = `${item.text_height}px`;
        syncPromptState(node);
        updatePromptNodeSize(node);
        return item.text_height;
    };

    const fitTextHeight = () => {
        textarea.style.height = "auto";
        applyTextHeight(textarea.scrollHeight + 2);
    };

    textarea.addEventListener("input", () => {
        item.text = textarea.value;
        syncPromptState(node);
    });

    fitButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fitTextHeight();
    });

    const resizeHandle = makeResizeHandle("Drag to resize prompt template", (height) => {
        if (height === undefined) {
            return textHeight(item);
        }
        return applyTextHeight(height);
    });

    block.append(header, title);
    if (!item.collapsed) {
        block.append(textarea, resizeHandle);
        if (!item.image_collapsed) {
            block.append(makePromptReferenceImage(node, item));
        }
        if (!item.lora_collapsed) {
            block.append(makePromptLoraPanel(node, item));
        }
    }
    return block;
}

// ── Render (#4 — only rebuild the list portion) ────────────────────────────────

function renderPromptNode(node) {
    const state = node.__promptTemplateState;
    if (!state?.root) {
        return;
    }

    // Rebuild controls section (lightweight)
    state.root.innerHTML = "";
    state.root.appendChild(makePromptFileControls(node));
    state.root.appendChild(makePromptSelector(node));
    state.root.appendChild(makePromptControls(node));

    if (state.listHidden) {
        return;
    }

    // Rebuild item list
    const list = document.createElement("div");
    list.className = "tr-list";
    state.items.forEach((item, index) => {
        list.appendChild(makePromptTemplateBlock(node, item, index));
    });
    state.root.appendChild(list);
}

async function loadLoraList(node) {
    const state = node.__promptTemplateState;
    if (!state || state.loraLoadQueued) {
        return;
    }
    state.loraLoadQueued = true;
    try {
        state.loras = await fetchLoraList();
        renderPromptNode(node);
        updatePromptNodeSize(node);
    } catch (error) {
        console.error(error);
        state.loras = [];
    } finally {
        state.loraLoadQueued = false;
    }
}

// ── Editor creation ────────────────────────────────────────────────────────────

function createPromptEditor(node) {
    const container = document.createElement("div");
    container.className = "template-reference-editor prompt-template-editor";

    const root = document.createElement("div");
    root.className = "tr-root";
    container.appendChild(root);

    for (const eventName of ["mousedown", "pointerdown", "dblclick", "wheel"]) {
        container.addEventListener(eventName, stopCanvasEvent);
    }

    node.__promptTemplateState = {
        root,
        items: normalizePromptLoraItems(findWidget(node, PROMPT_STORAGE_WIDGET)?.value),
        listHidden: promptListHidden(findWidget(node, PROMPT_STORAGE_WIDGET)?.value),
        selectedId: promptSelectedId(findWidget(node, PROMPT_STORAGE_WIDGET)?.value),
        selector: null,
        fileName: promptFileName(findWidget(node, PROMPT_STORAGE_WIDGET)?.value),
        files: [],
        fileSelector: null,
        loras: [],
        loraLoadQueued: false,
        draggingId: "",
    };

    return container;
}

// ── Node setup (exported for use by template_reference.js registration) ────────

export function setupPromptLoraNode(node) {
    node.serialize_widgets = true;

    const storageWidget = findWidget(node, PROMPT_STORAGE_WIDGET);
    hideWidget(storageWidget);
    hideWidget(findWidget(node, "selected_template_id"));

    if (!node.__promptTemplateState) {
        const editor = createPromptEditor(node);
        node.addDOMWidget("prompt_template_editor", "div", editor, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => measuredPromptEditorHeight(node),
            onDraw: () => {
                editor.style.pointerEvents = "auto";
            },
        });
    } else {
        node.__promptTemplateState.items = normalizePromptLoraItems(storageWidget?.value);
        node.__promptTemplateState.listHidden = promptListHidden(storageWidget?.value);
        node.__promptTemplateState.selectedId = promptSelectedId(storageWidget?.value);
        node.__promptTemplateState.fileName = promptFileName(storageWidget?.value) || node.__promptTemplateState.fileName || "";
    }

    node.syncPromptTemplateLoRA = () => syncPromptState(node);
    renderPromptNode(node);
    syncPromptState(node);
    updatePromptNodeSize(node);
    loadPromptTemplateFiles(node, node.__promptTemplateState.fileName);
    loadLoraList(node);
}
