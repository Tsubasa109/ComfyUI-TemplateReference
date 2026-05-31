import hashlib
import json
import logging
import os
import re
import shutil
from pathlib import Path

import folder_paths
import comfy.sd
import comfy.utils
import node_helpers
import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps
from server import PromptServer


EXTENSION_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = Path(folder_paths.get_user_directory()) / "template_reference"
LEGACY_PROMPT_TEMPLATES_DIR = EXTENSION_DIR / "prompt_templates"
LEGACY_REFERENCE_TEMPLATES_DIR = EXTENSION_DIR / "Template Reference"
PROMPT_TEMPLATES_DIR = STORAGE_ROOT / "prompt_templates"
PROMPT_TEMPLATE_IMAGES_DIR = PROMPT_TEMPLATES_DIR / "images"
PROMPT_TEMPLATES_LORA_DIR = STORAGE_ROOT / "prompt_templates_lora"
PROMPT_TEMPLATE_LORA_IMAGES_DIR = PROMPT_TEMPLATES_LORA_DIR / "images"
REFERENCE_TEMPLATES_DIR = STORAGE_ROOT / "reference_templates"
REFERENCE_TEMPLATE_IMAGES_DIR = REFERENCE_TEMPLATES_DIR / "image"
LEGACY_PROMPT_TEMPLATE_IMAGES_DIR = LEGACY_PROMPT_TEMPLATES_DIR / "images"
LEGACY_REFERENCE_TEMPLATE_IMAGES_DIR = LEGACY_REFERENCE_TEMPLATES_DIR / "image"
LOGGER = logging.getLogger(__name__)
_LOADED_LORA_CACHE = None


def _ensure_prompt_templates_dir():
    PROMPT_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    PROMPT_TEMPLATE_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    return PROMPT_TEMPLATES_DIR


def _ensure_prompt_templates_lora_dir():
    PROMPT_TEMPLATES_LORA_DIR.mkdir(parents=True, exist_ok=True)
    PROMPT_TEMPLATE_LORA_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    return PROMPT_TEMPLATES_LORA_DIR


def _ensure_reference_templates_dir():
    REFERENCE_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    REFERENCE_TEMPLATE_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    return REFERENCE_TEMPLATES_DIR


def _existing_template_dirs(primary, legacy):
    dirs = [primary]
    if legacy != primary and legacy.is_dir():
        dirs.append(legacy)
    return dirs


def _safe_prompt_template_name(name):
    name = str(name or "").strip()
    if name.lower().endswith(".json"):
        name = name[:-5]
    if not name or re.search(r"[\x00-\x1f]", name):
        raise ValueError("Invalid template name.")
    if any(separator in name for separator in ("/", "\\")) or ":" in name:
        raise ValueError("Template name must not contain path separators.")
    safe = re.sub(r"[^0-9A-Za-z._ \-\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]", "_", name).strip(" .")
    if not safe:
        raise ValueError("Invalid template name after sanitization.")
    return safe


def _prompt_template_path(name):
    safe = _safe_prompt_template_name(name)
    base = _ensure_prompt_templates_dir().resolve()
    path = (base / f"{safe}.json").resolve()
    if base != path.parent:
        raise ValueError("Template path escapes storage directory.")
    return safe, path


def _prompt_template_lora_path(name):
    safe = _safe_prompt_template_name(name)
    if not safe.lower().endswith("lora"):
        safe = f"{safe}_lora"
    base = _ensure_prompt_templates_lora_dir().resolve()
    path = (base / f"{safe}.json").resolve()
    if base != path.parent:
        raise ValueError("Prompt Template LoRA path escapes storage directory.")
    return safe, path


def _existing_prompt_template_path(name):
    safe = _safe_prompt_template_name(name)
    for base in _existing_template_dirs(_ensure_prompt_templates_dir(), LEGACY_PROMPT_TEMPLATES_DIR):
        path = (base.resolve() / f"{safe}.json").resolve()
        if base.resolve() == path.parent and path.is_file():
            return safe, path
    return safe, (_ensure_prompt_templates_dir().resolve() / f"{safe}.json").resolve()


