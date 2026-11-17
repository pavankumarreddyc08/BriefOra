# Briefora

**Every document. Clearer understanding.**

Briefora is a local-first document workspace with a React/Vite client and an Express API. It stores uploaded files and extracted text in the server workspace, uses document-specific keyword retrieval for question answering, and supports OpenRouter for summaries and answers plus Sarvam AI for content translation.

## Run locally

Requires Node.js 20+ (tested with 24.21.0) and npm. SQLite uses the portable sql.js SQLite engine; database updates are persisted to the configured local database file.

1. Copy `server/.env.example` to `server/.env` and configure provider keys as needed. Do not put secrets in the client.
2. From the project root run `npm install` to install the root, client, and server workspaces.
3. Run `npm run dev`. The client is at http://localhost:5173 and API at http://localhost:5000/api/health.
4. Run `npm test` for server tests and `npm run build` for the production client build.

`OPENROUTER_API_KEY` and `OPENROUTER_MODEL` enable AI features. Choose a text-generation model from [OpenRouter's model directory](https://openrouter.ai/models). `OPENROUTER_FALLBACK_MODELS` is an optional comma-separated list of exact model IDs, tried in order after the primary only for rate limits, model unavailability, temporary provider errors, or connection failures. Briefora makes at most one request per configured model per completion; authentication, quota, and malformed-request errors stop immediately. Free models may have limits. `SARVAM_API_KEY` enables translation. Translation and model usage may incur separate charges. Without keys, upload, extraction, history, deletion and preview still work; AI requests return a setup error.

Example fallback configuration (replace IDs if you choose different models):

```dotenv
OPENROUTER_MODEL=liquid/lfm-2.5-2.6b:free
OPENROUTER_FALLBACK_MODELS=google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3.5-lightning:free,qwen/qwen3.8-27b:free
```

## Implemented features

- Upload and local persistence for PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML, JSON and RTF. Current text extraction is implemented for PDF, DOCX, XLSX, PPTX and text-like formats. Legacy XLS is not supported. PPTX extraction reads slide text; charts and embedded media are not extracted.
- Per-document chunking and keyword retrieval; every chat request searches only the selected document. The generator is skipped when no lexical evidence is retrieved. Responses include actual retrieved excerpts and only source locations present in extraction metadata.
- Short/detailed summaries, study notes, key takeaways, definitions and section summaries using OpenRouter. Summaries are cached by document, type and language.
- Sarvam translation for English, Hindi, Telugu, Kannada and Tamil, including sentence-aware request chunking, bounded retries, in-flight de-duplication and successful-result caching. Chat has independent question, document and answer language controls; cross-language question text is translated before retrieval.
- Localized interface strings, per-document answer language, conversation persistence, document deletion and DOCX/PDF/plain text export.
- API validation, upload size limits, rate limiting, Helmet, restricted CORS, safe API error messages and provider secrets kept server-side.

## API

`GET /api/health`, `GET /api/settings/languages`, `POST /api/documents/upload`, `GET /api/documents`, `GET /api/documents/:id`, `GET /api/documents/:id/content`, `DELETE /api/documents/:id`, `POST /api/documents/:id/summarize`, `POST /api/documents/:id/chat`, `GET|DELETE /api/documents/:id/chat-history`, `POST /api/documents/:id/translate`, `POST /api/documents/:id/export`, and `POST /api/ai/test`.

## Limitations and privacy

This MVP targets local or trusted development use. It has no authentication or per-user authorization and should not be exposed publicly before adding authentication, tenant isolation and production access controls. Uploaded documents remain local; when AI is enabled, document text or retrieved excerpts are sent to OpenRouter, and translation text is sent to Sarvam under the policies and account terms of those providers. Scanned PDF/image OCR is not enabled in this build, and image uploads are not accepted. PDF extraction uses the older `pdf-parse` parser to preserve compatibility with the Node 18 npm runtime; unusual cross-reference layouts may fail extraction and will return an error. PDF export uses standard PDF fonts; Indian script font embedding is not yet bundled. Retrieval is keyword-based, so paraphrases with no overlapping terms can return insufficient evidence. Citation source excerpts are real retrieved chunks; page, slide and sheet labels are attached when available, with XLSX row and cell references included in excerpts. Export currently covers generated summaries; exporting selected chat answers and collected notes is not yet available. History reopens documents and chat, while cached summaries are regenerated from cache through the Summary action.
