# Personal Chat Superpower

**English** · [繁體中文](README.zh-TW.md)

[![Tests](https://github.com/iks9245/personal-chat-superpower/actions/workflows/test.yml/badge.svg)](https://github.com/iks9245/personal-chat-superpower/actions/workflows/test.yml) [![Latest release](https://img.shields.io/github/v/release/iks9245/personal-chat-superpower)](https://github.com/iks9245/personal-chat-superpower/releases/latest) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A local-first Chrome extension that turns your ChatGPT and Claude history into a personal knowledge base — organized, searchable, summarized by **your own local LLM**, and exportable to **Obsidian**. No servers, no tracking, no accounts.

> **Unofficial project, not affiliated with OpenAI or Anthropic.** It reads the undocumented web APIs of chatgpt.com and claude.ai, which can change or break at any time. Programmatic access may conflict with those services' terms of use — evaluate the risk for your own account before using it. Provided as-is under the MIT license.

## Why

Chat apps are great at answering and bad at remembering. Your best thinking ends up scattered across hundreds of conversations on two platforms, titled by the first message you typed. This extension keeps that history on your machine, makes it findable by meaning, and turns it into Markdown you own.

## Features

**Organize (ChatGPT + Claude, shared)**
- Folders, tags and pins across both platforms; prompt library with `{{variables}}`, inserted from the side panel or by typing `//` (or Cmd/Ctrl+Shift+P) in the chat box.
- Better titles: your local LLM proposes "Topic: key point" titles from summaries; review before applying, optionally sync them back to the site.
- Export conversations as Markdown or JSON.

**Find**
- Keyword search uses each site's own server-side search (one request per query).
- **Semantic search** over a local vector index (e.g. Qwen3-Embedding) — works across platforms and offline.

**Understand (local LLM via any OpenAI-compatible server, tested with oMLX)**
- Streaming **summaries** rendered as Markdown.
- **Ask your history**: grounded Q&A over your summaries and saved conversations, with clickable `[n]` citations. It says "not enough information" instead of guessing.
- **Weekly review**: every Monday, a digest of what you discussed, key conclusions, open questions and recurring ideas compared with previous weeks.
- Optional, very slow **background summary backfill** for pinned/filed conversations (≤ 1 conversation per minute, 20/day by default, stops for the day on any rate limit).

**Own your data**
- **Obsidian export**: one note per conversation (YAML frontmatter, tags, aliases, source link), folders as subfolders, an index note and weekly reviews. Incremental, and **never overwrites notes you edited in Obsidian**.
- Backup/restore of folders, tags, prompts and settings (API keys excluded).

**Built to survive site changes**
- Settings → Diagnostics runs read-only checks (≤ 4 requests) and points to the exact file/function that broke; the copyable report contains no titles, IDs or keys.

## Privacy

- All data stays in your browser (IndexedDB / `chrome.storage.local`).
- Network requests go only to `chatgpt.com`, `claude.ai`, and the local LLM endpoint you configure — which must be `127.0.0.1` / `localhost`.
- No analytics, no remote code, no third-party services. Your LLM API key never leaves `chrome.storage.local` and is excluded from backups.
- Deliberately request-light: syncing fetches titles only; message bodies are downloaded only when you export, summarize, or enable the slow backfill.

## Install

1. Download the latest `personal-chat-superpower-<version>.zip` from [Releases](https://github.com/iks9245/personal-chat-superpower/releases/latest) and unzip it (or clone this repository).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped (or cloned) folder.
3. Open chatgpt.com or claude.ai and click the extension icon to open the side panel. Press **Sync** to load your conversation titles.

### Optional: local LLM

1. Run an OpenAI-compatible server locally (tested: [oMLX](https://github.com/jundot/omlx) on Apple Silicon; Ollama and LM Studio expose the same API but are untested).
2. Settings → Local LLM: base URL (e.g. `http://127.0.0.1:11123/v1`), API key if your server requires one, **Test connection**, then pick a chat model and an embedding model.
3. Settings → Local LLM → **Build / update semantic index**.

Tested models: `Qwen3.6-35B-A3B-4bit` worked well for summaries, titles and grounded answers; a 9B model produced noticeably weaker structured output. `Qwen3-Embedding-0.6B` for embeddings.

### Optional: Obsidian

Settings → Export to Obsidian → choose your vault folder → **Export / update**. Notes go to `<vault>/AI 對話/` by default (configurable).

## Development

Plain JavaScript (classic scripts), no build step, no runtime dependencies.

```
manifest.json
src/shared/       platform-independent logic (storage, search, RAG, markdown, vault, digest…)
src/content/      content scripts and per-site adapters (chatgpt.js, claude.js)
src/background/   service worker (alarms, background backfill)
src/sidepanel/    side panel UI, split by feature
tests/            node --test suites with fake Chrome/DOM/IndexedDB
```

```bash
npm test
```

All site-specific assumptions live in `src/content/adapters/<site>.js`. When a site changes, run Diagnostics first — it names the function to fix. `SPEC.md` (Traditional Chinese) documents the contracts in detail.

Found a bug? Run Settings → Diagnostics, copy the report and [open an issue](https://github.com/iks9245/personal-chat-superpower/issues/new/choose) — the report contains no titles, IDs or keys.

Contributions are welcome — especially adapters for other platforms (Gemini), testing with other local LLM servers, and English UI polish. Please keep the core principles: local-first, no third-party requests, request-light, and no `innerHTML`.

## License

[MIT](LICENSE)