def _existing_prompt_template_lora_path(name):
    safe = _safe_prompt_template_name(name)
    base = _ensure_prompt_templates_lora_dir().resolve()
    path = (base / f"{safe}.json").resolve()
    if base == path.parent and path.is_file():
        return safe, path
    return safe, path


def _reference_template_path(name):
    safe = _safe_prompt_template_name(name)
    base = _ensure_reference_templates_dir().resolve()
    path = (base / f"{safe}.json").resolve()
    if base != path.parent:
        raise ValueError("Template Reference path escapes storage directory.")
    return safe, path


def _existing_reference_template_path(name):
    safe = _safe_prompt_template_name(name)
    for base in _existing_template_dirs(_ensure_reference_templates_dir(), LEGACY_REFERENCE_TEMPLATES_DIR):
        path = (base.resolve() / f"{safe}.json").resolve()
        if base.resolve() == path.parent and path.is_file():
            return safe, path
    return safe, (_ensure_reference_templates_dir().resolve() / f"{safe}.json").resolve()


def _safe_image_filename(name):
    name = Path(str(name or "")).name.strip()
    if not name or re.search(r"[\x00-\x1f]", name):
        raise ValueError("Invalid image file name.")
    safe = re.sub(r"[^0-9A-Za-z._ \-\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]", "_", name).strip(" .")
    if not safe:
        raise ValueError("Invalid image file name after sanitization.")
    return safe


def _stored_image_dir(template_name, base_dir=PROMPT_TEMPLATE_IMAGES_DIR):
    safe = _safe_prompt_template_name(template_name)
    base = base_dir.resolve()
    folder = (base / safe).resolve()
    if base not in folder.parents and base != folder:
        raise ValueError("Image directory escapes storage directory.")
    folder.mkdir(parents=True, exist_ok=True)
    return safe, folder


def _stored_image_path(template_name, image_name, base_dir=PROMPT_TEMPLATE_IMAGES_DIR):
    safe_template, folder = _stored_image_dir(template_name, base_dir)
    safe_image = _safe_image_filename(image_name)
    path = (folder / safe_image).resolve()
    if folder != path.parent:
        raise ValueError("Image path escapes storage directory.")
    return safe_template, safe_image, path


def _unique_image_path(template_name, image_name, base_dir=PROMPT_TEMPLATE_IMAGES_DIR):
    safe_template, safe_image, path = _stored_image_path(template_name, image_name, base_dir)
    stem = Path(safe_image).stem
    suffix = Path(safe_image).suffix
    index = 1
    while path.exists():
        safe_image = f"{stem}_{index}{suffix}"
        _, _, path = _stored_image_path(safe_template, safe_image, base_dir)
        index += 1
    return safe_template, safe_image, path


def _source_image_path(image):
    """Resolve an image dict to a filesystem Path.

    Resolution order:
    1. Prompt-template storage (storage == 'prompt_template')
    2. Reference-template storage (storage == 'template_reference_file')
    3. ComfyUI annotated file path fallback
    """
    if not isinstance(image, dict):
        return None
    local_path = _local_saved_image_path(image.get("path"))
    if local_path is not None:
        return local_path
    if image.get("storage") in ("prompt_template", "prompt_template_lora") or image.get("type") in ("prompt_template", "prompt_template_lora"):
        template_name = image.get("template") or image.get("template_name") or ""
        name = image.get("name") or ""
        if not template_name and image.get("path"):
            parts = str(image.get("path") or "").replace("\\", "/").split("/")
            if "images" in parts:
                index = parts.index("images")
                if len(parts) > index + 1:
                    template_name = parts[index + 1]
        if template_name and name:
            bases = [PROMPT_TEMPLATE_IMAGES_DIR, LEGACY_PROMPT_TEMPLATE_IMAGES_DIR]
            if image.get("storage") == "prompt_template_lora" or image.get("type") == "prompt_template_lora":
                bases = [PROMPT_TEMPLATE_LORA_IMAGES_DIR, PROMPT_TEMPLATE_IMAGES_DIR, LEGACY_PROMPT_TEMPLATE_IMAGES_DIR]
            for base in bases:
                _, _, path = _stored_image_path(template_name, name, base)
                if path.is_file():
                    return path
    if image.get("storage") == "template_reference_file" or image.get("type") == "template_reference_file":
        template_name = image.get("template") or image.get("template_name") or ""
        name = image.get("name") or ""
        if not template_name and image.get("path"):
            parts = str(image.get("path") or "").replace("\\", "/").split("/")
            if "image" in parts:
                index = parts.index("image")
                if len(parts) > index + 1:
                    template_name = parts[index + 1]
        if template_name and name:
            for base in (REFERENCE_TEMPLATE_IMAGES_DIR, LEGACY_REFERENCE_TEMPLATE_IMAGES_DIR):
                _, _, path = _stored_image_path(template_name, name, base)
                if path.is_file():
                    return path
    image_path = TemplateReference._image_path_from_item({"image": image})
    if not image_path:
        return None
    try:
        full_path = Path(folder_paths.get_annotated_filepath(image_path))
    except Exception:
        return None
    return full_path if full_path.is_file() else None


