import { api } from "../../../scripts/api.js";
import { PROMPT_TEMPLATE_API, REFERENCE_TEMPLATE_API, normalizeTemplateList } from "./common.js";

// ── Reference Template API ─────────────────────────────────────────────────────

export async function fetchReferenceTemplateList() {
    const response = await api.fetchApi(REFERENCE_TEMPLATE_API, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return normalizeTemplateList(payload);
}

export async function openReferenceTemplateFile(name) {
    const response = await api.fetchApi(`${REFERENCE_TEMPLATE_API}/${encodeURIComponent(name)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
}

export async function saveReferenceTemplateFile(name, data) {
    const response = await api.fetchApi(`${REFERENCE_TEMPLATE_API}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, data }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
}

// ── Prompt Template API ────────────────────────────────────────────────────────

export async function fetchPromptTemplateList() {
    const response = await api.fetchApi(PROMPT_TEMPLATE_API, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return normalizeTemplateList(payload);
}

export async function openPromptTemplateFile(name) {
    const response = await api.fetchApi(`${PROMPT_TEMPLATE_API}/${encodeURIComponent(name)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
}

export async function savePromptTemplateFile(name, data) {
    const response = await api.fetchApi(`${PROMPT_TEMPLATE_API}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, data }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
}
