# ComfyUI Template Reference

[English](./README.md) / [日本語](./README_ja.md)

ComfyUI Template Reference adds two custom nodes for building reusable text, image, and prompt-template libraries directly inside ComfyUI.

## Features

- Create editable text reference blocks.
- Upload and preview image reference blocks.
- Save and open template libraries as JSON files.
- Select a specific block from an Output dropdown.
- Output the selected text or image to other ComfyUI nodes.
- Reorder blocks by dragging them.
- Collapse, expand, resize, copy, and delete blocks from the node UI.
- Store user-created data in ComfyUI's user directory instead of the extension install folder.

## Nodes

### Template Reference

![Template Reference Node](./image/image1.png)

Use this node to collect mixed text and image references.

Outputs:

- `select_text`: Text from the selected text block.
- `select_image`: Image from the selected image block.
- `template_json`: Full serialized node state.

Main controls:

- `Open` / `Save`: Load or save the Template Reference JSON library.
- `Output`: Select the block to send to the output.
- `List Off` / `List On`: Turn each block off or on.
- `Hide All` / `Show All`: Hide or show all blocks.
- `Add Textbox`: Add a text reference block.
- `Add LoadImage`: Add an image reference block.
- `Hide` / `Show`: Hide or show the selected block.
- `Copy`: Copy the contents of the textbox to the clipboard.
- `Fit`: Adjust the block to fit the size of its text or image.
- `Delete`: Delete the block.
- `Upload`: Upload a reference image.

### Prompt Template

![Prompt Template Node](./image/image2.png)

Use this node to collect reusable prompt templates.

Outputs:

- `selected_prompt`: Text from the selected prompt block.
- `prompt`: Same selected prompt text, provided as a convenience output.
- `template_json`: Full serialized node state.

Main controls:

- `Open` / `Save`: Load or save the Prompt Template JSON library.
- `none`: Output an empty prompt.
- `Output`: Select the template to send to the text output.
- `List Off` / `List On`: Turn each block off or on.
- `Hide All` / `Show All`: Hide or show all blocks.
- `Add Template`: Add a prompt template block.
- `Hide` / `Show`: Hide or show the selected block.
- `Image`: Show or hide the optional reference image area for each prompt block.
- `Copy`: Copy the contents of the prompt textbox to the clipboard.
- `Fit`: Adjust the block to fit the size of its text or reference image.
- `Delete`: Delete the block.
- `Upload`: Upload a reference image.

## Installation

Clone this repository into your ComfyUI `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Tsubasa109/ComfyUI-TemplateReference.git
```

Restart ComfyUI after installation.

## Storage Location

The extension automatically creates local storage folders under ComfyUI's user directory:

```text
ComfyUI/user/template_reference/prompt_templates/
ComfyUI/user/template_reference/prompt_templates/images/
ComfyUI/user/template_reference/reference_templates/
ComfyUI/user/template_reference/reference_templates/image/
```

These folders contain user-created JSON libraries and copied reference images.


## Notes

- Reference images are not embedded into JSON files. The JSON stores image metadata and the extension copies uploaded images into its storage folders.
- If a saved image cannot be found, the node keeps the workflow running and returns a small placeholder image while logging a warning.
- Runtime storage folders are ignored by Git and should not be committed to the repository.

## File Format

- All JSON template files are saved as **UTF-8 without BOM**.
- Non-ASCII characters (including Japanese) are stored as-is in the JSON, not as escape sequences.
- When opening saved JSON files in an external editor, make sure the editor is set to UTF-8 encoding.

## Requirements

- ComfyUI

## License

Apache License 2.0 (see LICENSE)