def _local_saved_image_path(image_path):
    normalized = str(image_path or "").replace("\\", "/").strip("/")
    if not normalized:
        return None

    parts = normalized.split("/")
    if len(parts) >= 4 and parts[0] == "prompt_templates_lora" and parts[1] == "images":
        try:
            _, _, path = _stored_image_path(parts[2], parts[-1], PROMPT_TEMPLATE_LORA_IMAGES_DIR)
            if path.is_file():
                return path
        except ValueError:
            pass

    if len(parts) >= 4 and parts[0] == "prompt_templates" and parts[1] == "images":
        for base in (PROMPT_TEMPLATE_IMAGES_DIR, LEGACY_PROMPT_TEMPLATE_IMAGES_DIR):
            try:
                _, _, path = _stored_image_path(parts[2], parts[-1], base)
                if path.is_file():
                    return path
            except ValueError:
                continue

    if len(parts) >= 4 and parts[0] == "Template Reference" and parts[1] == "image":
        for base in (REFERENCE_TEMPLATE_IMAGES_DIR, LEGACY_REFERENCE_TEMPLATE_IMAGES_DIR):
            try:
                _, _, path = _stored_image_path(parts[2], parts[-1], base)
                if path.is_file():
                    return path
            except ValueError:
                continue

    return None


def _copy_prompt_template_images(template_name, data):
    used_names = set()
    for item in data.get("items", []):
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        source = _source_image_path(image)
        if source is None:
            continue

        preferred = image.get("name") or source.name
        safe_template, safe_image, destination = _stored_image_path(template_name, preferred)
        if safe_image in used_names and source.resolve() != destination.resolve():
            safe_template, safe_image, destination = _unique_image_path(template_name, preferred)
        used_names.add(safe_image)

        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)

        image["name"] = safe_image
        image["subfolder"] = ""
        image["type"] = "prompt_template"
        image["path"] = f"prompt_templates/images/{safe_template}/{safe_image}"
        image["storage"] = "prompt_template"
        image["template"] = safe_template
        image["template_name"] = safe_template
        item["image"] = image
    return data


def _copy_prompt_template_lora_images(template_name, data):
    used_names = set()
    for item in data.get("items", []):
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        source = _source_image_path(image)
        if source is None:
            continue

        preferred = image.get("name") or source.name
        safe_template, safe_image, destination = _stored_image_path(template_name, preferred, PROMPT_TEMPLATE_LORA_IMAGES_DIR)
        if safe_image in used_names and source.resolve() != destination.resolve():
            safe_template, safe_image, destination = _unique_image_path(template_name, preferred, PROMPT_TEMPLATE_LORA_IMAGES_DIR)
        used_names.add(safe_image)

        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)

        image["name"] = safe_image
        image["subfolder"] = ""
        image["type"] = "prompt_template_lora"
        image["path"] = f"prompt_templates_lora/images/{safe_template}/{safe_image}"
        image["storage"] = "prompt_template_lora"
        image["template"] = safe_template
        image["template_name"] = safe_template
        item["image"] = image
    return data


