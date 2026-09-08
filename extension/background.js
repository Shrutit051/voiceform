// VoiceForm background service worker.
// Minimal: keeps the extension installable/debuggable and can be extended
// to relay messages between popup and content script if a page ever needs
// a background-mediated path (e.g. cross-tab state). Currently the popup
// talks to the content script directly via chrome.tabs.sendMessage.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VoiceForm] installed');
});
