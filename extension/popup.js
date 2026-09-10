const toggleBtn = document.getElementById('toggle');
const dot = document.getElementById('dot');
const providerEl = document.getElementById('provider');
const transcriptEl = document.getElementById('transcript');
const bindingsEl = document.getElementById('bindings');
const bindActionEl = document.getElementById('bindAction');
const addBindingBtn = document.getElementById('addBinding');

let listening = false;
let bindings = [];

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

async function send(msg) {
  const tabId = await activeTabId();
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
}

function render() {
  toggleBtn.textContent = listening ? 'Stop listening' : 'Start listening';
  toggleBtn.classList.toggle('stop', listening);
  dot.classList.toggle('live', listening);
}

toggleBtn.addEventListener('click', async () => {
  listening = !listening;
  await send({ type: listening ? 'start' : 'stop' });
  render();
});

// Reflect live events from the content script (transcripts, provider used,
// interruption/fallback status) while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    listening = msg.listening;
    render();
  }
  if (msg.type === 'transcript') {
    transcriptEl.textContent = `Heard: "${msg.text}"`;
  }
  if (msg.type === 'transcript-confirm') {
    transcriptEl.textContent += `\nVoiceForm: "${msg.text}"`;
  }
  if (msg.type === 'provider') {
    if (msg.provider === 'rime') {
      providerEl.textContent = 'Rime (mistv3)';
      providerEl.className = 'provider rime';
    } else {
      providerEl.textContent = 'Browser fallback';
      providerEl.className = 'provider fallback';
    }
  }
  if (msg.type === 'error') {
    transcriptEl.textContent = `Error: ${msg.text}`;
  }
});

// ---------------------------------------------------------------------
// Custom button bindings — lets a user map any key press (including a
// single bare key from an assistive switch) to Start / Stop / Toggle,
// so voice control never depends on precisely clicking this popup.
// ---------------------------------------------------------------------
const DEFAULT_BINDINGS = [
  { id: 'default-toggle', action: 'toggle', code: 'KeyV', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false },
  { id: 'default-stop', action: 'stop', code: 'Escape', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false },
];

function describeBinding(b) {
  const parts = [];
  if (b.ctrlKey) parts.push('Ctrl');
  if (b.altKey) parts.push('Alt');
  if (b.shiftKey) parts.push('Shift');
  if (b.metaKey) parts.push('Meta');
  parts.push(b.code.replace(/^Key/, '').replace(/^Digit/, ''));
  return parts.join('+');
}

function renderBindings() {
  bindingsEl.innerHTML = '';
  if (bindings.length === 0) {
    bindingsEl.innerHTML = '<div style="font-size:12px;color:#6b7280;">No buttons set yet.</div>';
    return;
  }
  bindings.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'binding-row';
    row.innerHTML = `<span>${b.action} — <b>${describeBinding(b)}</b></span>`;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.className = 'binding-remove';
    rm.addEventListener('click', () => removeBinding(b.id));
    row.appendChild(rm);
    bindingsEl.appendChild(row);
  });
}

async function loadBindings() {
  const stored = await chrome.storage.sync.get('voiceformBindings');
  if (stored.voiceformBindings && Array.isArray(stored.voiceformBindings) && stored.voiceformBindings.length > 0) {
    bindings = stored.voiceformBindings;
  } else {
    bindings = [...DEFAULT_BINDINGS];
    await chrome.storage.sync.set({ voiceformBindings: bindings });
  }
  renderBindings();
}

async function saveBindings() {
  await chrome.storage.sync.set({ voiceformBindings: bindings });
  const tabId = await activeTabId();
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'bindings-updated', bindings }, () => void chrome.runtime.lastError);
  }
}

function removeBinding(id) {
  bindings = bindings.filter((b) => b.id !== id);
  renderBindings();
  saveBindings();
}

addBindingBtn.addEventListener('click', () => {
  addBindingBtn.textContent = 'Press a button…';
  addBindingBtn.disabled = true;
  const capture = (e) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for a real key
    bindings.push({
      id: Date.now().toString(36),
      action: bindActionEl.value,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
    document.removeEventListener('keydown', capture, true);
    addBindingBtn.textContent = '+ Add button';
    addBindingBtn.disabled = false;
    renderBindings();
    saveBindings();
  };
  document.addEventListener('keydown', capture, true);
});

render();
loadBindings();