def _copy_reference_template_images(template_name, data):
    used_names = set()
    for item in data.get("items", []):
        if item.get("type") != "image":
            continue
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        source = _source_image_path(image)
        if source is None:
            continue

        preferred = image.get("name") or source.name
        safe_template, safe_image, destination = _stored_image_path(template_name, preferred, REFERENCE_TEMPLATE_IMAGES_DIR)
        if safe_image in used_names and source.resolve() != destination.resolve():
            safe_template, safe_image, destination = _unique_image_path(template_name, preferred, REFERENCE_TEMPLATE_IMAGES_DIR)
        used_names.add(safe_image)

        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)

        image["name"] = safe_image
        image["subfolder"] = ""
        image["type"] = "template_reference_file"
        image["path"] = f"Template Reference/image/{safe_template}/{safe_image}"
        image["storage"] = "template_reference_file"
        image["template"] = safe_template
        image["template_name"] = safe_template
        item["image"] = image
    return data


def _normalize_prompt_template_payload(data):
    if isinstance(data, str):
        payload = json.loads(data or "{}")
    elif isinstance(data, dict):
        payload = data
    else:
        raise ValueError("Template data must be a JSON object.")
    if not isinstance(payload, dict):
        raise ValueError("Template data must be a JSON object.")
    items = PromptTemplate._parse_items(json.dumps(payload, ensure_ascii=False))
    selected_id = PromptTemplate._selected_id(json.dumps(payload, ensure_ascii=False))
    return {
        "version": 1,
        "selected_id": selected_id,
        "list_hidden": bool(payload.get("list_hidden")),
        "items": items,
    }


def _normalize_prompt_template_lora_payload(data):
    if isinstance(data, str):
        payload = json.loads(data or "{}")
    elif isinstance(data, dict):
        payload = data
    else:
        raise ValueError("Prompt Template LoRA data must be a JSON object.")
    if not isinstance(payload, dict):
        raise ValueError("Prompt Template LoRA data must be a JSON object.")
    items = PromptTemplateLoRA._parse_items(json.dumps(payload, ensure_ascii=False))
    selected_id = PromptTemplateLoRA._selected_id(json.dumps(payload, ensure_ascii=False))
    return {
        "version": 1,
        "selected_id": selected_id,
        "list_hidden": bool(payload.get("list_hidden")),
        "items": items,
    }


@PromptServer.instance.routes.get("/template_reference/loras")
async def list_loras(request):
    try:
        return web.json_response({"success": True, "loras": folder_paths.get_filename_list("loras")})
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


def _normalize_reference_template_payload(data):
    if isinstance(data, str):
        payload = json.loads(data or "{}")
    elif isinstance(data, dict):
        payload = data
    else:
        raise ValueError("Template Reference data must be a JSON object.")
    if not isinstance(payload, dict):
        raise ValueError("Template Reference data must be a JSON object.")
    items = TemplateReference._parse_items(json.dumps(payload, ensure_ascii=False))
    selected_id = TemplateReference._selected_id(json.dumps(payload, ensure_ascii=False))
    return {
        "version": 1,
        "selected_id": selected_id,
        "list_hidden": bool(payload.get("list_hidden")),
        "items": items,
    }


