const PAGE_SOURCE = 'synthi-oauth-relay-page';
const EXTENSION_SOURCE = 'synthi-oauth-relay-extension';

window.postMessage({
  source: EXTENSION_SOURCE,
  type: 'SYNTHI_OAUTH_RELAY_READY',
}, window.location.origin);

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE || !data.type || !data.messageId) return;

  chrome.runtime.sendMessage({
    type: data.type,
    payload: data.payload || {},
  }, (response) => {
    window.postMessage({
      source: EXTENSION_SOURCE,
      type: `${data.type}_RESULT`,
      messageId: data.messageId,
      payload: response || null,
    }, window.location.origin);
  });
});

