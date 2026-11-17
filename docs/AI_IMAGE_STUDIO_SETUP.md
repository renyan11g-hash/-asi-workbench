# ASI Workbench — Qwen Vision + Wan 2.7 setup

The image engine reuses the existing product-image workflow, task handling, product image history, visual style references and DB-backed image storage.

## Configure the vision model (Qwen)

In **Settings → AI API → Independent vision model (Qwen)** configure:

- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Model: `qwen-vl-max` (or another vision-capable model enabled for your account)
- API Key: Alibaba Cloud Model Studio API key for China (Beijing)

The vision provider is independent from the general text provider. It is used by generated-image QA to compare product silhouette, color, structure, accessories, scene plausibility, background and image quality. The Settings test sends a tiny image to verify multimodal input, not just text connectivity.

## Configure the image generation model (Wan 2.7)

In **Settings → Image Generation** configure:

- Base URL: `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`
- API Key: Alibaba Cloud Model Studio API key for China (Beijing)
- Model: `wan2.7-image-pro`
- Image size: `2K` for quality-first reference editing.

Replace `{WorkspaceId}` with the Workspace ID from the Model Studio console. The API key and workspace endpoint must belong to the same region. Do not use a Singapore key with the Beijing endpoint.

## What the integration does

- Existing 1688 image collection and local mirroring remain unchanged.
- Existing product-image prompts, fidelity guardrails, style references, image review and image history remain in use.
- Wan uses the official Beijing multimodal-generation endpoint and accepts up to 9 ordered image references.
- Wan output URLs are downloaded immediately into a Buffer; the existing image pipeline then persists the result in `image_blobs` and `product_images`.
- Seedream and OpenAI-compatible image providers remain available by changing the existing image settings.
- Qwen handles both the automatic product-photo identification step (`image-identify`) and generated-image QA (`image-review`) when the dedicated vision key is configured. It does not require changing the general text model.

## Known limits / rollout checks

- 1688 crawling can still fail on login, dynamic-loading or anti-bot restrictions. Existing collection errors must remain visible; do not pretend all images were collected.
- Vision QA is a filter, not a guarantee. Human approval is still required for exact logo, colorways, tiny components and hidden construction.
- The first test should use one existing product with several supplier images. Generate one image, inspect it, then run the complete shot set.
- Keep the existing per-image task history and cost controls. Do not automatically regenerate every failed image without a bounded retry budget.

## Smoke test

1. Configure Qwen vision URL, model and key; run **Test vision model connection**.
2. Configure Wan URL, key and model; run the existing **Test image connection**.
3. Generate one main image for a product with clear source photos.
4. Confirm the result appears in the product gallery and is stored in the DB-backed image storage.
5. Confirm the QA report checks product/color/structure/accessories and records a useful failure note when the image differs.
