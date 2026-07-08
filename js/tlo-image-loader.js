(function () {
  'use strict';

  var RETRY_DELAYS = [500, 1200];
  var DEFAULT_TIMEOUT_MS = 2600;
  var FALLBACK_IMAGE = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="448" viewBox="0 0 320 448">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17243d"/><stop offset=".55" stop-color="#10111f"/><stop offset="1" stop-color="#301548"/></linearGradient></defs>' +
    '<rect width="320" height="448" rx="28" fill="url(#g)"/>' +
    '<rect x="16" y="16" width="288" height="416" rx="22" fill="none" stroke="#42f5ef" stroke-opacity=".32" stroke-width="3"/>' +
    '<circle cx="160" cy="180" r="54" fill="#42f5ef" fill-opacity=".12" stroke="#42f5ef" stroke-opacity=".36" stroke-width="3"/>' +
    '<text x="160" y="195" text-anchor="middle" font-size="58" font-family="Arial, sans-serif" fill="#e9ffff" fill-opacity=".88">?</text>' +
    '<text x="160" y="292" text-anchor="middle" font-size="28" font-family="Arial, sans-serif" font-weight="700" fill="#e9ffff">T-LO</text>' +
    '<text x="160" y="326" text-anchor="middle" font-size="18" font-family="Arial, sans-serif" fill="#9fefff">IMAGE LOADING</text>' +
    '</svg>'
  );

  function isImageLikeUrl(url) {
    var raw = String(url || '').trim();
    if (!raw) return false;
    if (raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return true;
    if (/^https?:\/\//i.test(raw)) return true;
    if (/^\.\//.test(raw) || /^\.\.\//.test(raw) || /^\//.test(raw)) return true;
    return /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(raw);
  }

  function retryUrl(url, attempt) {
    var raw = String(url || '').trim();
    if (!raw || raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return raw;
    var joiner = raw.indexOf('?') >= 0 ? '&' : '?';
    return raw + joiner + 'tlo_img_retry=' + encodeURIComponent(String(Date.now()) + '_' + attempt);
  }

  function getOriginalSrc(img) {
    if (!img) return '';
    return img.dataset.tloOriginalSrc || img.getAttribute('src') || '';
  }

  function enhanceImage(img) {
    if (!img || img.nodeType !== 1 || String(img.tagName || '').toLowerCase() !== 'img') return img;
    try {
      if (!img.hasAttribute('loading')) img.setAttribute('loading', img.dataset.tloCritical === '1' ? 'eager' : 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
      if (!img.hasAttribute('fetchpriority') && img.dataset.tloCritical === '1') img.setAttribute('fetchpriority', 'high');
      var currentSrc = img.getAttribute('src') || '';
      if (currentSrc && currentSrc !== FALLBACK_IMAGE && currentSrc !== img.dataset.tloOriginalSrc) {
        img.dataset.tloOriginalSrc = currentSrc;
        img.dataset.tloRetryAttempt = '0';
        img.dataset.tloFallbackUsed = '0';
      }
      if (img.dataset.tloRetryBound === '1') return img;
      img.dataset.tloRetryBound = '1';
      img.addEventListener('error', function () {
        var original = getOriginalSrc(img);
        if (!isImageLikeUrl(original) || original === FALLBACK_IMAGE || img.dataset.tloFallbackUsed === '1') return;
        var attempt = Number(img.dataset.tloRetryAttempt || 0);
        if (attempt < RETRY_DELAYS.length) {
          img.dataset.tloRetryAttempt = String(attempt + 1);
          setTimeout(function () {
            if (!img || !img.parentNode) return;
            if (img.getAttribute('srcset')) img.removeAttribute('srcset');
            img.src = retryUrl(original, attempt + 1);
          }, RETRY_DELAYS[attempt]);
        } else {
          img.dataset.tloFallbackUsed = '1';
          img.removeAttribute('srcset');
          img.src = FALLBACK_IMAGE;
        }
      });
    } catch (_) {}
    return img;
  }

  function enhanceAll(root) {
    try {
      var base = root && root.querySelectorAll ? root : document;
      if (base.tagName && String(base.tagName).toLowerCase() === 'img') {
        if (base.dataset && base.dataset.tloRetryBound === '1') return;
        enhanceImage(base);
      }
      var imgs = base.querySelectorAll ? base.querySelectorAll('img:not([data-tlo-retry-bound="1"])') : [];
      for (var i = 0; i < imgs.length; i += 1) enhanceImage(imgs[i]);
    } catch (_) {}
  }

  function preloadOne(url, options) {
    options = options || {};
    var src = String(url || '').trim();
    var timeoutMs = Math.max(600, Number(options.timeout || DEFAULT_TIMEOUT_MS));
    if (!isImageLikeUrl(src)) return Promise.resolve({ url: src, ok: false, skipped: true });
    return new Promise(function(resolve) {
      var settled = false;
      var attempt = 0;
      var img = new Image();
      img.decoding = 'async';
      img.loading = 'eager';
      if (options.fetchPriority) {
        try { img.fetchPriority = options.fetchPriority; } catch (_) {}
      }
      var done = function(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ url: src, ok: !!ok });
      };
      var timer = setTimeout(function(){ done(false); }, timeoutMs);
      img.onload = function(){ done(true); };
      img.onerror = function(){
        if (attempt < RETRY_DELAYS.length) {
          var delay = RETRY_DELAYS[attempt];
          attempt += 1;
          setTimeout(function(){ if (!settled) img.src = retryUrl(src, attempt); }, delay);
        } else {
          done(false);
        }
      };
      img.src = src;
      if (img.complete && img.naturalWidth > 0) done(true);
    });
  }

  function preload(urls, options) {
    options = options || {};
    var seen = new Set();
    var list = (Array.isArray(urls) ? urls : [urls]).map(function(url){ return String(url || '').trim(); }).filter(function(url){
      if (!isImageLikeUrl(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
    if (!list.length) return Promise.resolve([]);
    var limit = Math.max(1, Math.min(8, Number(options.concurrency || 6)));
    var index = 0;
    var results = [];
    function worker() {
      if (index >= list.length) return Promise.resolve();
      var current = list[index++];
      return preloadOne(current, options).then(function(result){ results.push(result); }).catch(function(){ results.push({ url: current, ok: false }); }).then(worker);
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, list.length); i += 1) workers.push(worker());
    return Promise.all(workers).then(function(){ return results; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ enhanceAll(document); });
  } else {
    enhanceAll(document);
  }

  try {
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        for (var i = 0; i < m.addedNodes.length; i += 1) {
          var node = m.addedNodes[i];
          if (node && node.nodeType === 1) enhanceAll(node);
        }
      });
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (_) {}

  window.TLOImageLoader = {
    fallbackImage: FALLBACK_IMAGE,
    enhanceImage: enhanceImage,
    enhanceAll: enhanceAll,
    preload: preload,
    preloadOne: preloadOne
  };
})();
