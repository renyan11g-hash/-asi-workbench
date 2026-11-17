# ASI Workbench — Wan 2.7 + Qwen vision setup

The image engine is integrated into the existing product-image pipeline. Do not create a second image storage or task system.

## Configure in Workbench Settings

### Vision model (Qwen)
Use the existing **AI model for structured extraction** setting (`aiModelExtract`) for the visual QA task. Set it to a vision-capable Alibaba Cloud Model Studio model available to your Beijing workspace, for example `qwen-vl-max`.

The normal text model (`aiModel`) remains available for other text tasks. Image review is routed to `aiModelExtract`.

### Image model (Wan 2.7)
In **Settings → Image Generation**, configure:

- Base URL: `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`
- API Key: your Alibaba Cloud Model Studio **China (Beijing)** API key
- Model: `wan2.7-image-pro`
- Image size: `2K` for quality-first reference editing (image sets/editing support up to 2K; 4K applies to text-to-image only).

Replace `{WorkspaceId}` with the Workspace ID from the Model Studio console. The API key and workspace endpoint must belong to the same region. Do not use a Singapore key with the Beijing endpoint.

## What the code now does

- Existing source image collection and local mirroring remain unchanged.
- Existing product image prompts, product-fidelity guardrails, visual style references and image review remain in use.
- Wan requests use the official Beijing multimodal-generation endpoint.
- Up to 9 product/style reference images are normalized and sent in their existing order.
- The generated result URL is downloaded immediately to a Buffer; the existing product-image pipeline then persists the image in `image_blobs` and the product image history.
- Existing Seedream and OpenAI-compatible image providers remain available by changing the current image settings.
- Image review uses `aiModelExtract` when configured, so a vision-capable Qwen model can serve as the specialist reviewer without replacing the normal text model.

## Important limitations

- This integration does not make 1688 crawling immune to login, dynamic loading, or anti-bot restrictions. Existing collection errors must remain visible rather than pretending all images were collected.
- Model-based visual QA is a filter, not a guarantee. Product images still need human approval, especially for logo, exact colorways, small parts and hidden construction.
- The first test should use one existing product with several supplier images. Generate one image, inspect it, then run the full shot set.
- Do not automatically regenerate every failed image without a user-visible retry budget. Reuse the existing task manager and cost logging where available.

## Smoke test

1. Set the Qwen vision model in the structured-extraction model field.
2. Set the Wan endpoint, API key and model in Image Generation settings.
3. Use the existing image connection test.
4. Generate one main image for a product with clear source photos.
5. Confirm the output appears in the product image gallery and survives a service restart/redeploy (DB-backed image storage).
6. Confirm the image review record identifies the Qwen model and checks product/color/structure/accessories.
