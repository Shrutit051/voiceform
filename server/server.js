/**
 * VoiceForm backend
 *
 * A thin, secure middleman between the browser extension and Rime's TTS
 * API. The Rime API key never reaches the browser — it lives only in this
 * process's environment (see .env.example).
 *
 * Model choice: Mist v3 (`modelId: "mistv3"`), speaker `"cove"`, English.
 * Mist v3 is Rime's speed-optimized model — appropriate here because
 * VoiceForm's spoken output is short, frequent UI confirmations
 * ("Name filled.", "Moved to email.") where perceived latency matters
 * more than expressive delivery. Swap to `modelId: "coda"` for more
 * natural/expressive confirmations if latency budget allows — see README.
 *
 * Endpoint:  POST https://users.rime.ai/v1/rime-tts
 * Transport: HTTP streaming (audio bytes stream back as they're generated)
 * Audio format: audio/mpeg (MP3) — broadest <audio> element compatibility
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const RIME_API_KEY = process.env.RIME_API_KEY;
const RIME_ENDPOINT = 'https://users.rime.ai/v1/rime-tts';
const RIME_MODEL_ID = process.env.RIME_MODEL_ID || 'mistv3';
const RIME_SPEAKER = process.env.RIME_SPEAKER || 'cove';
const RIME_LANG = process.env.RIME_LANG || 'en';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    rimeConfigured: Boolean(RIME_API_KEY),
    model: RIME_MODEL_ID,
    speaker: RIME_SPEAKER,
    lang: RIME_LANG,
    endpoint: RIME_ENDPOINT,
    transport: 'http-streaming',
    audioFormat: 'audio/mpeg',
  });
});

app.post('/speak', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text (string) is required' });
  }
  if (!RIME_API_KEY) {
    return res.status(500).json({ error: 'RIME_API_KEY is not configured on the server' });
  }
  // Rime's per-request character limit via the API is 500 for these models.
  const clipped = text.slice(0, 480);

  const upstreamController = new AbortController();
  let isTimedOut = false;
  let isClientDisconnected = false;

  // If the client disconnects/aborts early (e.g. barge-in in extension),
  // stop paying for/streaming Rime audio we'll never play.
  res.on('close', () => {
    if (!res.writableEnded) {
      isClientDisconnected = true;
      upstreamController.abort();
    }
  });

  // Hard timeout: if Rime (or something in between — proxy/AV SSL
  // inspection is a known culprit on some Windows setups, especially with
  // streamed/chunked responses) never responds, fail loudly instead of
  // hanging the request forever.
  const RIME_TIMEOUT_MS = 15000;
  const timeoutId = setTimeout(() => {
    isTimedOut = true;
    console.error(`[VoiceForm] /speak: aborting — no response from Rime after ${RIME_TIMEOUT_MS}ms`);
    upstreamController.abort();
  }, RIME_TIMEOUT_MS);

  const startedAt = Date.now();
  console.log(`[VoiceForm] /speak: requesting Rime ("${clipped.slice(0, 40)}${clipped.length > 40 ? '…' : ''}")`);

  try {
    const rimeRes = await fetch(RIME_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RIME_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clipped,
        modelId: RIME_MODEL_ID,
        speaker: RIME_SPEAKER,
        lang: RIME_LANG,
        samplingRate: 22050,
        speedAlpha: 1.0,
      }),
      signal: upstreamController.signal,
    });
    console.log(`[VoiceForm] /speak: Rime responded ${rimeRes.status} after ${Date.now() - startedAt}ms`);

    if (!rimeRes.ok || !rimeRes.body) {
      const detail = await rimeRes.text().catch(() => '');
      console.error(`[VoiceForm] /speak: Rime error ${rimeRes.status}: ${detail}`);
      return res.status(502).json({ error: 'Rime TTS request failed', status: rimeRes.status, detail });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Speech-Provider', 'rime');
    res.setHeader('X-Rime-Model', RIME_MODEL_ID);

    // Stream bytes through as they arrive rather than buffering the whole
    // clip — this is what makes "first audible response" latency low.
    const reader = rimeRes.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      res.write(Buffer.from(value));
    }
    console.log(`[VoiceForm] /speak: streamed ${bytes} bytes in ${Date.now() - startedAt}ms total`);
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      const elapsed = Date.now() - startedAt;
      if (isClientDisconnected) {
        console.log(`[VoiceForm] /speak: client disconnected after ${elapsed}ms`);
        return;
      }
      if (isTimedOut) {
        console.error(`[VoiceForm] /speak: aborted after ${elapsed}ms (timeout)`);
        if (!res.headersSent) {
          res.status(504).json({ error: `No response from Rime within ${RIME_TIMEOUT_MS}ms — check network/AV/proxy SSL inspection.` });
        }
        return;
      }
      console.error(`[VoiceForm] /speak: aborted after ${elapsed}ms`);
      if (!res.headersSent) {
        res.status(499).json({ error: 'Client closed request' });
      }
      return;
    }
    console.error('[VoiceForm] /speak error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error contacting Rime', detail: String(err.message || err) });
    }
  } finally {
    clearTimeout(timeoutId);
  }
});

app.listen(PORT, () => {
  console.log(`[VoiceForm] backend listening on http://localhost:${PORT}`);
  console.log(`[VoiceForm] Rime model=${RIME_MODEL_ID} speaker=${RIME_SPEAKER} lang=${RIME_LANG}`);
  if (!RIME_API_KEY) {
    console.warn('[VoiceForm] WARNING: RIME_API_KEY not set — /speak will fail until it is configured in .env');
  }
});