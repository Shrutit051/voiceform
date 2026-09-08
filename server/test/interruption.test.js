/**
 * Repeatable acceptance test for the "Interruption & Recovery" hard voice
 * claim in RIME_EVIDENCE.md.
 *
 * This does NOT need a microphone, a browser, or a live Rime key. It loads
 * the exact same SpeechQueue class the extension uses (extension/voiceform-core.js)
 * and drives it with a fake `synthesize` function whose timing we control,
 * so the fencing behavior is deterministic and repeatable in CI.
 *
 * Run:  node test/interruption.test.js   (or: npm test)
 * Exit code 0 = PASS, 1 = FAIL.
 */

const assert = require('node:assert');
const path = require('node:path');
const { SpeechQueue } = require(path.join(__dirname, '..', '..', 'extension', 'voiceform-core.js'));

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function run() {
  const played = [];
  const stopCalls = [];

  // Fake "Rime": "Jonathan" takes 200ms to synthesize (slow / not-yet-arrived
  // audio), "John" takes 50ms (the correction that should win).
  const timings = { Jonathan: 200, John: 50 };

  const queue = new SpeechQueue({
    synthesize: async (text, signal) => {
      const ms = timings[text] ?? 50;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(`audio:${text}`), ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
    playAudio: (audio) => played.push(audio),
    stopAudio: () => stopCalls.push(Date.now()),
  });

  // --- Scenario: normal interaction -------------------------------------
  const normalResult = await queue.speak('Field cleared.');
  assert.strictEqual(normalResult.status, 'played', 'normal utterance should play');
  assert.deepStrictEqual(played, ['audio:Field cleared.']);

  // --- Scenario: deliberate stress case — barge-in mid-synthesis --------
  played.length = 0;
  stopCalls.length = 0;

  const first = queue.speak('Jonathan'); // starts a 200ms synthesis
  await delay(50); // user barges in before it resolves
  const second = queue.speak('John'); // should abort/fence the first

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.strictEqual(
    firstResult.status,
    'aborted',
    `stale "Jonathan" request should be aborted before it plays, got: ${firstResult.status}`
  );
  assert.strictEqual(secondResult.status, 'played', '"John" (the correction) should play');
  assert.deepStrictEqual(played, ['audio:John'], 'only the corrected utterance should ever reach playback');
  assert.ok(stopCalls.length >= 1, 'stopAudio() must be called to cut off in-progress playback on barge-in');

  // --- Scenario: fencing when abort loses the race but resolve wins ------
  // (Covers implementations where the old promise still resolves instead of
  // rejecting — the queue must still refuse to play/report it as fenced.)
  played.length = 0;
  const q2 = new SpeechQueue({
    synthesize: async (text) => {
      const ms = text === 'stale' ? 100 : 10;
      return delay(ms, `audio:${text}`); // never rejects, even after "abort"
    },
    playAudio: (audio) => played.push(audio),
    stopAudio: () => {},
  });
  const p1 = q2.speak('stale');
  await delay(20);
  const p2 = q2.speak('fresh');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.status, 'fenced', 'a stale result that resolves late must be fenced, not played');
  assert.strictEqual(r2.status, 'played');
  assert.deepStrictEqual(played, ['audio:fresh'], 'fenced audio must never reach playAudio()');

  console.log('PASS: interruption + fencing acceptance test (3/3 scenarios)');
  console.log(JSON.stringify(queue.log, null, 2));
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
