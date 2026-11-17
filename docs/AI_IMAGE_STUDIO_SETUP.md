# AI Product Image Studio — API setup (phase 1)

This branch adds a first backend adapter for two-provider image work:

- Vision analysis: Qwen through the Alibaba Cloud Model Studio OpenAI-compatible chat completions endpoint.
- Image editing/generation: Wan 2.7 Image Pro through the China (Beijing) workspace-specific Model Studio endpoint.

## Render environment variables

Configure these on the Render service (never place keys in frontend code):

- `DASHSCOPE_API_KEY`: Alibaba Cloud Model Studio API key for China (Beijing).
- `BAILIAN_WORKSPACE_ID`: Model Studio workspace ID for the same Beijing region.
- `BAILIAN_VISION_MODEL`: optional vision model ID; defaults to `qwen-vl-max`. Set this to a vision-capable model enabled in the workspace.
- `WAN_IMAGE_MODEL`: optional image model ID; defaults to `wan2.7-image-pro`.

The Beijing API key and workspace endpoint must belong to the same region. Singapore credentials/endpoints are not interchangeable.

## API

All endpoints inherit the application's existing authentication and same-origin protections.

- `GET /api/ai-image-studio/status`: reports provider configuration presence and selected model IDs; never returns secrets.
- `POST /api/ai-image-studio/analyze`: body `{ "productHint": "...", "images": [{ "image": "data:image/jpeg;base64,...", "role": "product-reference" }] }`. Accepts 1–9 image URLs or data URLs and returns a JSON product-visual analysis.
- `POST /api/ai-image-studio/generate`: body `{ "prompt": "...", "size": "2K", "images": [{ "image": "data:image/jpeg;base64,...", "role": "hero" }] }`. Accepts 1–9 image URLs or data URLs and returns the Wan output URL(s).

## Important limitations in this first backend slice

- The endpoints are adapters, not yet the complete Product Image Studio workflow.
- The current generate endpoint intentionally requests one image per call. The UI/task queue should preview one image first, then schedule only approved image jobs.
- Wan result URLs are temporary. A later asset-persistence step must download the result immediately and save it through the existing product image storage service before marking the job complete.
- 1688 page crawling, image deduplication/contact sheets, durable task records, quality review, retries, and frontend UI are not implemented by this commit.
- Do not treat AI-inferred material/specification as verified product facts. Keep unknowns explicitly unknown.
- Model IDs are configurable because regional availability and model naming can change.

## Smoke test

1. Set the environment variables on a non-production/staging deployment.
2. Call `GET /api/ai-image-studio/status` and verify both providers show configured.
3. Send 1–3 representative product reference images to `POST /api/ai-image-studio/analyze`.
4. Inspect the JSON for fabricated material, structure, colors, or accessories before using it.
5. Send one test prompt to `POST /api/ai-image-studio/generate`.
6. Download the returned URL promptly for manual inspection; do not use it as a permanent asset URL.
