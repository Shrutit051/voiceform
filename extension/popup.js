const toggleBtn = document.getElementById('toggle');
const dot = document.getElementById('dot');
const providerEl = document.getElementById('provider');
const transcriptEl = document.getElementById('transcript');

let listening = false;

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

render();