@PromptServer.instance.routes.get("/template_reference/prompt_templates")
async def list_prompt_templates(request):
    try:
        folder = _ensure_prompt_templates_dir()
        files = {
            path.stem
            for base in _existing_template_dirs(folder, LEGACY_PROMPT_TEMPLATES_DIR)
            for path in base.glob("*.json")
            if path.is_file()
        }
        files = sorted(files)
        return web.json_response({"success": True, "templates": files})
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/prompt_templates/{name}")
async def open_prompt_template(request):
    try:
        safe, path = _existing_prompt_template_path(request.match_info.get("name", ""))
        if not path.is_file():
            return web.json_response({"success": False, "error": "Template file not found."}, status=404)
        with path.open("r", encoding="utf-8") as file:
            payload = json.load(file)
        data = _normalize_prompt_template_payload(payload)
        return web.json_response({"success": True, "name": safe, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Template JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/prompt_templates/image/{template}/{image}")
async def view_prompt_template_image(request):
    try:
        _, _, path = _stored_image_path(request.match_info.get("template", ""), request.match_info.get("image", ""))
        if not path.is_file():
            return web.json_response({"success": False, "error": "Image file not found."}, status=404)
        return web.FileResponse(path)
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/template_reference/prompt_templates/save")
async def save_prompt_template(request):
    try:
        body = await request.json()
        safe, path = _prompt_template_path(body.get("name", ""))
        data = _normalize_prompt_template_payload(body.get("data"))
        data = _copy_prompt_template_images(safe, data)
        with path.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
        files = sorted(item.stem for item in _ensure_prompt_templates_dir().glob("*.json") if item.is_file())
        return web.json_response({"success": True, "name": safe, "templates": files, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Template JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/prompt_templates_lora")
async def list_prompt_templates_lora(request):
    try:
        folder = _ensure_prompt_templates_lora_dir()
        files = {
            path.stem
            for path in folder.glob("*.json")
            if path.is_file()
        }
        files.update(
            path.stem
            for base in _existing_template_dirs(_ensure_prompt_templates_dir(), LEGACY_PROMPT_TEMPLATES_DIR)
            for path in base.glob("*.json")
            if path.is_file()
        )
        files = sorted(files)
        return web.json_response({"success": True, "templates": files})
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/prompt_templates_lora/{name}")
async def open_prompt_template_lora(request):
    try:
        safe, path = _existing_prompt_template_lora_path(request.match_info.get("name", ""))
        if not path.is_file():
            safe, path = _existing_prompt_template_path(request.match_info.get("name", ""))
        if not path.is_file():
            return web.json_response({"success": False, "error": "Prompt Template file not found."}, status=404)
        with path.open("r", encoding="utf-8") as file:
            payload = json.load(file)
        data = _normalize_prompt_template_lora_payload(payload)
        return web.json_response({"success": True, "name": safe, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Prompt Template LoRA JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/prompt_templates_lora/image/{template}/{image}")
async def view_prompt_template_lora_image(request):
    try:
        _, _, path = _stored_image_path(
            request.match_info.get("template", ""),
            request.match_info.get("image", ""),
            PROMPT_TEMPLATE_LORA_IMAGES_DIR,
        )
        if not path.is_file():
            return web.json_response({"success": False, "error": "Image file not found."}, status=404)
        return web.FileResponse(path)
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/template_reference/prompt_templates_lora/save")
async def save_prompt_template_lora(request):
    try:
        body = await request.json()
        safe, path = _prompt_template_lora_path(body.get("name", ""))
        data = _normalize_prompt_template_lora_payload(body.get("data"))
        data = _copy_prompt_template_lora_images(safe, data)
        with path.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
        files = sorted(item.stem for item in _ensure_prompt_templates_lora_dir().glob("*.json") if item.is_file())
        return web.json_response({"success": True, "name": safe, "templates": files, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Prompt Template LoRA JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/reference_templates")
async def list_reference_templates(request):
    try:
        folder = _ensure_reference_templates_dir()
        files = {
            path.stem
            for base in _existing_template_dirs(folder, LEGACY_REFERENCE_TEMPLATES_DIR)
            for path in base.glob("*.json")
            if path.is_file()
        }
        files = sorted(files)
        return web.json_response({"success": True, "templates": files})
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/reference_templates/{name}")
async def open_reference_template(request):
    try:
        safe, path = _existing_reference_template_path(request.match_info.get("name", ""))
        if not path.is_file():
            return web.json_response({"success": False, "error": "Template Reference file not found."}, status=404)
        with path.open("r", encoding="utf-8") as file:
            payload = json.load(file)
        data = _normalize_reference_template_payload(payload)
        return web.json_response({"success": True, "name": safe, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Template Reference JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/template_reference/reference_templates/image/{template}/{image}")
async def view_reference_template_image(request):
    try:
        _, _, path = _stored_image_path(
            request.match_info.get("template", ""),
            request.match_info.get("image", ""),
            REFERENCE_TEMPLATE_IMAGES_DIR,
        )
        if not path.is_file():
            return web.json_response({"success": False, "error": "Image file not found."}, status=404)
        return web.FileResponse(path)
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/template_reference/reference_templates/save")
async def save_reference_template(request):
    try:
        body = await request.json()
        safe, path = _reference_template_path(body.get("name", ""))
        data = _normalize_reference_template_payload(body.get("data"))
        data = _copy_reference_template_images(safe, data)
        with path.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
        files = sorted(item.stem for item in _ensure_reference_templates_dir().glob("*.json") if item.is_file())
        return web.json_response({"success": True, "name": safe, "templates": files, "data": data})
    except ValueError as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=400)
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "Template Reference JSON is invalid."}, status=400)
    except Exception as exc:
        return web.json_response({"success": False, "error": str(exc)}, status=500)


def _parse_selected_id(json_str, fallback=""):
    try:
        payload = json.loads(json_str or "{}")
    except Exception:
        return str(fallback or "")
    if not isinstance(payload, dict):
        return str(fallback or "")
    if "selected_id" in payload:
        return str(payload.get("selected_id") or "")
    return str(fallback or "")


def _parse_list_hidden(json_str):
    try:
        payload = json.loads(json_str or "{}")
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    return bool(payload.get("list_hidden"))


class TemplateReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template_json": (
                    "STRING",
                    {
                        "default": '{"version":1,"items":[]}',
                        "multiline": True,
                        "tooltip": "Serialized text and image reference blocks edited by the custom UI.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("select_text", "select_image", "template_json")
    FUNCTION = "build_reference"
    CATEGORY = "template_reference"
    DESCRIPTION = "Outputs text or image from the selected reference block."

    def build_reference(self, template_json):
        items = self._parse_items(template_json)
        selected_id = self._selected_id(template_json)
        list_hidden = self._list_hidden(template_json)
        select_text = ""
        select_image = self._placeholder_image()

        if items and selected_id:
            selected = next((item for item in items if str(item.get("id") or "") == str(selected_id)), None)
            if selected and selected.get("type") == "text":
                select_text = str(selected.get("text") or "")
            elif selected and selected.get("type") == "image":
                loaded = self._load_image(self._image_path_from_item(selected))
                if loaded is not None:
                    select_image = loaded

        normalized_json = json.dumps({"version": 1, "selected_id": selected_id, "list_hidden": list_hidden, "items": items}, ensure_ascii=False)
        return (select_text, select_image, normalized_json)

    @classmethod
    def IS_CHANGED(cls, template_json):
        hasher = hashlib.sha256()
        hasher.update(str(template_json).encode("utf-8", errors="replace"))

        for item in cls._parse_items(template_json):
            image_path = cls._image_path_from_item(item)
            if not image_path:
                continue
            try:
                full_path = _local_saved_image_path(image_path) or Path(folder_paths.get_annotated_filepath(image_path))
                stat = full_path.stat()
                hasher.update(f"{full_path}:{stat.st_mtime}:{stat.st_size}".encode())
            except Exception:
                hasher.update(f"missing:{image_path}".encode("utf-8", errors="replace"))

        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, template_json):
        try:
            payload = json.loads(template_json or "{}")
        except (json.JSONDecodeError, TypeError):
            return "template_json is not valid JSON."
        if not isinstance(payload, dict):
            return "template_json must be a JSON object."
        return True

    @staticmethod
    def _selected_id(template_json):
        return _parse_selected_id(template_json)

    @staticmethod
    def _list_hidden(template_json):
        return _parse_list_hidden(template_json)

    @staticmethod
    def _parse_items(template_json):
        try:
            payload = json.loads(template_json or "{}")
        except Exception:
            return []

        raw_items = payload.get("items", payload) if isinstance(payload, dict) else payload
        if not isinstance(raw_items, list):
            return []

        items = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue

            item_type = raw.get("type")
            if item_type not in {"text", "image"}:
                continue

            item = {
                "id": str(raw.get("id") or ""),
                "type": item_type,
                "title": str(raw.get("title") or ""),
                "collapsed": bool(raw.get("collapsed")),
            }

            if item_type == "text":
                item["text"] = str(raw.get("text") or "")
                try:
                    item["text_height"] = int(raw.get("text_height") or 82)
                except (TypeError, ValueError):
                    item["text_height"] = 82
            else:
                image = raw.get("image") if isinstance(raw.get("image"), dict) else {}
                try:
                    preview_height = int(image.get("preview_height") or 138)
                except (TypeError, ValueError):
                    preview_height = 138

                item["image"] = {
                    "name": str(image.get("name") or ""),
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "input"),
                    "path": str(image.get("path") or ""),
                    "preview_height": preview_height,
                    "storage": str(image.get("storage") or ""),
                    "template": str(image.get("template") or image.get("template_name") or ""),
                    "template_name": str(image.get("template_name") or image.get("template") or ""),
                }

            items.append(item)

        return items

    @staticmethod
    def _image_path_from_item(item):
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        path = str(image.get("path") or "").replace("\\", "/").strip("/")
        if path:
            return path

        name = str(image.get("name") or "").replace("\\", "/").strip("/")
        subfolder = str(image.get("subfolder") or "").replace("\\", "/").strip("/")
        if not name:
            return ""
        return f"{subfolder}/{name}" if subfolder else name

    @staticmethod
    def _load_image(image_path):
        try:
            full_path = _local_saved_image_path(image_path) or Path(folder_paths.get_annotated_filepath(image_path))
            if not os.path.isfile(full_path):
                LOGGER.warning("Template Reference image not found: %s", image_path)
                return None

            img = node_helpers.pillow(Image.open, full_path)
            img = node_helpers.pillow(ImageOps.exif_transpose, img)

            image = img.convert("RGB")
            image_np = np.array(image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np)[None,]

            return image_tensor
        except Exception as exc:
            LOGGER.warning("Failed to load Template Reference image %r: %s", image_path, exc)
            return None

    @staticmethod
    def _placeholder_image():
        image = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        return image


class PromptTemplate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_template_json": (
                    "STRING",
                    {
                        "default": '{"version":1,"items":[]}',
                        "multiline": True,
                        "tooltip": "Serialized prompt template blocks edited by the custom UI.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("selected_prompt", "prompt", "template_json")
    FUNCTION = "build_prompt"
    CATEGORY = "template_reference"
    DESCRIPTION = "Outputs the prompt text from the template selected in the custom UI."

    def build_prompt(self, prompt_template_json):
        items = self._parse_items(prompt_template_json)
        selected_template_id = self._selected_id(prompt_template_json)
        list_hidden = self._list_hidden(prompt_template_json)
        selected_prompt = ""

        if items and selected_template_id:
            selected = next((item for item in items if str(item.get("id") or "") == str(selected_template_id or "")), None)
            if selected is not None:
                selected_prompt = str(selected.get("text") or "")

        normalized_json = json.dumps(
            {"version": 1, "selected_id": selected_template_id, "list_hidden": list_hidden, "items": items},
            ensure_ascii=False,
        )
        return (selected_prompt, selected_prompt, normalized_json)

    @classmethod
    def IS_CHANGED(cls, prompt_template_json):
        hasher = hashlib.sha256()
        hasher.update(str(prompt_template_json).encode("utf-8", errors="replace"))
        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, prompt_template_json):
        try:
            payload = json.loads(prompt_template_json or "{}")
        except (json.JSONDecodeError, TypeError):
            return "prompt_template_json is not valid JSON."
        if not isinstance(payload, dict):
            return "prompt_template_json must be a JSON object."
        return True

    @staticmethod
    def _selected_id(prompt_template_json, fallback=""):
        return _parse_selected_id(prompt_template_json, fallback)

    @staticmethod
    def _list_hidden(prompt_template_json):
        return _parse_list_hidden(prompt_template_json)

    @staticmethod
    def _parse_items(prompt_template_json):
        return PromptTemplate._parse_prompt_items(prompt_template_json, include_lora=False)

    @staticmethod
    def _parse_prompt_items(prompt_template_json, include_lora=False):
        try:
            payload = json.loads(prompt_template_json or "{}")
        except Exception:
            return []

        raw_items = payload.get("items", payload) if isinstance(payload, dict) else payload
        if not isinstance(raw_items, list):
            return []

        items = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue

            try:
                text_height = int(raw.get("text_height") or 82)
            except (TypeError, ValueError):
                text_height = 82

            image = raw.get("image") if isinstance(raw.get("image"), dict) else {}
            try:
                preview_height = int(image.get("preview_height") or 138)
            except (TypeError, ValueError):
                preview_height = 138
            item = {
                "id": str(raw.get("id") or ""),
                "type": "text",
                "title": str(raw.get("title") or ""),
                "text": str(raw.get("text") or ""),
                "text_height": text_height,
                "collapsed": bool(raw.get("collapsed")),
                "image_collapsed": bool(raw.get("image_collapsed", True)),
                "image": {
                    "name": str(image.get("name") or ""),
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "input"),
                    "path": str(image.get("path") or ""),
                    "preview_height": preview_height,
                    "storage": str(image.get("storage") or ""),
                    "template": str(image.get("template") or image.get("template_name") or ""),
                    "template_name": str(image.get("template_name") or image.get("template") or ""),
                },
            }
            if include_lora:
                lora = raw.get("lora") if isinstance(raw.get("lora"), dict) else {}
                try:
                    lora_strength = float(lora.get("strength", 1.0))
                except (TypeError, ValueError):
                    lora_strength = 1.0
                item["lora_collapsed"] = bool(raw.get("lora_collapsed", True))
                item["lora"] = {
                    "name": str(lora.get("name") or ""),
                    "strength": lora_strength,
                }
            items.append(item)

        return items


class PromptTemplateLoRA(PromptTemplate):
    @staticmethod
    def _parse_items(prompt_template_json):
        return PromptTemplate._parse_prompt_items(prompt_template_json, include_lora=True)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "Model to apply the selected prompt block LoRA to."}),
                "clip": ("CLIP", {"tooltip": "CLIP to apply the selected prompt block LoRA to."}),
                "prompt_template_json": (
                    "STRING",
                    {
                        "default": '{"version":1,"items":[]}',
                        "multiline": True,
                        "tooltip": "Serialized prompt template blocks edited by the custom UI.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("selected_prompt", "prompt", "lora_model", "lora_clip", "template_json")
    FUNCTION = "build_prompt_lora"
    CATEGORY = "template_reference"
    DESCRIPTION = "Outputs selected prompt text and applies that block's LoRA to model/clip."

    def build_prompt_lora(self, model, clip, prompt_template_json):
        items = self._parse_items(prompt_template_json)
        selected_template_id = self._selected_id(prompt_template_json)
        list_hidden = self._list_hidden(prompt_template_json)
        selected_prompt = ""
        lora_model = model
        lora_clip = clip

        if items and selected_template_id:
            selected = next((item for item in items if str(item.get("id") or "") == str(selected_template_id or "")), None)
            if selected is not None:
                selected_prompt = str(selected.get("text") or "")
                lora_model, lora_clip = self._apply_lora(model, clip, selected)

        normalized_json = json.dumps(
            {"version": 1, "selected_id": selected_template_id, "list_hidden": list_hidden, "items": items},
            ensure_ascii=False,
        )
        return (selected_prompt, selected_prompt, lora_model, lora_clip, normalized_json)

    @classmethod
    def IS_CHANGED(cls, model, clip, prompt_template_json):
        hasher = hashlib.sha256()
        hasher.update(str(prompt_template_json).encode("utf-8", errors="replace"))
        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, model, clip, prompt_template_json):
        return PromptTemplate.VALIDATE_INPUTS(prompt_template_json)

    @staticmethod
    def _apply_lora(model, clip, item):
        global _LOADED_LORA_CACHE
        lora = item.get("lora") if isinstance(item.get("lora"), dict) else {}
        lora_name = str(lora.get("name") or "")
        try:
            strength = float(lora.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0

        if not lora_name or strength == 0:
            return model, clip

        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        except Exception as exc:
            LOGGER.warning("Prompt Template LoRA not found %r: %s", lora_name, exc)
            return model, clip
        loaded_lora = None
        lora_metadata = None
        if _LOADED_LORA_CACHE is not None:
            if _LOADED_LORA_CACHE[0] == lora_path:
                loaded_lora = _LOADED_LORA_CACHE[1]
                lora_metadata = _LOADED_LORA_CACHE[2] if len(_LOADED_LORA_CACHE) > 2 else None
            else:
                _LOADED_LORA_CACHE = None

        if loaded_lora is None:
            loaded_lora, lora_metadata = comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)
            _LOADED_LORA_CACHE = (lora_path, loaded_lora, lora_metadata)

        return comfy.sd.load_lora_for_models(model, clip, loaded_lora, strength, strength, lora_metadata=lora_metadata)


NODE_CLASS_MAPPINGS = {
    "TemplateReference": TemplateReference,
    "PromptTemplate": PromptTemplate,
    "PromptTemplateLoRA": PromptTemplateLoRA,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TemplateReference": "Template Reference",
    "PromptTemplate": "Prompt Template",
    "PromptTemplateLoRA": "Prompt Template LoRA",
}
