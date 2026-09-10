/**
 * VoiceForm backend
 *
 * A thin, secure middleman between the browser extension, Rime's TTS API,
 * and the LLM Form Agent brain. The Rime and LLM API keys never reach the browser
 * — they live only in this process's environment (see .env.example).
 *
 * Model choice: Mist v3 (`modelId: "mistv3"`), speaker `"cove"`, English.
 * Mist v3 is Rime's speed-optimized model — appropriate here because
 * VoiceForm's spoken output is short, frequent UI confirmations
 * ("Name filled.", "Moved to email.") where perceived latency matters
 * more than expressive delivery. Swap to `modelId: "coda"` for more
 * natural/expressive confirmations if latency budget allows — see README.
 *
 * Endpoints:
 *   - GET  /health          -> Server status & Rime configuration
 *   - POST /speak           -> Streams Rime TTS audio for spoken text
 *   - POST /parse-and-act   -> LLM Form Agent: extracts multi-field actions & confirmations
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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    rimeConfigured: Boolean(RIME_API_KEY),
    llmConfigured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY || GROQ_API_KEY),
    llmProvider: GEMINI_API_KEY ? 'gemini-2.0-flash' : GROQ_API_KEY ? 'groq-llama-3.3' : OPENAI_API_KEY ? 'openai-gpt4o-mini' : 'local-heuristic',
    model: RIME_MODEL_ID,
    speaker: RIME_SPEAKER,
    lang: RIME_LANG,
    endpoint: RIME_ENDPOINT,
    transport: 'http-streaming',
    audioFormat: 'audio/mpeg',
  });
});

// ---------------------------------------------------------------------
// LLM Form Agent Logic: Extracts multi-field intent from transcript
// ---------------------------------------------------------------------
function parseWithHeuristics(transcript, schema) {
  const actions = [];
  const filledLabels = [];
  const text = transcript.trim();

  // Split on clause separators: commas, " and ", " then ", " also ", " with ", " my "
  const clauses = text
    .split(/[,;\.]+|\s+(?:and|then|also|with)\s+|\s+(?=my\s+)/i)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const lower = clause.toLowerCase();

    // Check against each field in the schema
    for (const field of schema) {
      if (actions.some((a) => a.id === field.id && a.id !== '')) continue;

      const fieldLabel = (field.label || field.name || field.id || '').toLowerCase();
      const fieldName = (field.name || '').toLowerCase();
      const cleanLabel = fieldLabel.replace(/^(my|the|a|an)\s+/i, '').replace(/\s+\(.*?\)/g, '').trim();

      // Check if clause targets this field
      const matchesLabel =
        (cleanLabel.length > 2 && lower.includes(cleanLabel)) ||
        (fieldName.length > 2 && lower.includes(fieldName));

      // 1. Email field
      if (field.type === 'email' && (matchesLabel || /@|\bemail\b|\bat\b.*?\bdot\b/i.test(lower))) {
        let emailVal = lower.replace(/^.*?\b(?:is|to|email(?:\s+address)?|as)\s+/i, '');
        emailVal = emailVal.replace(/\s+at\s+/gi, '@').replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
        if (emailVal.includes('@')) {
          actions.push({ id: field.id || field.name, value: emailVal, label: field.label || 'Email' });
          filledLabels.push('email');
          break;
        }
      }

      // 2. Select / Dropdown
      if (field.type === 'select' && (matchesLabel || /\b(?:country|state|select|choose|pick)\b/i.test(lower))) {
        let matchOpt = null;
        if (Array.isArray(field.options)) {
          for (const opt of field.options) {
            if (opt && lower.includes(opt.toLowerCase())) {
              matchOpt = opt;
              break;
            }
          }
        }
        if (matchOpt) {
          actions.push({ id: field.id || field.name, value: matchOpt, label: field.label || 'Country' });
          filledLabels.push(cleanLabel || 'country');
          break;
        }
      }

      // 3. Radio buttons
      if (field.type === 'radio' && (matchesLabel || /\b(?:plan|gender|tier|subscription)\b/i.test(lower))) {
        let val = lower.replace(/^.*?\b(?:is|to|set|choose|select)\s+/i, '').trim();
        if (val) {
          actions.push({ id: field.id || field.name, value: val, label: field.label || 'Option' });
          filledLabels.push(field.name || 'plan');
          break;
        }
      }

      // 4. Checkbox
      if (field.type === 'checkbox' && (matchesLabel || /\b(?:terms|newsletter|agree|subscribe|check|uncheck)\b/i.test(lower))) {
        const isUncheck = /\b(?:uncheck|no|false|off|untick|remove)\b/i.test(lower);
        actions.push({ id: field.id || field.name, value: isUncheck ? 'uncheck' : 'check', label: field.label || 'Terms' });
        filledLabels.push(cleanLabel || 'checkbox');
        break;
      }

      // 5. Standard text / number / tel / date fields
      if (matchesLabel) {
        let val = clause.replace(/^.*?\b(?:is|to|set|put|enter)\s+/i, '').trim();
        if (!val || val === clause) {
          val = clause.replace(new RegExp(`^.*?\\b${cleanLabel}\\b\\s*(?:is|to|:)?\\s*`, 'i'), '').trim();
        }
        if (val && val !== clause) {
          actions.push({ id: field.id || field.name, value: val, label: field.label || cleanLabel });
          filledLabels.push(cleanLabel || 'field');
          break;
        }
      }
    }
  }

  // Build confirmation
  let confirmation = 'Filled form.';
  if (filledLabels.length > 0) {
    const unique = Array.from(new Set(filledLabels));
    if (unique.length === 1) confirmation = `Filled ${unique[0]}.`;
    else if (unique.length === 2) confirmation = `Filled ${unique[0]} and ${unique[1]}.`;
    else confirmation = `Filled ${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}.`;
  }

  return { actions, confirmation };
}

async function parseWithLLM(transcript, schema) {
  const systemInstruction = `You are VoiceForm AI, an intelligent agent that parses spoken conversational commands and extracts structured values for web form fields.
Analyze the user's spoken transcript and the available form schema on the webpage.
Guidelines:
1. Extract EVERY field mentioned in the transcript.
2. Handle self-corrections (e.g., "my name is John no wait Jonathan" -> use "Jonathan").
3. For select dropdowns, identify the exact matching option text from the field's options list.
4. For radio buttons, identify the correct option value or label for that radio group.
5. For checkboxes, set value to "check" or "uncheck".
6. Generate a short, natural, concise confirmation (3 to 8 words) for Rime TTS (e.g. "Filled name, email, and selected India.").
Return ONLY valid JSON:
{
  "actions": [
    { "id": "<field_id_or_name>", "value": "<value_to_set>", "label": "<field_label>" }
  ],
  "confirmation": "<short confirmation>"
}`;

  const prompt = `Available Form Fields on Page:\n${JSON.stringify(schema, null, 2)}\n\nUser Spoken Transcript:\n"${transcript}"`;

  // 1. Google Gemini (Gemini 2.0 Flash / 1.5 Flash)
  if (GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${systemInstruction}\n\n${prompt}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
            return parsed;
          }
        }
      }
    } catch (e) {
      console.warn('[VoiceForm] Gemini API error, falling back:', e.message);
    }
  }

  // 2. Groq / OpenAI
  const openaiKey = GROQ_API_KEY || OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const isGroq = Boolean(GROQ_API_KEY);
      const endpoint = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
            return parsed;
          }
        }
      }
    } catch (e) {
      console.warn('[VoiceForm] OpenAI/Groq API error, falling back:', e.message);
    }
  }

  // 3. Fallback: Intelligent Heuristic Multi-Field Rule Extractor
  return parseWithHeuristics(transcript, schema);
}

app.post('/parse-and-act', async (req, res) => {
  const { transcript, schema } = req.body || {};
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'transcript (string) is required' });
  }

  try {
    const startedAt = Date.now();
    const result = await parseWithLLM(transcript, schema || []);
    console.log(`[VoiceForm] /parse-and-act: parsed in ${Date.now() - startedAt}ms ->`, result);
    res.json(result);
  } catch (err) {
    console.error('[VoiceForm] /parse-and-act error:', err);
    const fallback = parseWithHeuristics(transcript, schema || []);
    res.json(fallback);
  }
});

// ---------------------------------------------------------------------
// Rime TTS Streaming Endpoint
// ---------------------------------------------------------------------
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

  // Hard timeout
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

    // Stream bytes through as they arrive
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
  const llmStatus = GEMINI_API_KEY ? 'Gemini 2.0 Flash' : GROQ_API_KEY ? 'Groq LLaMA 3.3' : OPENAI_API_KEY ? 'OpenAI GPT-4o' : 'Local Heuristic Engine';
  console.log(`[VoiceForm] Agent Brain=${llmStatus}`);
  if (!RIME_API_KEY) {
    console.warn('[VoiceForm] WARNING: RIME_API_KEY not set — /speak will fail until it is configured in .env');
  }
});