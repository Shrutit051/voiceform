/**
 * content.js
 *
 * Runs in every page. Listens continuously for voice commands via the
 * browser's SpeechRecognition API, parses them, acts on the page's form
 * fields, and speaks a confirmation through the local VoiceForm backend
 * (which calls Rime TTS). Implements barge-in / interruption handling via
 * the shared VoiceFormCore.SpeechQueue.
 *
 * Also supports starting/stopping listening via custom user-configured
 * key bindings (set in the popup), so control never depends on precisely
 * clicking the extension icon — important for users with limited hand
 * mobility, including those using single-key assistive switch devices.
 */

(function () {
  const BACKEND_URL = 'http://localhost:3000';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let recognition = null;
  let listening = false;
  let lastFocusedField = null;
  let currentAudioEl = null;
  let usingFallbackTTS = false;
  let bindings = [];

  // Load any saved button bindings on page load, and keep them fresh if
  // the user edits them from the popup while this page is open.
  chrome.storage.sync.get('voiceformBindings', (stored) => {
    bindings = stored.voiceformBindings || [];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.voiceformBindings) {
      bindings = changes.voiceformBindings.newValue || [];
    }
  });

  document.addEventListener(
    'focusin',
    (e) => {
      if (isFillable(e.target)) lastFocusedField = e.target;
    },
    true
  );

  // ---------------------------------------------------------------------
  // TTS via backend (Rime), with browser SpeechSynthesis fallback.
  // Fallback use is always surfaced to the popup so it's never silent.
  // ---------------------------------------------------------------------
  async function synthesize(text, signal) {
    try {
      const res = await fetch(`${BACKEND_URL}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) throw new Error(`backend responded ${res.status}`);
      usingFallbackTTS = false;
      notifyPopup({ type: 'provider', provider: 'rime' });
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Visible, disclosed fallback — required by the hackathon rules.
      usingFallbackTTS = true;
      notifyPopup({ type: 'provider', provider: 'browser-fallback', reason: String(err.message || err) });
      return { fallbackText: text };
    }
  }

  function playAudio(audio) {
    if (audio && audio.fallbackText) {
      const utter = new SpeechSynthesisUtterance(audio.fallbackText);
      window.speechSynthesis.speak(utter);
      return;
    }
    const el = new Audio(audio);
    currentAudioEl = el;
    el.play().catch(() => {});
  }

  function stopAudio() {
    if (currentAudioEl) {
      currentAudioEl.pause();
      currentAudioEl.currentTime = 0;
      currentAudioEl = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  const speechQueue = new window.VoiceFormCore.SpeechQueue({
    synthesize,
    playAudio,
    stopAudio,
  });

  function say(text) {
    notifyPopup({ type: 'transcript-confirm', text });
    return speechQueue.speak(text);
  }

  // ---------------------------------------------------------------------
  // Field discovery & matching
  // ---------------------------------------------------------------------
  function isFillable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'submit', 'reset', 'hidden', 'file', 'image'].includes(type);
    }
    return false;
  }

  function allFillableFields() {
    return Array.from(document.querySelectorAll('input, textarea, select')).filter(isFillable);
  }

  function labelFor(el) {
    const parts = [];
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.textContent);
    }
    const parentLabel = el.closest('label');
    if (parentLabel) parts.push(parentLabel.textContent);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (el.getAttribute('placeholder')) parts.push(el.getAttribute('placeholder'));
    if (el.getAttribute('name')) parts.push(el.getAttribute('name'));
    return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function findFieldByLabel(spokenLabel) {
    const needle = spokenLabel.trim().toLowerCase();
    if (!needle) return null;
    let best = null;
    let bestScore = 0;
    for (const el of allFillableFields()) {
      const hay = labelFor(el);
      if (!hay) continue;
      let score = 0;
      if (hay === needle) score = 100;
      else if (hay.includes(needle) || needle.includes(hay)) score = 60;
      else {
        const needleWords = needle.split(' ');
        const overlap = needleWords.filter((w) => w.length > 2 && hay.includes(w)).length;
        score = overlap * 10;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function setFieldValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    lastFocusedField = el;
  }

  function focusNextField(reverse) {
    const fields = allFillableFields();
    if (fields.length === 0) return null;
    const idx = fields.indexOf(document.activeElement);
    let nextIdx;
    if (idx === -1) nextIdx = 0;
    else nextIdx = reverse ? (idx - 1 + fields.length) % fields.length : (idx + 1) % fields.length;
    fields[nextIdx].focus();
    lastFocusedField = fields[nextIdx];
    return fields[nextIdx];
  }

  function selectOptionByText(select, wanted) {
    const needle = wanted.trim().toLowerCase();
    const options = Array.from(select.options);
    const match =
      options.find((o) => o.textContent.trim().toLowerCase() === needle) ||
      options.find((o) => o.textContent.trim().toLowerCase().includes(needle));
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ---------------------------------------------------------------------
  // Command parsing
  // ---------------------------------------------------------------------
  function normalize(t) {
    return t.trim().replace(/\s+/g, ' ');
  }

  async function handleCommand(rawText) {
    const text = normalize(rawText);
    const lower = text.toLowerCase();
    notifyPopup({ type: 'transcript', text });

    // "tab" / "next field"
    if (/^(tab|next( field)?)$/.test(lower)) {
      const f = focusNextField(false);
      await say(f ? `Moved to ${labelFor(f) || 'next field'}.` : 'No more fields.');
      return;
    }
    // "previous field" / "shift tab" / "back"
    if (/^(previous( field)?|shift tab|back)$/.test(lower)) {
      const f = focusNextField(true);
      await say(f ? `Moved to ${labelFor(f) || 'previous field'}.` : 'No previous field.');
      return;
    }
    // "select all plus delete" / "clear field" / "clear this"
    if (/^(select all plus delete|clear( the)?( field| this)?|delete( field)?)$/.test(lower)) {
      const target = isFillable(document.activeElement) ? document.activeElement : lastFocusedField;
      if (target) {
        setFieldValue(target, '');
        await say('Field cleared.');
      } else {
        await say('No field selected.');
      }
      return;
    }
    // "check the terms box" / "uncheck newsletter"
    let m = lower.match(/^(check|uncheck) (?:the )?(.+?)(?: box| checkbox)?$/);
    if (m) {
      const [, action, label] = m;
      const target = findFieldByLabel(label);
      if (target && target.type === 'checkbox') {
        target.checked = action === 'check';
        target.dispatchEvent(new Event('change', { bubbles: true }));
        await say(`${label} ${action === 'check' ? 'checked' : 'unchecked'}.`);
      } else {
        await say(`Couldn't find a checkbox for ${label}.`);
      }
      return;
    }
    // "select the united states" / "choose united states for country"
    m = lower.match(/^select (?:the )?(.+)$/);
    if (m) {
      const wanted = m[1];
      const target = isFillable(document.activeElement) && document.activeElement.tagName === 'SELECT'
        ? document.activeElement
        : Array.from(allFillableFields()).find((f) => f.tagName === 'SELECT');
      if (target && selectOptionByText(target, wanted)) {
        await say(`Selected ${wanted}.`);
      } else {
        await say(`Couldn't find option ${wanted}.`);
      }
      return;
    }
    // "<label> is <value>"  e.g. "Name is Shruti", "Email is test@email.com"
    m = text.match(/^(.+?)\s+is\s+(.+)$/i);
    if (m) {
      const [, label, value] = m;
      const target = findFieldByLabel(label) || (isFillable(document.activeElement) ? document.activeElement : null);
      if (target) {
        setFieldValue(target, value.trim());
        await say(`${label.trim()} filled.`);
      } else {
        await say(`Couldn't find a field called ${label.trim()}.`);
      }
      return;
    }

    // Fallback: if a field is focused, dictate the raw text into it.
    if (isFillable(document.activeElement)) {
      setFieldValue(document.activeElement, text);
      await say('Filled.');
      return;
    }

    await say("Sorry, I didn't catch a command.");
  }

  // ---------------------------------------------------------------------
  // Speech recognition
  // ---------------------------------------------------------------------
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      notifyPopup({ type: 'error', text: 'SpeechRecognition not supported in this browser.' });
      return;
    }
    if (listening) return;
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          // Barge-in point: a new final transcript arrived. handleCommand()
          // -> say() -> speechQueue.speak() will immediately stop/abort
          // whatever was playing/in-flight before processing this one.
          handleCommand(result[0].transcript);
        } else {
          notifyPopup({ type: 'interim', text: result[0].transcript });
        }
      }
    };
    recognition.onerror = (e) => notifyPopup({ type: 'error', text: e.error });
    recognition.onend = () => {
      // Auto-restart to keep "continuous" listening resilient to browser
      // timeouts, unless the user explicitly stopped it.
      if (listening) {
        try {
          recognition.start();
        } catch (_) {}
      }
    };

    recognition.start();
    listening = true;
    notifyPopup({ type: 'status', listening: true });
    say('Voice form on.');
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    if (recognition) recognition.stop();
    notifyPopup({ type: 'status', listening: false });
    say('Voice form off.');
  }

  // ---------------------------------------------------------------------
  // Custom button bindings — start/stop without touching the popup
  // ---------------------------------------------------------------------
  function matchesBinding(e, b) {
    return (
      e.code === b.code &&
      e.ctrlKey === !!b.ctrlKey &&
      e.altKey === !!b.altKey &&
      e.shiftKey === !!b.shiftKey &&
      e.metaKey === !!b.metaKey
    );
  }

  document.addEventListener(
    'keydown',
    (e) => {
      for (const b of bindings) {
        if (matchesBinding(e, b)) {
          e.preventDefault();
          e.stopPropagation();
          if (b.action === 'start') startListening();
          else if (b.action === 'stop') stopListening();
          else (listening ? stopListening() : startListening());
          return;
        }
      }
    },
    true
  );

  // ---------------------------------------------------------------------
  // Messaging with popup
  // ---------------------------------------------------------------------
  function notifyPopup(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) {
      // popup may not be open — that's fine
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start') startListening();
    if (msg.type === 'stop') stopListening();
    if (msg.type === 'bindings-updated') bindings = msg.bindings || [];
    if (msg.type === 'get-status') sendResponse({ listening, usingFallbackTTS });
    return true;
  });
})();