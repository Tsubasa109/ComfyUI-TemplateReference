import { api } from "../../../scripts/api.js";

// ── Constants ──────────────────────────────────────────────────────────────────
export const NODE_NAME = "TemplateReference";
export const STORAGE_WIDGET = "template_json";
export const PROMPT_NODE_NAME = "PromptTemplate";
export const PROMPT_STORAGE_WIDGET = "prompt_template_json";
export const PROMPT_TEMPLATE_API = "/template_reference/prompt_templates";
export const REFERENCE_TEMPLATE_API = "/template_reference/reference_templates";
export const NODE_MIN_WIDTH = 460;
export const NODE_MIN_HEIGHT = 150;
export const NODE_CHROME_HEIGHT = 92;
export const DOM_HEIGHT_PADDING = 18;
export const IMAGE_SUBFOLDER = "template_reference";
export const DEFAULT_TEXT_HEIGHT = 82;
export const MIN_TEXT_HEIGHT = 58;
export const MAX_TEXT_HEIGHT = 420;
export const DEFAULT_PREVIEW_HEIGHT = 138;
export const MIN_PREVIEW_HEIGHT = 96;
export const MAX_PREVIEW_HEIGHT = 380;

// ── ID generation (#11 — use crypto.randomUUID where available) ────────────
export function makeId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Widget helpers ─────────────────────────────────────────────────────────────
export function findWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

export function hideWidget(widget) {
    if (!widget || widget.__templateReferenceHidden) {
        return;
    }
    widget.type = "hidden";
    widget.computeSize = () => [0, -12];
    widget.draw = () => {};
    if (widget.inputEl) {
        widget.inputEl.style.display = "none";
    }
    widget.__templateReferenceHidden = true;
}

export function setWidgetValue(widget, value) {
    if (!widget) {
        return;
    }
    widget.value = value;
    if (widget.inputEl) {
        widget.inputEl.value = value;
    }
}

// ── Normalize helpers ──────────────────────────────────────────────────────────
export function normalizeImage(image = {}) {
    return {
        name: image.name || "",
        subfolder: image.subfolder || "",
        type: image.type || "input",
        path: image.path || "",
        preview_height: Number(image.preview_height) || DEFAULT_PREVIEW_HEIGHT,
        storage: image.storage || "",
        template: image.template || image.template_name || "",
        template_name: image.template_name || image.template || "",
    };
}

export function normalizeItems(value) {
    let payload;
    try {
        payload = JSON.parse(value || "{}");
    } catch {
        payload = {};
    }

    const rawItems = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    return rawItems
        .filter((item) => item && (item.type === "text" || item.type === "image"))
        .map((item) => {
            if (item.type === "text") {
                return {
                    id: item.id || makeId(),
                    type: "text",
                    title: item.title || "",
                    text: item.text || "",
                    text_height: Number(item.text_height) || DEFAULT_TEXT_HEIGHT,
                    collapsed: Boolean(item.collapsed),
                };
            }

            return {
                id: item.id || makeId(),
                type: "image",
                title: item.title || "",
                collapsed: Boolean(item.collapsed),
                image: normalizeImage(item.image),
            };
        });
}

export function normalizePromptItems(value) {
    let payload;
    try {
        payload = JSON.parse(value || "{}");
    } catch {
        payload = {};
    }

    const rawItems = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    return rawItems
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
            id: item.id || makeId(),
            type: "text",
            title: item.title || "",
            text: item.text || "",
            text_height: Number(item.text_height) || DEFAULT_TEXT_HEIGHT,
            collapsed: Boolean(item.collapsed),
            image_collapsed: item.image_collapsed !== false,
            image: normalizeImage(item.image),
        }));
}

export function normalizeTemplateList(payload) {
    return Array.isArray(payload?.templates) ? payload.templates.filter((name) => typeof name === "string") : [];
}

// ── Serialization ──────────────────────────────────────────────────────────────
export function serializeItems(items) {
    return JSON.stringify({ version: 1, items });
}

export function serializeReferenceState(state) {
    return JSON.stringify({ version: 1, selected_id: state.selectedId || "", list_hidden: Boolean(state.listHidden), items: state.items });
}

// ── JSON field parsers ─────────────────────────────────────────────────────────
export function referenceSelectedId(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return typeof payload?.selected_id === "string" ? payload.selected_id : "";
    } catch {
        return "";
    }
}

