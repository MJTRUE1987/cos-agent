/**
 * Frontend Capture — Returns a JavaScript snippet to inject into HTML pages.
 *
 * Captures:
 * - window.onerror (uncaught exceptions)
 * - unhandledrejection (unhandled promise rejections)
 * - fetch failures to /api/v2/* endpoints
 *
 * POSTs captured errors to /api/v2/failures with action: 'capture_frontend'.
 */

export function getFrontendCaptureScript(): string {
  return `
(function() {
  'use strict';

  var ENDPOINT = '/api/v2/failures';
  var MAX_QUEUE = 20;
  var FLUSH_MS = 5000;
  var queue = [];
  var sessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function send(failure) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(failure);
  }

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    for (var i = 0; i < batch.length; i++) {
      try {
        var body = JSON.stringify({
          action: 'capture_frontend',
          session_id: sessionId,
          error_type: 'frontend_error',
          error_message: batch[i].message || 'Unknown frontend error',
          stack: batch[i].stack || '',
          severity: batch[i].severity || 'medium',
          ui_snapshot: batch[i].ui_snapshot || '',
          metadata: batch[i].metadata || {}
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        } else {
          fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            keepalive: true
          }).catch(function() {});
        }
      } catch (e) {
        // Silently drop — avoid infinite loops
      }
    }
  }

  // 1. window.onerror — uncaught exceptions
  var origOnError = window.onerror;
  window.onerror = function(message, source, lineno, colno, error) {
    send({
      message: String(message),
      stack: error && error.stack ? error.stack : (source + ':' + lineno + ':' + colno),
      severity: 'high',
      ui_snapshot: document.title + ' | ' + location.pathname,
      metadata: { source: source, lineno: lineno, colno: colno, type: 'onerror' }
    });
    if (origOnError) return origOnError.apply(this, arguments);
    return false;
  };

  // 2. Unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    var reason = event.reason;
    var message = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    var stack = reason instanceof Error ? reason.stack : '';
    send({
      message: message,
      stack: stack || '',
      severity: 'high',
      ui_snapshot: document.title + ' | ' + location.pathname,
      metadata: { type: 'unhandledrejection' }
    });
  });

  // 3. Fetch failures to /api/v2/* endpoints
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var isV2 = url.indexOf('/api/v2/') !== -1;

    return origFetch.apply(this, arguments).then(function(response) {
      if (isV2 && !response.ok) {
        // Clone so the caller can still read the body
        response.clone().text().then(function(body) {
          send({
            message: 'API error: ' + response.status + ' ' + response.statusText + ' on ' + url,
            stack: '',
            severity: response.status >= 500 ? 'high' : 'medium',
            ui_snapshot: document.title + ' | ' + location.pathname,
            metadata: {
              type: 'fetch_error',
              url: url,
              status: response.status,
              response_body: body.slice(0, 500)
            }
          });
        }).catch(function() {});
      }
      return response;
    }).catch(function(err) {
      if (isV2) {
        send({
          message: 'Network error on ' + url + ': ' + (err && err.message ? err.message : String(err)),
          stack: err && err.stack ? err.stack : '',
          severity: 'critical',
          ui_snapshot: document.title + ' | ' + location.pathname,
          metadata: { type: 'fetch_network_error', url: url }
        });
      }
      throw err;
    });
  };

  // Flush periodically and on page unload
  setInterval(flush, FLUSH_MS);
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
})();
`.trim();
}
