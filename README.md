# VoiceForm

A Chrome extension that lets you fill out any web form hands-free by voice —
built for the DataForge × Pathway × Rime Hackathon.

> "Name is Shruti." "Email is test at email dot com." "Tab." "Select all
> plus delete." "Name is Shruti — no wait, Shreya." VoiceForm hears the
> correction, stops mid-sentence, and fills in the right value — never both.

## 1. Target user & problem

People filling out repetitive online forms (applications, competition
entries, official documents) who want a faster, hands-free alternative to
typing field by field. Speech is not decoration here: the entire input
method *is* voice — remove it and there is no product, just an empty form.

## 2. How it works

1. You speak a command. The extension's content script (Chrome
   `SpeechRecognition`) transcribes it locally in the browser.
2. The command is parsed and applied directly to the page's DOM — filling a
   field, moving focus, clearing a field, checking a box, or picking a
   dropdown option.
3. VoiceForm speaks a short confirmation ("Name filled.") through **Rime**,
   fetched from a small local backend that holds the Rime API key.
4. If you start talking again before that confirmation finishes, VoiceForm
   is listening. It kills the audio immediately and processes your new
   command — see [RIME_EVIDENCE.md](./RIME_EVIDENCE.md) for the exact
   claim and how it's proven.

### Supported commands & field types

| Say | Effect | Field Type |
|---|---|---|
| `"<field label> is <value>"` (e.g. `"Name is Shruti"`, `"Email is a@b.com"`) | Finds the field by its label/placeholder/name and fills it | Text, Email, Tel, Number |
| `"Country is India"` / `"Select India"` | Picks an option in the dropdown | `<select>` Dropdown |
| `"Plan is Pro"` / `"Select Enterprise"` | Selects a radio button in a radio group | Radio Buttons |
| `"Check the terms"` / `"Agree to terms"` / `"Uncheck newsletter"` | Toggles a checkbox by its label | Checkbox |
| `"Date is today"` / `"Date is 2026-09-15"` | Sets the date picker | Date (`type="date"`) |
| `"Rating is 90"` / `"Age is 24"` | Sets range sliders and numeric fields | Range & Number |
| `"Theme color is blue"` | Sets color picker hex | Color (`type="color"`) |
| `"tab"` / `"next field"` | Moves focus to the next fillable field | Navigation |
| `"previous field"` / `"shift tab"` | Moves focus back one field | Navigation |
| `"select all plus delete"` / `"clear field"` | Clears the focused field | Editing |
| `"submit form"` / `"click submit"` | Submits the active form | Submission |
| anything else, while a field is focused | Dictated verbatim into that field | Textarea / Input |

### Built-in Keyboard Shortcuts
* **`Alt + V`**: Toggle VoiceForm listening on/off from anywhere on the page.
* **`Esc`**: Stop listening / dismiss active audio.
* **Custom buttons**: Map any keyboard key or assistive switch in the popup menu.

## 3. Architecture

```
┌─────────────────────────┐        ┌────────────────────────┐        ┌──────────┐
│  Chrome Extension        │  HTTP  │  VoiceForm backend       │  HTTPS │   Rime    │
│  (content.js, popup)     │───────▶│  (server/server.js)      │───────▶│  TTS API  │
│  • In-page prompt UI     │        │   • Gemini / Groq LLM    │        │           │
│  • SpeechRecognition     │        │     Form Agent brain     │◀───────│           │
│  • DOM Schema & Batch Fill◀───────│   • holds RIME_API_KEY   │ audio  │           │
│  • SpeechQueue (barge-in)│ actions│   • streams audio back   │ stream │           │
└─────────────────────────┘ & audio └────────────────────────┘        └──────────┘
```

- **Frontend (browser extension, MV3).** `extension/content.js` runs on
  every page: form detection, in-page floating assistant, speech recognition,
  DOM schema extraction, multi-field batch DOM updates across all HTML5 input types,
  and playback of Rime audio via an `<audio>` element.
  `extension/voiceform-core.js` holds the interruption/fencing state
  machine (`SpeechQueue`) — shared, dependency-free logic also used by the
  Node test.
