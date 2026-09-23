/* YT Roadblock Refresher — content script (block detection & recovery)
 *
 * Loop:
 *   1. poll the page once a second for YouTube's "playback blocked" states
 *   2. if one sticks around for a moment, stash the timestamp + fullscreen intent, reload
 *   3. after the reload, seek back and put full screen back on
 *   4. YouTube autoplays the next video without a page load, so re-arm on SPA navigation

 */

(() => {
  'use strict';

  if (window.top !== window) return;   // main page only, never iframes like live chat

  const DEFAULTS = {
    enabled: true,
    fullscreenMode: 'player',   // 'off' | 'player' | 'window'
    resumePosition: true,
    stallDetect: false,
    maxRetries: 3,
    confirmTicks: 2             // how many 1s polls a block must persist before we act
  };

  const POLL_MS = 1000;
  const COOLOFF_MS = 90_000;    // retry budget window
  const STALL_TICKS = 10;       // seconds of frozen currentTime before calling it a stall
  const STATE_KEY = 'ytrb_state';
  const RESTORE_WINDOW_MS = 60_000;

  let cfg = { ...DEFAULTS };
  let blockTicks = 0;
  let stallTicks = 0;
  let lastTime = -1;
  let lastGoodTime = 0;         // last playback position seen outside an ad
  let lastUrl = location.href;
  let lastFullscreenAt = 0;
  let restoreDone = false;
  let poller = null;

  /* ---------- config ---------- */

  const cfgReady = new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      cfg = { ...DEFAULTS, ...stored };
      resolve();
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) cfg[k] = v.newValue;
    }
  });

  /* ---------- small helpers ---------- */

  const video = () => document.querySelector('video.html5-main-video, #movie_player video, video');

  function adPlaying() {
    const p = document.getElementById('movie_player');
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  function videoId() {
    try {
      return new URL(location.href).searchParams.get('v') || location.pathname;
    } catch {
      return location.pathname;
    }
  }

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function writeState(s) {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
    } catch { /* private mode, storage full — not fatal */ }
  }

  function clearState() {
    try { sessionStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
  }

  function bumpCounter() {
  chrome.storage.local.get({ blocksCaught: 0 }, ({ blocksCaught }) => {
    chrome.storage.local.set({ blocksCaught: blocksCaught + 1000 });
  });
}

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) lastFullscreenAt = Date.now();
  }, true);

  function fullscreenWanted() {
    if (cfg.fullscreenMode === 'off') return false;
    // Either we're in full screen right now, or YouTube kicked us out of it seconds ago
    // when it threw up the block.
    return !!document.fullscreenElement || (Date.now() - lastFullscreenAt) < 15_000;
  }

  /* ---------- detection ---------- */

  // Structural markers. These are the elements YouTube renders for the anti-adblock
  // modal and for a dead player. Selectors do drift — if a new one appears, add it here.
  const BLOCK_SELECTORS = [
    'ytd-enforcement-message-view-model',
    'yt-playability-error-supported-renderers',
    '#error-screen .ytp-error',
    '.ytp-error'
  ];

  // Text fallback for modal dialogs, in case the markup changes but the wording doesn't.
  // Kept specific on purpose: a generic phrase like "an error occurred" matched unrelated
  // dialogs. These are English — add your own language's equivalents if needed.
  const BLOCK_PHRASES = [
    'ad blocker',
    'ad blockers',
    'ad-blocker',
    'not available on this app',
    'violates youtube'
  ];

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function detectBlock() {
    for (const sel of BLOCK_SELECTORS) {
      const el = document.querySelector(sel);
      if (isVisible(el)) return sel;
    }

    for (const dlg of document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container tp-yt-paper-dialog')) {
      if (!isVisible(dlg)) continue;
      const text = (dlg.innerText || '').toLowerCase();
      if (BLOCK_PHRASES.some((p) => text.includes(p))) return 'dialog-text';
    }

    if (cfg.stallDetect && detectStall()) return 'stalled';
    return null;
  }

  function detectStall() {
    const v = video();
    // readyState dropping to 1–2 is exactly what a buffering stall looks like, so only
    // bail out when there's no media at all. Ads are left alone so a stuck ad doesn't
    // get mixed up with the video's own position.
    if (!v || v.paused || v.seeking || v.ended || v.readyState === 0 || adPlaying()) {
      stallTicks = 0;
      lastTime = -1;
      return false;
    }
    if (v.currentTime === lastTime) {
      stallTicks += 1;
    } else {
      stallTicks = 0;
      lastTime = v.currentTime;
    }
    return stallTicks >= STALL_TICKS;
  }

  /* ---------- the reload ---------- */

  function doReload(reason) {
    const now = Date.now();
    const id = videoId();
    const prev = readState() || {};

    // Already gave up on this video: stay quiet instead of re-showing the banner every
    // two seconds and starting a fresh round of reloads when the window expires.
    if (prev.gaveUp && prev.videoId === id) return;

    let retries = prev.retries || 0;
    let firstRetryAt = prev.firstRetryAt || 0;

    // Fresh video, or the budget window has expired → reset the retry count.
    if (prev.videoId !== id || !firstRetryAt || now - firstRetryAt > COOLOFF_MS) {
      retries = 0;
      firstRetryAt = now;
    }

    if (retries >= cfg.maxRetries) {
      writeState({ videoId: id, gaveUp: true, stamp: now });
      banner(`Gave up after ${cfg.maxRetries} reloads. Refresh manually if you want to try again.`, 12_000);
      return;
    }

    // If the block hit during an ad, the video's clock is the ad's, not the show's.
    const v = video();
    const here = adPlaying() || !v || !isFinite(v.currentTime) ? lastGoodTime : v.currentTime;

    writeState({
      videoId: id,
      retries: retries + 1,
      firstRetryAt,
      stamp: now,
      resumeAt: cfg.resumePosition ? Math.max(0, here - 2) : 0,
      wantFullscreen: fullscreenWanted()
    });

    bumpCounter();
    console.info('[YT Roadblock Refresher] reloading —', reason);
    location.reload();
  }

  /* ---------- putting things back ---------- */

  function restoreAfterReload() {
    if (!cfg.enabled) return;
    const st = readState();
    if (!st || st.gaveUp || restoreDone) return;
    if (Date.now() - st.stamp > RESTORE_WINDOW_MS) return;   // stale, user navigated away and back
    if (st.videoId !== videoId()) return;

    restoreDone = true;

    waitForPlayableVideo().then((v) => {
      if (!v) return;

      if (st.resumeAt > 1) {
        try { v.currentTime = st.resumeAt; } catch { /* live stream, or seek refused */ }
      }

      if (!st.wantFullscreen || cfg.fullscreenMode === 'off') return;

      if (cfg.fullscreenMode === 'window') {
        chrome.runtime.sendMessage({ type: 'window-fullscreen' }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok) enterTheater();
        });
        return;
      }

      goFullscreen();
    });
  }

  function waitForPlayableVideo(timeoutMs = 20_000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const v = video();
        if (v && v.readyState >= 1) return resolve(v);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  // Window mode only makes the browser full screen; theater mode then stretches the
  // player across it. YouTube remembers theater mode as your preference afterwards.
  function enterTheater() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy || flexy.hasAttribute('theater') || flexy.hasAttribute('fullscreen')) return;
    document.querySelector('.ytp-size-button')?.click();
  }

  function clickFullscreenButton() {
    const btn = document.querySelector('.ytp-fullscreen-button');
    if (btn) {
      btn.click();          // inside a real user gesture this carries activation
      return true;
    }
    const player = document.querySelector('#movie_player') || video();
    if (player?.requestFullscreen) {
      player.requestFullscreen().catch(() => {});
      return true;
    }
    return false;
  }

  function goFullscreen() {
    // Try it outright first. Chrome almost always refuses, because a page reload
    // clears the "user gesture" flag and the Fullscreen API demands one.
    const player = document.querySelector('#movie_player') || video();
    const attempt = player?.requestFullscreen?.();

    if (attempt && typeof attempt.then === 'function') {
      attempt.then(() => { /* worked */ }).catch(() => armGesture());
    } else {
      armGesture();
    }
  }

  function armGesture() {
    if (document.fullscreenElement) return;

    banner('Click anywhere or tap a key to go back to full screen', 15_000);

    const fire = () => {
      window.removeEventListener('pointerdown', fire, true);
      window.removeEventListener('keydown', fire, true);
      clearBanner();
      clickFullscreenButton();
    };

    window.addEventListener('pointerdown', fire, true);
    window.addEventListener('keydown', fire, true);
  }

  /* ---------- banner ---------- */

  let bannerEl = null;
  let bannerTimer = null;

  function banner(text, ms) {
    clearBanner();
    bannerEl = document.createElement('div');
    bannerEl.textContent = text;
    Object.assign(bannerEl.style, {
      position: 'fixed',
      left: '50%',
      bottom: '48px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      maxWidth: '80vw',
      padding: '16px 26px',
      borderRadius: '10px',
      background: '#131A24',
      border: '1px solid #2C3A4C',
      color: '#F2D398',
      font: '600 24px/1.35 "Roboto", "Segoe UI", system-ui, sans-serif',
      letterSpacing: '0.01em',
      textAlign: 'center',
      pointerEvents: 'none',
      boxShadow: '0 10px 40px rgba(0,0,0,.55)'
    });
    (document.body || document.documentElement).appendChild(bannerEl);
    bannerTimer = setTimeout(clearBanner, ms);
  }

  function clearBanner() {
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = null;
    bannerEl?.remove();
    bannerEl = null;
  }

  /* ---------- main loop ---------- */

  function onNavigated() {
    lastUrl = location.href;
    blockTicks = 0;
    stallTicks = 0;
    lastTime = -1;
    lastGoodTime = 0;
    restoreDone = false;
    clearBanner();
    if (readState()?.gaveUp) clearState();   // left the video we gave up on
    restoreAfterReload();
  }

  function tick() {
    if (!cfg.enabled) return;

    if (location.href !== lastUrl) {      // SPA navigation: autoplay, or a click into the next video
      onNavigated();
      return;
    }

    const v = video();
    if (v && !adPlaying() && isFinite(v.currentTime) && v.currentTime > 0) {
      lastGoodTime = v.currentTime;
    }

    if (document.hidden) {                // don't burn retries reloading a background tab
      blockTicks = 0;
      return;
    }

    const reason = detectBlock();
    if (!reason) {
      blockTicks = 0;
      return;
    }

    blockTicks += 1;
    if (blockTicks >= cfg.confirmTicks) {
      blockTicks = 0;
      doReload(reason);
    }
  }

  async function start() {
    await cfgReady;

    // We stop reloading once we give up, so a load that still carries that flag
    // came from you refreshing by hand. Give it a fresh retry budget.
    if (readState()?.gaveUp) clearState();

    restoreAfterReload();
    if (poller) clearInterval(poller);
    poller = setInterval(tick, POLL_MS);
  }

  window.addEventListener('yt-navigate-finish', () => {
    if (location.href !== lastUrl) onNavigated();
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
