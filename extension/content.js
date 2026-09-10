/**
 * content.js
 *
 * Runs in every page. Listens continuously for voice commands via the
 * browser's SpeechRecognition API, parses them, acts on the page's form
 * fields (all HTML input types: text, email, tel, number, radio, select,
 * date, time, range, color, checkbox, textarea), and speaks a confirmation
 * through the local VoiceForm backend (which calls Rime TTS). Implements
 * barge-in / interruption handling via the shared VoiceFormCore.SpeechQueue.
 *
 * Also includes an in-page floating VoiceForm assistant prompt that automatically
 * detects forms on the page and offers a one-click "Fill with VoiceForm" experience.
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
  const DEFAULT_BINDINGS = [
    { id: 'default-toggle', action: 'toggle', code: 'KeyV', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false },
    { id: 'default-stop', action: 'stop', code: 'Escape', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false },
  ];

  let bindings = [...DEFAULT_BINDINGS];
  let widgetState = 'hidden'; // 'prompt' | 'active' | 'minimized' | 'hidden'
  let isDismissed = false;
  let currentTranscript = '';
  let lastConfirmation = '';

  // Load any saved button bindings on page load
  chrome.storage.sync.get('voiceformBindings', (stored) => {
    if (stored.voiceformBindings && Array.isArray(stored.voiceformBindings) && stored.voiceformBindings.length > 0) {
      bindings = stored.voiceformBindings;
    } else {
      bindings = [...DEFAULT_BINDINGS];
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.voiceformBindings) {
      const val = changes.voiceformBindings.newValue;
      bindings = val && val.length > 0 ? val : [...DEFAULT_BINDINGS];
    }
  });

  document.addEventListener(
    'focusin',
    (e) => {
      if (isFillable(e.target)) {
        lastFocusedField = e.target;
        if (!isDismissed && widgetState === 'hidden' && !listening) {
          showInPagePrompt();
        }
      }
    },
    true
  );

  // ---------------------------------------------------------------------
  // TTS via backend (Rime), with browser SpeechSynthesis fallback
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
      updateWidgetProvider('rime');
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      usingFallbackTTS = true;
      notifyPopup({ type: 'provider', provider: 'browser-fallback', reason: String(err.message || err) });
      updateWidgetProvider('browser-fallback');
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
    el.play().catch(() => { });
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
    lastConfirmation = text;
    notifyPopup({ type: 'transcript-confirm', text });
    updateWidgetTranscript();
    return speechQueue.speak(text);
  }

  // ---------------------------------------------------------------------
  // Field discovery & matching
  // ---------------------------------------------------------------------
  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
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
    if (!el) return '';
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

    // If it's a radio in a fieldset, include the fieldset legend
    if (el.type === 'radio' || el.type === 'checkbox') {
      const fieldset = el.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) parts.push(legend.textContent);
      }
      // Also check previous text or wrapper container label
      const container = el.closest('.form-group, .radio-group, div');
      if (container) {
        const prevLabel = container.querySelector('.field-label, label:not([for])');
        if (prevLabel && !parentLabel) parts.push(prevLabel.textContent);
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function cleanLabelNeedle(str) {
    return str
      .trim()
      .toLowerCase()
      .replace(/^(my|the|a|an|please|set|select|choose|check|uncheck)\s+/gi, '')
      .replace(/\s+(field|input|box|dropdown|picker|option)$/gi, '')
      .trim();
  }

  function findFieldByLabel(spokenLabel) {
    const rawNeedle = spokenLabel.trim().toLowerCase();
    const needle = cleanLabelNeedle(rawNeedle);
    if (!needle) return null;

    let best = null;
    let bestScore = 0;

    for (const el of allFillableFields()) {
      const hay = labelFor(el);
      if (!hay) continue;

      let score = 0;
      if (hay === needle || hay === rawNeedle) {
        score = 100;
      } else if (hay.startsWith(needle) || needle.startsWith(hay)) {
        score = 80;
      } else if (hay.includes(needle) || needle.includes(hay)) {
        score = 60;
      } else {
        const needleWords = needle.split(/\s+/);
        const overlap = needleWords.filter((w) => w.length > 2 && hay.includes(w)).length;
        score = overlap * 15;
      }

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return bestScore >= 15 ? best : null;
  }

  // ---------------------------------------------------------------------
  // Value formatting helpers (Speech to field types)
  // ---------------------------------------------------------------------
  function formatEmail(text) {
    return text
      .toLowerCase()
      .replace(/\s+at\s+/gi, '@')
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s*@\s*/g, '@')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s+/g, '')
      .trim();
  }

  function formatPhone(text) {
    return text
      .replace(/\bplus\b/gi, '+')
      .replace(/[^\d+\-\s()]/g, '')
      .trim();
  }

  const WORD_TO_NUM = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90, hundred: 100
  };

  function parseNumber(text) {
    const directNum = text.match(/-?\d+(\.\d+)?/);
    if (directNum) return directNum[0];
    const words = text.toLowerCase().split(/\s+/);
    let total = 0;
    let found = false;
    for (const w of words) {
      if (WORD_TO_NUM[w] !== undefined) {
        total += WORD_TO_NUM[w];
        found = true;
      }
    }
    return found ? String(total) : text;
  }

  const COLOR_MAP = {
    red: '#ef4444', blue: '#3b82f6', green: '#10b981', yellow: '#eab308', purple: '#a855f7',
    orange: '#f97316', pink: '#ec4899', black: '#000000', white: '#ffffff', gray: '#6b7280',
    cyan: '#06b6d4', sky: '#0ea5e9', indigo: '#6366f1', teal: '#14b8a6'
  };

  function parseColor(text) {
    const clean = text.toLowerCase().trim();
    if (COLOR_MAP[clean]) return COLOR_MAP[clean];
    if (/^#[0-9a-f]{3,6}$/i.test(clean)) return clean;
    return clean;
  }

  function parseDate(text) {
    const clean = text.toLowerCase().trim();
    const now = new Date();
    if (clean === 'today') {
      return now.toISOString().split('T')[0];
    }
    if (clean === 'tomorrow') {
      const tomorrow = new Date(Date.now() + 86400000);
      return tomorrow.toISOString().split('T')[0];
    }
    if (clean === 'yesterday') {
      const yesterday = new Date(Date.now() - 86400000);
      return yesterday.toISOString().split('T')[0];
    }
    const d = new Date(text);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    return text;
  }

  // ---------------------------------------------------------------------
  // Universal Smart Field Setter (Handles Select, Radio, Checkbox, Inputs)
  // ---------------------------------------------------------------------
  function smartSetFieldValue(target, rawValue, spokenLabelName) {
    if (!target) return { ok: false, msg: "No target field found." };

    const tag = target.tagName;
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    const displayName = spokenLabelName || labelFor(target) || target.name || target.id || 'Field';

    // 1. SELECT (Dropdown)
    if (tag === 'SELECT') {
      const needle = rawValue.trim().toLowerCase();
      const options = Array.from(target.options);
      const match =
        options.find((o) => o.textContent.trim().toLowerCase() === needle) ||
        options.find((o) => o.value.trim().toLowerCase() === needle) ||
        options.find((o) => o.textContent.trim().toLowerCase().includes(needle)) ||
        options.find((o) => needle.includes(o.textContent.trim().toLowerCase()));

      if (match) {
        target.value = match.value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.focus();
        lastFocusedField = target;
        return { ok: true, msg: `Selected ${match.textContent.trim()} for ${displayName}.` };
      }
      return { ok: false, msg: `Couldn't find option ${rawValue} in ${displayName}.` };
    }

    // 2. CHECKBOX
    if (type === 'checkbox') {
      const lower = rawValue.toLowerCase();
      const isUncheck = /^(uncheck|no|false|off|remove|unchecked|disable|0)$/.test(lower);
      target.checked = !isUncheck;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
      lastFocusedField = target;
      return { ok: true, msg: `${displayName} ${target.checked ? 'checked' : 'unchecked'}.` };
    }

    // 3. RADIO GROUP
    if (type === 'radio') {
      const groupName = target.name;
      if (groupName) {
        const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`));
        const needle = rawValue.trim().toLowerCase();
        const match =
          radios.find((r) => r.value.toLowerCase() === needle) ||
          radios.find((r) => labelFor(r).toLowerCase().includes(needle)) ||
          radios.find((r) => needle.includes(r.value.toLowerCase()));

        if (match) {
          match.checked = true;
          match.dispatchEvent(new Event('input', { bubbles: true }));
          match.dispatchEvent(new Event('change', { bubbles: true }));
          match.focus();
          lastFocusedField = match;
          const chosenName = labelFor(match) || match.value;
          return { ok: true, msg: `Selected ${chosenName} for ${groupName}.` };
        }
      }
      target.checked = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
      lastFocusedField = target;
      return { ok: true, msg: `Selected ${displayName}.` };
    }

    // 4. OTHER INPUT TYPES
    let finalValue = rawValue.trim();

    if (type === 'email') {
      finalValue = formatEmail(finalValue);
    } else if (type === 'tel') {
      finalValue = formatPhone(finalValue);
    } else if (type === 'number' || type === 'range') {
      finalValue = parseNumber(finalValue);
    } else if (type === 'color') {
      finalValue = parseColor(finalValue);
    } else if (type === 'date') {
      finalValue = parseDate(finalValue);
    }

    const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(target, finalValue);
    else target.value = finalValue;

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.focus();
    lastFocusedField = target;

    return { ok: true, msg: `${displayName} set to ${finalValue}.` };
  }

  // ---------------------------------------------------------------------
  // Focus navigation
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // Global Dropdown / Radio / Checkbox Finder
  // ---------------------------------------------------------------------
  function findOptionGlobally(wanted) {
    const needle = wanted.trim().toLowerCase();
    if (!needle) return null;

    // Search all selects
    const selects = Array.from(document.querySelectorAll('select')).filter(isFillable);
    for (const sel of selects) {
      for (const opt of Array.from(sel.options)) {
        if (
          opt.textContent.trim().toLowerCase() === needle ||
          opt.value.trim().toLowerCase() === needle ||
          opt.textContent.trim().toLowerCase().includes(needle)
        ) {
          return { element: sel, value: opt.value, label: labelFor(sel) || 'Dropdown' };
        }
      }
    }

    // Search all radio buttons
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(isFillable);
    for (const r of radios) {
      if (
        r.value.toLowerCase() === needle ||
        labelFor(r).toLowerCase().includes(needle) ||
        needle.includes(r.value.toLowerCase())
      ) {
        return { element: r, value: r.value, label: r.name || 'Option' };
      }
    }

    // Search all checkboxes
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(isFillable);
    for (const cb of checkboxes) {
      if (labelFor(cb).includes(needle) || needle.includes(labelFor(cb))) {
        return { element: cb, value: 'check', label: labelFor(cb) || 'Checkbox' };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // Command parsing & Execution
  // ---------------------------------------------------------------------
  function normalize(t) {
    return t.trim().replace(/\s+/g, ' ');
  }

  async function handleCommand(rawText) {
    const text = normalize(rawText);
    const lower = text.toLowerCase();
    currentTranscript = text;
    notifyPopup({ type: 'transcript', text });
    updateWidgetTranscript();

    // 1. "submit" / "submit form"
    if (/^(submit( (the )?(form|application))?|click submit)$/i.test(lower)) {
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"]):not([type="reset"])');
      if (submitBtn) {
        submitBtn.click();
        await say('Form submitted.');
      } else {
        const form = document.querySelector('form');
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          await say('Form submitted.');
        } else {
          await say('No submit button found.');
        }
      }
      return;
    }

    // 2. "tab" / "next field" / "next"
    if (/^(tab|next( field)?)$/i.test(lower)) {
      const f = focusNextField(false);
      await say(f ? `Moved to ${labelFor(f) || 'next field'}.` : 'No more fields.');
      return;
    }

    // 3. "previous field" / "shift tab" / "back"
    if (/^(previous( field)?|shift tab|back)$/i.test(lower)) {
      const f = focusNextField(true);
      await say(f ? `Moved to ${labelFor(f) || 'previous field'}.` : 'No previous field.');
      return;
    }

    // 4. "clear field" / "select all plus delete"
    if (/^(select all plus delete|clear( the)?( field| this)?|delete( field)?)$/i.test(lower)) {
      const target = isFillable(document.activeElement) ? document.activeElement : lastFocusedField;
      if (target) {
        smartSetFieldValue(target, '', labelFor(target));
        await say('Field cleared.');
      } else {
        await say('No field selected.');
      }
      return;
    }

    // 5. "check the terms" / "uncheck newsletter" / "agree to terms" / "tick terms"
    let m = lower.match(/^(check|uncheck|tick|untick|agree to|accept)\s+(?:the\s+)?(.+?)(?:\s+box|\s+checkbox)?$/i);
    if (m) {
      const [, action, label] = m;
      const target = findFieldByLabel(label);
      if (target && target.type === 'checkbox') {
        const isUncheck = action.startsWith('un');
        const res = smartSetFieldValue(target, isUncheck ? 'uncheck' : 'check', label);
        await say(res.msg);
        return;
      }
    }

    // 6. "select/choose <value> for <label>" (e.g. "Select India for country", "Choose Pro for plan")
    m = lower.match(/^(?:select|choose|pick|set)\s+(.+?)\s+for\s+(.+)$/i);
    if (m) {
      const [, val, label] = m;
      const target = findFieldByLabel(label);
      if (target) {
        const res = smartSetFieldValue(target, val, label);
        await say(res.msg);
        return;
      }
    }

    // 7. "set <label> to <value>" (e.g. "Set country to India", "Set name to Shruti", "Set age to 25")
    m = lower.match(/^(?:set|change)\s+(.+?)\s+to\s+(.+)$/i);
    if (m) {
      const [, label, val] = m;
      const target = findFieldByLabel(label);
      if (target) {
        const res = smartSetFieldValue(target, val, label);
        await say(res.msg);
        return;
      }
    }

    // 8. "<label> is <value>" / "my <label> is <value>" (e.g. "Name is Shruti", "Country is India", "Plan is Pro")
    m = text.match(/^(?:my\s+)?(.+?)\s+is\s+(.+)$/i);
    if (m) {
      const [, label, val] = m;
      const target = findFieldByLabel(label);
      if (target) {
        const res = smartSetFieldValue(target, val, label);
        await say(res.msg);
        return;
      }
    }

    // 9. "select/choose (the) <value>" (e.g. "Select India", "Choose Pro", "Select Enterprise")
    m = lower.match(/^(?:select|choose|pick)\s+(?:the\s+)?(.+)$/i);
    if (m) {
      const wanted = m[1];
      // Check if focused field is a select or radio
      if (isFillable(document.activeElement)) {
        const res = smartSetFieldValue(document.activeElement, wanted);
        if (res.ok) {
          await say(res.msg);
          return;
        }
      }
      // Global search across all selects & radios
      const match = findOptionGlobally(wanted);
      if (match) {
        const res = smartSetFieldValue(match.element, match.value, match.label);
        await say(res.msg);
        return;
      }
    }

    // 10. Fallback: if a field is focused, dictate into it
    if (isFillable(document.activeElement)) {
      const res = smartSetFieldValue(document.activeElement, text, labelFor(document.activeElement));
      await say(res.msg || 'Filled.');
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
          handleCommand(result[0].transcript);
        } else {
          currentTranscript = result[0].transcript;
          notifyPopup({ type: 'interim', text: result[0].transcript });
          updateWidgetTranscript(true);
        }
      }
    };
    recognition.onerror = (e) => {
      notifyPopup({ type: 'error', text: e.error });
      if (shadowRoot) {
        const errEl = shadowRoot.getElementById('vf-error');
        if (errEl) {
          errEl.textContent = `Mic Error: ${e.error}`;
          errEl.style.display = 'block';
        }
      }
    };
    recognition.onend = () => {
      if (listening) {
        try {
          recognition.start();
        } catch (_) { }
      }
    };

    recognition.start();
    listening = true;
    notifyPopup({ type: 'status', listening: true });
    setWidgetState('active');
    say('Voice form on.');
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    if (recognition) recognition.stop();
    notifyPopup({ type: 'status', listening: false });
    setWidgetState('prompt');
    say('Voice form off.');
  }

  // ---------------------------------------------------------------------
  // Custom button bindings
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
  // In-Page Floating Assistant Widget (Shadow DOM Encapsulated)
  // ---------------------------------------------------------------------
  let widgetHost = null;
  let shadowRoot = null;

  function ensureWidget() {
    if (widgetHost && shadowRoot) return;

    widgetHost = document.createElement('div');
    widgetHost.id = 'voiceform-inpage-assistant';
    widgetHost.style.position = 'fixed';
    widgetHost.style.bottom = '24px';
    widgetHost.style.right = '24px';
    widgetHost.style.zIndex = '2147483647';
    widgetHost.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    widgetHost.style.pointerEvents = 'auto';

    shadowRoot = widgetHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }
      
      .vf-widget {
        display: flex;
        flex-direction: column;
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(56, 189, 248, 0.28);
        border-radius: 16px;
        color: #f8fafc;
        box-shadow: 0 16px 32px -4px rgba(0, 0, 0, 0.5), 0 0 20px rgba(56, 189, 248, 0.15);
        width: 320px;
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
        animation: vf-slideIn 0.3s ease-out;
      }

      @keyframes vf-slideIn {
        from { opacity: 0; transform: translateY(16px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      .vf-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.02);
      }

      .vf-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.3px;
        color: #e2e8f0;
      }

      .vf-icon-wrap {
        width: 26px;
        height: 26px;
        border-radius: 8px;
        background: linear-gradient(135deg, #0ea5e9, #6366f1);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 10px rgba(14, 165, 233, 0.5);
      }

      .vf-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .vf-btn-icon {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        transition: all 0.15s;
      }
      .vf-btn-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
      }

      .vf-body {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .vf-prompt-title {
        font-size: 14px;
        font-weight: 600;
        color: #f1f5f9;
      }

      .vf-prompt-desc {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.4;
      }

      .vf-primary-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 10px 14px;
        border: none;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        background: linear-gradient(135deg, #0ea5e9, #6366f1);
        color: #ffffff;
        box-shadow: 0 4px 12px rgba(14, 165, 233, 0.35);
        transition: all 0.2s;
      }
      .vf-primary-btn:hover {
        opacity: 0.92;
        transform: translateY(-1px);
        box-shadow: 0 6px 16px rgba(14, 165, 233, 0.45);
      }

      .vf-stop-btn {
        background: linear-gradient(135deg, #ef4444, #dc2626);
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);
      }
      .vf-stop-btn:hover {
        box-shadow: 0 6px 16px rgba(239, 68, 68, 0.45);
      }

      /* Active listening view */
      .vf-pulse-container {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      .vf-pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 10px #10b981;
        animation: vf-pulse 1.4s infinite;
      }
      @keyframes vf-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.4); opacity: 0.6; }
      }

      .vf-status-text {
        font-size: 12px;
        font-weight: 600;
        color: #34d399;
      }

      .vf-transcript-box {
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        min-height: 48px;
        max-height: 90px;
        overflow-y: auto;
        color: #cbd5e1;
        line-height: 1.4;
      }
      .vf-transcript-box b {
        color: #38bdf8;
      }

      .vf-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #64748b;
      }
      .vf-badge {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 600;
      }

      /* Minimized Pill Button */
      .vf-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(56, 189, 248, 0.35);
        border-radius: 999px;
        color: #f8fafc;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 12px rgba(56, 189, 248, 0.2);
        cursor: pointer;
        transition: all 0.2s;
        animation: vf-slideIn 0.2s ease-out;
      }
      .vf-pill:hover {
        transform: scale(1.05);
        border-color: #38bdf8;
      }
      .vf-pill-text {
        font-size: 12px;
        font-weight: 600;
        color: #e2e8f0;
      }
    `;

    const container = document.createElement('div');
    container.id = 'vf-root';

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(container);
    document.body.appendChild(widgetHost);
  }

  function renderWidget() {
    ensureWidget();
    const root = shadowRoot.getElementById('vf-root');
    if (!root) return;

    if (widgetState === 'hidden') {
      root.innerHTML = '';
      return;
    }

    if (widgetState === 'minimized') {
      root.innerHTML = `
        <div class="vf-pill" id="vf-pill-btn" title="Click to open VoiceForm assistant">
          <div class="vf-icon-wrap" style="width:20px;height:20px;font-size:11px;">🎙️</div>
          <span class="vf-pill-text">${listening ? 'VoiceForm Listening…' : 'VoiceForm'}</span>
          ${listening ? '<div class="vf-pulse-dot"></div>' : ''}
        </div>
      `;
      shadowRoot.getElementById('vf-pill-btn').addEventListener('click', () => {
        setWidgetState(listening ? 'active' : 'prompt');
      });
      return;
    }

    const fieldCount = allFillableFields().length;

    if (widgetState === 'prompt') {
      root.innerHTML = `
        <div class="vf-widget">
          <div class="vf-header">
            <div class="vf-brand">
              <div class="vf-icon-wrap">🎙️</div>
              <span>VoiceForm</span>
            </div>
            <div class="vf-actions">
              <button class="vf-btn-icon" id="vf-min-btn" title="Minimize">🗕</button>
              <button class="vf-btn-icon" id="vf-close-btn" title="Dismiss">✕</button>
            </div>
          </div>
          <div class="vf-body">
            <div class="vf-prompt-title">Fill with VoiceForm?</div>
            <div class="vf-prompt-desc">
              Detected <b>${fieldCount}</b> fillable field${fieldCount === 1 ? '' : 's'} on this page. Speak naturally to fill text, radio, select, or checkboxes.
            </div>
            <button class="vf-primary-btn" id="vf-start-btn">
              <span>🎙️</span> Start Voice Fill <span style="font-size:11px;opacity:0.8;font-weight:400;margin-left:auto;">Alt+V</span>
            </button>
          </div>
        </div>
      `;

      shadowRoot.getElementById('vf-start-btn').addEventListener('click', () => startListening());
      shadowRoot.getElementById('vf-min-btn').addEventListener('click', () => setWidgetState('minimized'));
      shadowRoot.getElementById('vf-close-btn').addEventListener('click', () => {
        isDismissed = true;
        setWidgetState('hidden');
      });
      return;
    }

    if (widgetState === 'active') {
      const providerLabel = usingFallbackTTS ? 'Browser TTS' : 'Rime TTS';
      root.innerHTML = `
        <div class="vf-widget">
          <div class="vf-header">
            <div class="vf-brand">
              <div class="vf-icon-wrap">🎙️</div>
              <span>VoiceForm Assistant</span>
            </div>
            <div class="vf-actions">
              <button class="vf-btn-icon" id="vf-min-btn" title="Minimize">🗕</button>
              <button class="vf-btn-icon" id="vf-close-btn" title="Stop & Close (Esc)">✕</button>
            </div>
          </div>
          <div class="vf-body">
            <div class="vf-pulse-container">
              <div class="vf-pulse-dot"></div>
              <span class="vf-status-text">Listening for commands…</span>
            </div>
            <div class="vf-transcript-box" id="vf-transcript-box">
              ${currentTranscript || lastConfirmation
          ? `<div><b>You:</b> ${currentTranscript || '…'}</div>` +
          (lastConfirmation ? `<div style="margin-top:4px;color:#a5f3fc;"><b>VoiceForm:</b> ${lastConfirmation}</div>` : '')
          : 'Say e.g. <i>"Country is India"</i>, <i>"Plan is Pro"</i>, <i>"Check terms"</i>…'
        }
            </div>
            <div id="vf-error" style="display:none;color:#f87171;font-size:11px;"></div>
            <div class="vf-meta-row">
              <span>Speech Engine:</span>
              <span class="vf-badge" id="vf-provider-badge">${providerLabel}</span>
            </div>
            <button class="vf-primary-btn vf-stop-btn" id="vf-stop-btn">
              <span>⏹️</span> Stop Listening <span style="font-size:11px;opacity:0.8;font-weight:400;margin-left:auto;">Esc</span>
            </button>
          </div>
        </div>
      `;

      shadowRoot.getElementById('vf-stop-btn').addEventListener('click', () => stopListening());
      shadowRoot.getElementById('vf-min-btn').addEventListener('click', () => setWidgetState('minimized'));
      shadowRoot.getElementById('vf-close-btn').addEventListener('click', () => {
        stopListening();
        isDismissed = true;
        setWidgetState('hidden');
      });
    }
  }

  function setWidgetState(newState) {
    widgetState = newState;
    renderWidget();
  }

  function updateWidgetTranscript(isInterim) {
    if (widgetState !== 'active' || !shadowRoot) return;
    const box = shadowRoot.getElementById('vf-transcript-box');
    if (box) {
      box.innerHTML = `
        <div><b>You:</b> ${currentTranscript || '…'}</div>
        ${lastConfirmation ? `<div style="margin-top:4px;color:#a5f3fc;"><b>VoiceForm:</b> ${lastConfirmation}</div>` : ''}
      `;
    }
  }

  function updateWidgetProvider(provider) {
    if (!shadowRoot) return;
    const badge = shadowRoot.getElementById('vf-provider-badge');
    if (badge) {
      badge.textContent = provider === 'rime' ? 'Rime TTS' : 'Browser TTS';
    }
  }

  function showInPagePrompt() {
    if (isDismissed || listening) return;
    const fields = allFillableFields();
    if (fields.length > 0) {
      setWidgetState('prompt');
    }
  }

  // Check on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(showInPagePrompt, 500));
  } else {
    setTimeout(showInPagePrompt, 500);
  }

  // Observe dynamically loaded form fields
  const observer = new MutationObserver(() => {
    if (!isDismissed && widgetState === 'hidden' && !listening) {
      if (allFillableFields().length > 0) {
        showInPagePrompt();
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ---------------------------------------------------------------------
  // Messaging with popup
  // ---------------------------------------------------------------------
  function notifyPopup(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) { }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start') startListening();
    if (msg.type === 'stop') stopListening();
    if (msg.type === 'bindings-updated') bindings = msg.bindings || [];
    if (msg.type === 'bindings-updated') bindings = msg.bindings || [];
    if (msg.type === 'get-status') sendResponse({ listening, usingFallbackTTS });
    return true;
  });
})();