export function referenceListHidden(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return Boolean(payload?.list_hidden);
    } catch {
        return false;
    }
}

export function referenceFileName(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return typeof payload?.file_name === "string" ? payload.file_name : "";
    } catch {
        return "";
    }
}

export function promptSelectedId(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return typeof payload?.selected_id === "string" ? payload.selected_id : "";
    } catch {
        return "";
    }
}

export function promptListHidden(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return Boolean(payload?.list_hidden);
    } catch {
        return false;
    }
}

export function promptFileName(value) {
    try {
        const payload = JSON.parse(value || "{}");
        return typeof payload?.file_name === "string" ? payload.file_name : "";
    } catch {
        return "";
    }
}

export function promptPayloadFromState(state) {
    return {
        version: 1,
        selected_id: state.selectedId || "",
        list_hidden: Boolean(state.listHidden),
        items: state.items,
    };
}

export function referencePayloadFromState(state) {
    return {
        version: 1,
        selected_id: state.selectedId || "",
        list_hidden: Boolean(state.listHidden),
        items: state.items,
    };
}

// ── Image path helpers ─────────────────────────────────────────────────────────
export function imagePath(image) {
    if (!image) {
        return "";
    }
    if (image.path) {
        return image.path;
    }
    if (!image.name) {
        return "";
    }
    return image.subfolder ? `${image.subfolder}/${image.name}` : image.name;
}

export function imageViewUrl(image) {
    if (!image?.name) {
        return "";
    }

    if (image.storage === "prompt_template" || image.type === "prompt_template") {
        let templateName = image.template || image.template_name || "";
        if (!templateName && image.path) {
            const parts = image.path.replaceAll("\\", "/").split("/");
            const imagesIndex = parts.findIndex((part) => part === "images");
            if (imagesIndex >= 0 && parts[imagesIndex + 1]) {
                templateName = parts[imagesIndex + 1];
            }
        }
        if (!templateName) {
            return "";
        }
        return api.apiURL(`${PROMPT_TEMPLATE_API}/image/${encodeURIComponent(templateName)}/${encodeURIComponent(image.name)}?t=${Date.now()}`);
    }

    if (image.storage === "template_reference_file" || image.type === "template_reference_file") {
        let templateName = image.template || image.template_name || "";
        if (!templateName && image.path) {
            const parts = image.path.replaceAll("\\", "/").split("/");
            const imageIndex = parts.findIndex((part) => part === "image");
            if (imageIndex >= 0 && parts[imageIndex + 1]) {
                templateName = parts[imageIndex + 1];
            }
        }
        if (!templateName) {
            return "";
        }
        return api.apiURL(`${REFERENCE_TEMPLATE_API}/image/${encodeURIComponent(templateName)}/${encodeURIComponent(image.name)}?t=${Date.now()}`);
    }

    const params = new URLSearchParams({
        filename: image.name,
        type: image.type || "input",
        subfolder: image.subfolder || "",
        t: Date.now().toString(),
    });
    return api.apiURL(`/view?${params.toString()}`);
}

// ── Math helpers ───────────────────────────────────────────────────────────────
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function previewHeight(image) {
    return clamp(Number(image?.preview_height) || DEFAULT_PREVIEW_HEIGHT, MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
}

export function textHeight(item) {
    return clamp(Number(item?.text_height) || DEFAULT_TEXT_HEIGHT, MIN_TEXT_HEIGHT, MAX_TEXT_HEIGHT);
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
export function stopCanvasEvent(event) {
    event.stopPropagation();
}

export function createButton(label, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    return button;
}

export function createInput(value, placeholder) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
}

export function makeEditableTitle(initialValue, onChange, placeholder = "Title") {
    const wrapper = document.createElement("div");
    wrapper.className = "tr-title-editor";
    let value = initialValue || "";
    let originalValue = value;

    const showDisplay = () => {
        wrapper.innerHTML = "";
        const display = createButton(value || placeholder, "tr-title tr-title-display");
        display.title = "Click to edit title";
        if (!value) {
            display.classList.add("tr-title-placeholder");
        }
        display.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            showInput();
        });
        wrapper.appendChild(display);
    };

    const showInput = () => {
        wrapper.innerHTML = "";
        originalValue = value;
        const input = createInput(value, placeholder);
        input.className = "tr-title tr-title-input";

        input.addEventListener("input", () => {
            value = input.value;
            onChange(value);
        });

        input.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
                event.preventDefault();
                input.blur();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                value = originalValue;
                onChange(value);
                showDisplay();
            }
        });

        input.addEventListener("blur", showDisplay);
        wrapper.appendChild(input);
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    };

    showDisplay();
    return wrapper;
}

