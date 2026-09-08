/**
 * voiceform-core.js
 *
 * Pure, environment-agnostic logic for the "Interruption & Recovery" hard
 * voice problem. This file has NO DOM / chrome.* / fetch dependencies of
 * its own — the caller injects `synthesize`, `playAudio`, and `stopAudio`,
 * which makes the fencing logic unit-testable under plain Node (see
 * server/test/interruption.test.js) as well as usable inside the content
 * script running in the browser.
 *
 * The problem being solved:
 *   1. User says "Name is Jonathan" -> we call Rime TTS to confirm.
 *   2. While that audio is still being synthesized / still playing, the
 *      user barges in and says "Name is John" (a correction).
 *   3. The old audio must stop IMMEDIATELY (interruption).
 *   4. If the old synthesis request is still in flight and resolves later,
 *      its audio must never be played — it is stale (fencing/recovery).
 *   5. The final spoken output and the final form value must match what
 *      the user most recently said, never a mix of the two.
 */

class SpeechQueue {
  /**
   * @param {Object} deps
   * @param {(text: string, signal: AbortSignal) => Promise<any>} deps.synthesize
   *        Resolves with an audio payload (Blob/Buffer/whatever playAudio expects).
   *        Must respect the AbortSignal and reject with an error whose
   *        `.name === 'AbortError'` when aborted.
   * @param {(audio: any) => void} deps.playAudio
   * @param {() => void} deps.stopAudio
   *        Must be safe to call even when nothing is playing.
   */
  constructor({ synthesize, playAudio, stopAudio }) {
    this.synthesize = synthesize;
    this.playAudio = playAudio;
    this.stopAudio = stopAudio;
    this.requestId = 0;
    this.controller = null;
    /** @type {Array<{event: string, id: number, text: string, t: number}>} */
    this.log = [];
  }

  _record(event, id, text) {
    this.log.push({ event, id, text, t: Date.now() });
  }

  /**
   * Speak `text`. Any currently-playing audio is stopped and any in-flight
   * synthesis request is aborted BEFORE the new request starts, so barge-in
   * is immediate regardless of network/synthesis latency.
   *
   * @returns {Promise<{status: 'played'|'aborted'|'fenced', id: number}>}
   */
  async speak(text) {
    this.requestId += 1;
    const myId = this.requestId;
    this._record('start', myId, text);

    // 1. Interrupt: stop local playback and cancel the previous in-flight
    //    request right away, before doing anything else.
    if (this.controller) {
      this.controller.abort();
    }
    this.stopAudio();

    this.controller = new AbortController();
    const mySignal = this.controller.signal;

    let audio;
    try {
      audio = await this.synthesize(text, mySignal);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this._record('aborted', myId, text);
        return { status: 'aborted', id: myId };
      }
      this._record('error', myId, text);
      throw err;
    }

    // 2. Recovery/fencing: even if synthesis succeeded, a NEWER command may
    //    have started while we were waiting. If so, this result is stale —
    //    never play it, and never let it overwrite state a newer command
    //    already set.
    if (myId !== this.requestId) {
      this._record('fenced', myId, text);
      return { status: 'fenced', id: myId };
    }

    this.playAudio(audio);
    this._record('played', myId, text);
    return { status: 'played', id: myId };
  }
}

// Support both `require()` (Node test harness) and plain <script>/content-script
// global usage (browser) from the same file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SpeechQueue };
}
if (typeof window !== 'undefined') {
  window.VoiceFormCore = { SpeechQueue };
}
