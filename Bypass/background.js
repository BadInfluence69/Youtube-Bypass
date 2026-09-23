/* Browser-level full screen (the F11 kind) can be set from here without a user
   gesture, which is the one path that survives a page reload cleanly. */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'window-fullscreen' || !sender.tab) return;

  chrome.windows.update(sender.tab.windowId, { state: 'fullscreen' })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;   // keep the message channel open for the async reply
});