- **Backend (`server/`).** A secure Express server. It hosts the **LLM Form Agent**
  (`POST /parse-and-act`) which takes natural, multi-field conversational speech
  and extracts structured DOM actions, plus `POST /speak` which streams Rime TTS
  audio directly to the extension.
- **Rime's role.** The sole spoken-output engine. Every confirmation the
  user hears comes from Rime; there is no product-generated speech.

## 4. Rime integration (exact configuration)

| | |
|---|---|
| **Endpoint** | `POST https://users.rime.ai/v1/rime-tts` |
| **Transport** | HTTP streaming (bytes streamed to the client as Rime generates them, not buffered) |
| **Model ID** | `mistv3` (Mist v3 — Rime's speed-optimized model) |
| **Speaker** | `cove` |
| **Language** | `en` |
| **Audio format** | `audio/mpeg` (MP3) — sent via the `Accept` header, broadest `<audio>` compatibility |
| **Auth** | `Authorization: Bearer <RIME_API_KEY>`, server-side only (`server/.env`) |

**Why Mist v3:** VoiceForm's spoken output is short, frequent UI
confirmations, not long-form narration — perceived response time matters
more than expressive delivery here, and Mist v3 is Rime's model tuned for
that. If you want more natural-sounding confirmations and can afford the
extra latency, switch `RIME_MODEL_ID` to `coda` in `.env` — the backend
already reads it from an env var so no code changes are needed.

Before your demo, re-verify `speaker`/`modelId`/`lang` against
[Rime's live model, voice, and language catalog](https://docs.rime.ai/docs/models) —
per the hackathon rules, the shipped combination must be the one tested,
not a stale copy.

## 5. Setup

### Backend

```bash
cd server
npm install
cp .env.example .env
# edit .env and set RIME_API_KEY (get one at https://app.rime.ai/tokens)
npm start
# -> VoiceForm backend listening on http://localhost:3000
```

Check it's wired up correctly:

```bash
curl http://localhost:3000/health
```

### Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open any page with a form, click the VoiceForm icon, and press
   **Start listening**.
5. Chrome will prompt for microphone access on that site the first time —
   allow it.

## 6. Proving the hard voice claim (no mic needed)

```bash
cd server
npm test
```

This runs `server/test/interruption.test.js`, which exercises the exact
`SpeechQueue` class the extension uses, with controlled timing, and prints
`PASS` plus a timestamped event log. Full acceptance-test writeup:
[RIME_EVIDENCE.md](./RIME_EVIDENCE.md).

## 7. Known limitations & failure behavior

- **Browser support:** relies on Chrome's `webkitSpeechRecognition`; not
  tested in Firefox/Safari.
- **Language:** English only in this build (`lang: "en"`); the architecture
  supports switching `RIME_LANG`/recognition `lang`, but multilingual
  routing was not a chosen hard-voice track here.
- **Microphone permission is per-origin.** Some sites (or sites embedding
  cross-origin iframes with a restrictive `Permissions-Policy`) may block
  mic access even after the user grants it once.
- **Backend must be running locally.** If `localhost:3000` is unreachable,
  VoiceForm **falls back to the browser's built-in `speechSynthesis`** for
  confirmations rather than going silent — and the popup visibly flags this
  as "Browser fallback" so the active provider is never ambiguous. This is
  disclosed fallback behavior, not silent degradation; Rime remains the
  default path in the judged flow.
- **Field matching is label/placeholder/name based**, not full NLU — forms
  with no labels, placeholders, `aria-label`, or `name` attributes on a
  field can't be targeted by name (dictation into the currently focused
  field still works).
- **500-character text limit per Rime API request** (confirmations are
  short, so this is not hit in normal use; the backend clips defensively).

## 8. Security

- `RIME_API_KEY` lives only in `server/.env` (gitignored) and is read
  server-side. It is never sent to, or embedded in, the extension.
- No credentials appear in this README, screenshots, or the demo recording
  — only placeholders in `.env.example`.
