# RIME_EVIDENCE.md

## Hard voice claim

**Track: Interruption & Recovery.**

> When the user barges in with a correction while a Rime confirmation is
> still synthesizing or playing, VoiceForm (1) stops the currently playing
> audio immediately, (2) cancels the in-flight Rime request for the
> superseded utterance, (3) fences any late-arriving audio for that
> superseded utterance so it can never be played, and (4) leaves the form
> field and the spoken confirmation in a state that matches only the most
> recent thing the user said — never a mix of the old and new command.

Removing this handling would make the product materially worse: without
it, a user correcting "Jonathan" to "John" would hear both confirmations
overlap or in the wrong order, and — if a slower request resolved after a
faster one — could even have a stale value silently overwrite a
correction the user already made.

## Acceptance test

Defined before the demo, exercised two ways: (A) a deterministic,
mic-free unit test against the exact production `SpeechQueue` class, and
(B) a live, mic-in-the-loop procedure for the recorded demo.

### A. Repeatable automated test (primary evidence)

**Command:** `cd server && npm test`
(directly: `node server/test/interruption.test.js`)

**What it does:** Loads `extension/voiceform-core.js` — the identical
`SpeechQueue` class `content.js` uses in the browser — and drives it with a
fake Rime call whose latency we control, so timing is deterministic instead
of dependent on network conditions.

**Scenarios and results (last run, included verbatim):**

```
PASS: interruption + fencing acceptance test (3/3 scenarios)
[
  { "event": "start",   "id": 1, "text": "Field cleared." },
  { "event": "played",  "id": 1, "text": "Field cleared." },
  { "event": "start",   "id": 2, "text": "Jonathan" },
  { "event": "start",   "id": 3, "text": "John" },
  { "event": "aborted", "id": 2, "text": "Jonathan" },
  { "event": "played",  "id": 3, "text": "John" }
]
```

1. **Normal case:** a single utterance is spoken and played — sanity check
   that the queue doesn't interfere with ordinary confirmations.
2. **Stress case (the hard voice problem):** `speak("Jonathan")` starts a
   200ms synthesis. 50ms later, before it resolves, `speak("John")` is
   called (simulating the user correcting themselves mid-confirmation).
   **Result:** the "Jonathan" request is aborted (never played), `stopAudio()`
   is invoked to cut off anything already sounding, and only `"John"`
   reaches `playAudio()`.
3. **Race-condition fencing:** the same scenario but with a fake backend
   that *doesn't* reject on abort (it resolves late anyway, simulating a
   network response that arrives after cancellation was requested).
   **Result:** the stale "stale" audio is marked `fenced` and never reaches
   `playAudio()`, proving the guard doesn't depend on `fetch` abort
   semantics alone — it double-checks a request ID before every play.

Exit code `0` = pass. The script is deterministic (fake timers, not real
network), so it's safe to run in CI on every change.

### B. Live procedure (used in the recorded demo)

1. Start the backend (`npm start` in `server/`) and load the unpacked
   extension.
2. Open a page with a "Full name" text field, click **Start listening**.
3. Say **"Name is Jonathan."** — Rime begins speaking "Name filled."
4. Before that confirmation finishes (~1s in), say **"Name is John."**
5. **Expected / observed:** the "Jonathan" confirmation audio cuts off
   immediately (no fade, no queueing behind it); a fresh Rime confirmation
   for "John" plays; the field's final value is `John`, not `Jonathan` and
   not `JonathanJohn`; the popup transcript log shows both commands with
   only the second producing an audible confirmation.

## Limitations disclosed

- The automated test proves the *queue/fencing logic* deterministically; it
  does not exercise real network jitter against Rime's live endpoint. The
  live procedure (B) is the check against real conditions, as required.
- Barge-in detection depends on Chrome's `SpeechRecognition` producing a
  new **final** result while a confirmation is in flight; very short
  corrections that the browser only ever reports as `interim` (never
  finalized) will not trigger a barge-in until finalized.
- If the backend is down, VoiceForm falls back to `window.speechSynthesis`
  for confirmations (disclosed in the popup as "Browser fallback"). The
  interruption/fencing logic still applies identically in that path, since
  `stopAudio()` also calls `speechSynthesis.cancel()`.