export async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    document.body.appendChild(input);
    input.focus();
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) {
        throw new Error("Copy failed");
    }
}

export function makeResizeHandle(label, onResize) {
    const handle = document.createElement("div");
    handle.className = "tr-resize-handle";
    handle.title = label;

    handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const startY = event.clientY;
        const startHeight = onResize();

        const onMove = (moveEvent) => {
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            onResize(startHeight + moveEvent.clientY - startY);
        };

        const onUp = (upEvent) => {
            upEvent.preventDefault();
            upEvent.stopPropagation();
            document.removeEventListener("pointermove", onMove, true);
            document.removeEventListener("pointerup", onUp, true);
        };

        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onUp, true);
    });

    return handle;
}

// ── Drag & drop reorder ────────────────────────────────────────────────────────
export function moveItem(items, fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
        return false;
    }
    const [item] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, item);
    return true;
}

export function attachBlockDrag(block, handle, state, item, refresh) {
    handle.draggable = true;
    handle.title = "Drag to reorder";
    handle.classList.add("tr-drag-handle");

    handle.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        state.draggingId = item.id;
        block.classList.add("tr-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
    });

    handle.addEventListener("dragend", (event) => {
        event.stopPropagation();
        state.draggingId = "";
        block.classList.remove("tr-dragging");
    });

    block.addEventListener("dragover", (event) => {
        if (!state.draggingId || state.draggingId === item.id) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        block.classList.add("tr-drop-target");
    });

    block.addEventListener("dragleave", () => {
        block.classList.remove("tr-drop-target");
    });

    block.addEventListener("drop", (event) => {
        if (!state.draggingId || state.draggingId === item.id) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        block.classList.remove("tr-drop-target");

        const fromIndex = state.items.findIndex((entry) => entry.id === state.draggingId);
        const toIndex = state.items.findIndex((entry) => entry.id === item.id);
        state.draggingId = "";
        if (moveItem(state.items, fromIndex, toIndex)) {
            refresh();
        }
    });
}

// ── Bulk toggle ────────────────────────────────────────────────────────────────
export function areAllItemsCollapsed(items) {
    return Boolean(items?.length) && items.every((item) => item.collapsed);
}

export function makeBulkToggleButton(items, refresh, disabledLabel = "Hide All") {
    const button = createButton(areAllItemsCollapsed(items) ? "Show All" : "Hide All", "tr-bulk-toggle");
    button.disabled = !items?.length;
    if (!items?.length) {
        button.textContent = disabledLabel;
    }

    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const collapsed = !areAllItemsCollapsed(items);
        items.forEach((item) => {
            item.collapsed = collapsed;
        });
        refresh();
    });

    return button;
}

// ── Image upload ───────────────────────────────────────────────────────────────
export async function uploadImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("subfolder", IMAGE_SUBFOLDER);

    const response = await api.fetchApi("/upload/image", {
        method: "POST",
        body,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload?.error || `${response.status} ${response.statusText}`);
    }

    const image = {
        name: payload.name || file.name,
        subfolder: payload.subfolder || IMAGE_SUBFOLDER,
        type: payload.type || "input",
    };
    image.path = imagePath(image);
    return image;
}

// ── Toast notifications (#6 — replace alert()) ────────────────────────────────
let toastContainer = null;

function ensureToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) {
        return toastContainer;
    }
    toastContainer = document.createElement("div");
    toastContainer.className = "tr-toast-container";
    document.body.appendChild(toastContainer);
    return toastContainer;
}

export function showToast(message, type = "error", durationMs = 4000) {
    const container = ensureToastContainer();
    const toast = document.createElement("div");
    toast.className = `tr-toast tr-toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    const dismiss = () => {
        toast.style.animation = "tr-toast-out 0.3s ease-in forwards";
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    };

    toast.addEventListener("click", dismiss);
    setTimeout(dismiss, durationMs);
}
