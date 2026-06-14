const PAGE_SOURCES = new Set(['vectant-oauth-relay-page', 'synthi-oauth-relay-page']);
const EXTENSION_SOURCES = ['vectant-oauth-relay-extension', 'synthi-oauth-relay-extension'];

for (const source of EXTENSION_SOURCES) {
  window.postMessage({
    source,
    type: 'SYNTHI_OAUTH_RELAY_READY',
  }, window.location.origin);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || !PAGE_SOURCES.has(data.source) || !data.type || !data.messageId) return;

  chrome.runtime.sendMessage({
    type: data.type,
    payload: data.payload || {},
  }, (response) => {
    for (const source of EXTENSION_SOURCES) {
      window.postMessage({
        source,
        type: `${data.type}_RESULT`,
        messageId: data.messageId,
        payload: response || null,
      }, window.location.origin);
    }
  });
});
