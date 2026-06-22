(function () {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'YouTube Viewer',
    storageKey: 'mdg_youtube_viewer',
    api: {
      searchUrl: 'https://www.googleapis.com/youtube/v3/search',
      maxResults: 12,
      cacheDuration: 5 * 60 * 1000,
    },
    recentMax: 5,
  };

  // ==================== EMBEDDED CONFIG (config.js) ====================
  // Read the shared API key from config.js. Falls back to the per-user key in
  // localStorage when this isn't set, so anyone bringing their own key still
  // overrides the embedded default.
  function getEmbeddedApiKey() {
    var cfg = window.YOUTUBE_VIEWER_CONFIG;
    if (!cfg) return '';
    var k = cfg.EMBEDDED_API_KEY || '';
    if (!k || k === 'YOUR_API_KEY_HERE') return '';
    return k;
  }
  function getEffectiveApiKey() {
    // Personal key (from settings or URL param) wins over the shared one.
    return state.data.apiKey || getEmbeddedApiKey();
  }
  function isUsingEmbeddedKey() {
    return !state.data.apiKey && !!getEmbeddedApiKey();
  }

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    data: {
      apiKey: '',
      channelId: '',
      recent: [],
      history: [],       // { id, title, thumb, time }
      resume: null,      // { id, title, thumb, time (sec), dur, savedAt } — last in-progress video
    },
    cache: {},
    player: null,
    playerReady: false,
    currentVideo: null,
    overlayTimer: null,
    mine: { channelCache: {} },  // channelId -> { title, uploads }
    mineList: null,              // current level-1 view descriptor
    mineSub: null,              // current level-2 view descriptor
  };

  var screens = {};

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function (s) {
      if (s.id) screens[s.id] = s;
    });
  }

  // ==================== STORAGE ====================
  function loadData() {
    try {
      var saved = localStorage.getItem(CONFIG.storageKey);
      if (saved) Object.assign(state.data, JSON.parse(saved));
    } catch (e) {
      console.error('[Storage] Load error:', e);
    }
  }

  function saveData() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.data));
    } catch (e) {
      console.error('[Storage] Save error:', e);
    }
  }

  // ==================== NAVIGATION ====================
  function navigateTo(screenId, options) {
    options = options || {};
    if (options.addToHistory !== false && state.currentScreen) {
      state.screenHistory.push(state.currentScreen);
    }
    Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.currentScreen === 'player') {
      teardownPlayer();
    }
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
    }
  }

  // ==================== FOCUS ====================
  // Only truly visible elements are focusable. offsetParent is null when the
  // element (or an ancestor like a hidden error/loading panel) is display:none,
  // so this excludes those buttons that would otherwise trap D-pad focus.
  function getFocusables(container) {
    return Array.prototype.slice.call(
      container.querySelectorAll('.focusable:not([disabled])')
    ).filter(function (el) { return el.offsetParent !== null; });
  }

  function focusFirst(container) {
    var els = getFocusables(container);
    if (els.length) els[0].focus();
  }

  function scrollToFocus(el) {
    if (el && el.closest('.content, .list-container, .kb-content')) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function sameRow(a, b) {
    return Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 14;
  }

  // Group focusables into visual rows by vertical position so up/down jumps a
  // whole row at a time — the search row (input + Go + keyboard + mic) becomes
  // ONE stop; its buttons are reached by swiping left/right instead.
  function focusRows(els) {
    var rows = [];
    els.forEach(function (el) {
      var top = el.getBoundingClientRect().top;
      var last = rows[rows.length - 1];
      if (last && Math.abs(last.top - top) < 14) last.items.push(el);
      else rows.push({ top: top, items: [el] });
    });
    rows.sort(function (a, b) { return a.top - b.top; });
    return rows.map(function (r) { return r.items; });
  }

  function closestByX(els, ref) {
    var rx = ref.getBoundingClientRect().left;
    var best = null, bd = Infinity;
    els.forEach(function (e) {
      var d = Math.abs(e.getBoundingClientRect().left - rx);
      if (d < bd) { bd = d; best = e; }
    });
    return best;
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;
    var els = getFocusables(container);
    if (!els.length) return;
    var cur = document.activeElement;
    if (els.indexOf(cur) === -1) { els[0].focus(); scrollToFocus(els[0]); return; }

    if (direction === 'left' || direction === 'right') {
      // Within the current visual row when it has siblings (e.g. search row).
      var mates = els.filter(function (e) { return sameRow(e, cur); });
      if (mates.length > 1) {
        var mi = mates.indexOf(cur);
        var nmi = direction === 'right'
          ? (mi < mates.length - 1 ? mi + 1 : 0)
          : (mi > 0 ? mi - 1 : mates.length - 1);
        mates[nmi].focus(); scrollToFocus(mates[nmi]);
        return;
      }
      // Single-element row: fall back to sequential so list nav still works.
      var si = els.indexOf(cur);
      var nsi = direction === 'right'
        ? (si < els.length - 1 ? si + 1 : 0)
        : (si > 0 ? si - 1 : els.length - 1);
      els[nsi].focus(); scrollToFocus(els[nsi]);
      return;
    }

    // up / down: jump by row, keeping horizontal position where possible.
    var rows = focusRows(els);
    var curRow = -1;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].indexOf(cur) !== -1) { curRow = r; break; }
    }
    if (curRow === -1) { els[0].focus(); return; }
    var targetRow = direction === 'up'
      ? (curRow > 0 ? curRow - 1 : rows.length - 1)
      : (curRow < rows.length - 1 ? curRow + 1 : 0);
    var target = closestByX(rows[targetRow], cur) || rows[targetRow][0];
    target.focus(); scrollToFocus(target);
  }

  // ==================== HOME SCREEN ====================
  function renderRecent() {
    var listEl = document.getElementById('recent-list');
    var labelEl = document.getElementById('recent-label');
    listEl.innerHTML = '';
    if (!state.data.recent || state.data.recent.length === 0) {
      labelEl.classList.add('hidden');
      listEl.classList.add('hidden');
      return;
    }
    labelEl.classList.remove('hidden');
    listEl.classList.remove('hidden');
    state.data.recent.forEach(function (q) {
      var btn = document.createElement('button');
      btn.className = 'list-item focusable';
      btn.dataset.action = 'preset-search';
      btn.dataset.query = q;
      btn.innerHTML =
        '<span class="list-item-icon">&#8635;</span>' +
        '<span class="list-item-content"><span class="list-item-title"></span></span>';
      btn.querySelector('.list-item-title').textContent = q;
      listEl.appendChild(btn);
    });
  }

  function pushRecent(query) {
    var q = (query || '').trim();
    if (!q) return;
    state.data.recent = (state.data.recent || []).filter(function (r) { return r !== q; });
    state.data.recent.unshift(q);
    state.data.recent = state.data.recent.slice(0, CONFIG.recentMax);
    saveData();
  }

  // ==================== SEARCH ====================
  function runSearch(query) {
    var apiKey = getEffectiveApiKey();
    if (!apiKey) {
      navigateTo('settings');
      return;
    }
    var q = (query || '').trim();
    if (!q) return;

    pushRecent(q);
    document.getElementById('results-title').textContent = q;
    navigateTo('results');

    var loadingEl = document.getElementById('results-loading');
    var errorEl = document.getElementById('results-error');
    var listEl = document.getElementById('results-list');
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    listEl.innerHTML = '';

    var url = CONFIG.api.searchUrl +
      '?part=snippet' +
      '&type=video' +
      '&maxResults=' + CONFIG.api.maxResults +
      '&q=' + encodeURIComponent(q) +
      '&key=' + encodeURIComponent(apiKey);

    fetch(url)
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            var err = body && body.error;
            var reason = err && err.errors && err.errors[0] && err.errors[0].reason;
            var msg = (err && err.message) || ('HTTP ' + res.status);
            var e = new Error(msg);
            e.reason = reason || '';
            e.status = res.status;
            throw e;
          }, function () {
            var e = new Error('HTTP ' + res.status);
            e.status = res.status;
            throw e;
          });
        }
        return res.json();
      })
      .then(function (data) {
        loadingEl.classList.add('hidden');
        var items = (data.items || []).filter(function (it) {
          return it.id && it.id.videoId;
        });
        if (items.length === 0) {
          showError('No results.');
          return;
        }
        renderResults(items);
      })
      .catch(function (err) {
        loadingEl.classList.add('hidden');
        if (err.reason === 'quotaExceeded' || err.reason === 'dailyLimitExceeded') {
          showQuotaExceeded();
        } else if (err.reason === 'keyInvalid' || err.reason === 'API_KEY_INVALID') {
          showError('API key is invalid. Open Settings to update it.');
        } else if (err.reason === 'ipRefererBlocked' || err.reason === 'referrerBlocked') {
          showError('API key is restricted to a different site. Update its allowed origins.');
        } else {
          showError(err.message || 'Search failed');
        }
      });
  }

  function showQuotaExceeded() {
    var errorEl = document.getElementById('results-error');
    var msgEl = document.getElementById('results-error-message');
    if (isUsingEmbeddedKey()) {
      msgEl.innerHTML =
        'Today’s shared search limit has been reached.<br>' +
        'Add your own free key in Settings to keep searching — ' +
        'each personal key gets ~100 searches per day.';
    } else {
      msgEl.innerHTML =
        'You’ve hit today’s YouTube quota for your personal key.<br>' +
        'It resets at midnight Pacific time.';
    }
    errorEl.classList.remove('hidden');
    // Replace the default "Back" button with two: Settings and Back.
    var existing = errorEl.querySelector('.error-actions');
    if (existing) existing.remove();
    var actions = document.createElement('div');
    actions.className = 'error-actions';
    actions.innerHTML =
      '<button class="nav-item primary focusable" data-action="open-settings">Get your own key</button>' +
      '<button class="nav-item focusable" data-action="back">Back</button>';
    errorEl.appendChild(actions);
    // Hide the original single back button (it'll be in our actions row instead)
    var origBack = errorEl.querySelector(':scope > [data-action="back"]');
    if (origBack && origBack.tagName === 'BUTTON') origBack.classList.add('hidden');
    focusFirst(screens.results);
  }

  function showError(msg) {
    var errorEl = document.getElementById('results-error');
    document.getElementById('results-error-message').textContent = msg;
    errorEl.classList.remove('hidden');
    // Clear any quota-specific actions row from a prior error
    var prior = errorEl.querySelector('.error-actions');
    if (prior) prior.remove();
    var origBack = errorEl.querySelector(':scope > [data-action="back"]');
    if (origBack) origBack.classList.remove('hidden');
    focusFirst(screens.results);
  }

  function renderResults(items) {
    var listEl = document.getElementById('results-list');
    listEl.innerHTML = '';
    items.forEach(function (it) {
      var snip = it.snippet || {};
      var thumb = (snip.thumbnails && (snip.thumbnails.medium || snip.thumbnails.default)) || {};
      var btn = document.createElement('button');
      btn.className = 'list-item result-item focusable';
      btn.dataset.action = 'play-video';
      btn.dataset.videoId = it.id.videoId;
      btn.dataset.title = snip.title || '';
      btn.dataset.thumb = thumb.url || '';
      btn.innerHTML =
        '<img class="result-thumb" loading="lazy" alt="">' +
        '<div class="list-item-content">' +
          '<div class="result-title"></div>' +
          '<div class="result-channel"></div>' +
        '</div>';
      btn.querySelector('.result-thumb').src = thumb.url || '';
      btn.querySelector('.result-title').textContent = snip.title || '(untitled)';
      btn.querySelector('.result-channel').textContent = snip.channelTitle || '';
      listEl.appendChild(btn);
    });
    // Land focus on the first result (not the header back button) and scroll to top.
    var content = screens.results.querySelector('.content');
    if (content) content.scrollTop = 0;
    var firstResult = listEl.querySelector('.result-item');
    if (firstResult) {
      firstResult.focus();
      firstResult.scrollIntoView({ block: 'start' });
    } else {
      focusFirst(screens.results);
    }
  }

  // ==================== WATCH HISTORY ====================
  var HISTORY_MAX = 10;

  function pushHistory(videoId, title, thumb) {
    var h = state.data.history || [];
    // Remove dupe if already exists
    h = h.filter(function (e) { return e.id !== videoId; });
    h.unshift({ id: videoId, title: title || '', thumb: thumb || '', time: Date.now() });
    state.data.history = h.slice(0, HISTORY_MAX);
    saveData();
  }

  function renderHistory() {
    var listEl = document.getElementById('history-list');
    var labelEl = document.getElementById('history-label');
    if (!listEl || !labelEl) return;
    listEl.innerHTML = '';
    var h = state.data.history || [];
    if (h.length === 0) {
      labelEl.classList.add('hidden');
      listEl.classList.add('hidden');
      return;
    }
    labelEl.classList.remove('hidden');
    listEl.classList.remove('hidden');
    h.forEach(function (v) {
      var btn = document.createElement('button');
      btn.className = 'list-item result-item focusable';
      btn.dataset.action = 'play-video';
      btn.dataset.videoId = v.id;
      btn.dataset.title = v.title;
      btn.dataset.thumb = v.thumb || '';
      btn.innerHTML =
        '<img class="result-thumb" loading="lazy" alt="">' +
        '<div class="list-item-content">' +
          '<div class="result-title"></div>' +
        '</div>';
      if (v.thumb) btn.querySelector('.result-thumb').src = v.thumb;
      btn.querySelector('.result-title').textContent = v.title || v.id;
      listEl.appendChild(btn);
    });
  }

  // ==================== PLAYER ====================
  function playVideo(videoId, title, thumb, startSeconds) {
    pushHistory(videoId, title, thumb);
    state.currentVideo = {
      id: videoId, title: title, thumb: thumb || '', start: startSeconds || 0,
    };
    document.getElementById('player-title').textContent = title || '';
    navigateTo('player');
  }

  function mountPlayer() {
    if (!state.currentVideo) return;
    // Reset progress bar for new video
    document.getElementById('player-elapsed').textContent = '0:00';
    document.getElementById('player-duration').textContent = '0:00';
    document.getElementById('player-progress').style.width = '0%';

    var mount = document.getElementById('player-mount');
    mount.innerHTML = '<div id="yt-player"></div>';

    var playerVars = {
      autoplay: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      fs: 0,
      disablekb: 1,
      playsinline: 1,
    };
    var startAt = state.currentVideo.start;
    if (startAt && startAt > 0) playerVars.start = Math.floor(startAt);

    // Start immersive (controls hidden). State events reveal the bar on pause.
    controlsActive = false;
    var ctrls = document.getElementById('player-controls');
    if (ctrls) ctrls.classList.add('hidden');
    setPlayerHint('playing');

    var build = function () {
      state.player = new window.YT.Player('yt-player', {
        width: '600',
        height: '600',
        videoId: state.currentVideo.id,
        playerVars: playerVars,
        events: {
          onReady: function (e) {
            state.playerReady = true;
            try {
              var start = state.currentVideo && state.currentVideo.start;
              if (start && start > 0) e.target.seekTo(start, true);
              e.target.playVideo();
            } catch (_) {}
            startProgressTimer();
            scheduleHideOverlay();
            // If autoplay is blocked (no gesture), surface the controls so the
            // user has an obvious Play button instead of a frozen frame.
            setTimeout(function () {
              if (state.player && state.player.getPlayerState &&
                  state.player.getPlayerState() !== 1) {
                showPlayerControls();
              }
            }, 1500);
          },
          onStateChange: function (e) {
            // 1=playing, 2=paused, 0=ended, 3=buffering, 5=cued
            if (e.data === 1) {
              hidePlayerControls();
              hideOverlay();
            } else if (e.data === 2) {
              saveResumePoint();
              showPlayerControls();
            } else if (e.data === 0) {
              clearResumePoint();  // finished — nothing to resume
              showPlayerControls();
            }
            updatePlayPauseIcon();
          },
        },
      });
    };

    if (window.YT && window.YT.Player) {
      build();
    } else {
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') try { prev(); } catch (_) {}
        build();
      };
    }
  }

  function teardownPlayer() {
    saveResumePoint();  // capture where we left off while the player is still alive
    stopProgressTimer();
    state.playerReady = false;
    if (state.player && typeof state.player.destroy === 'function') {
      try { state.player.destroy(); } catch (_) {}
    }
    state.player = null;
    state.currentVideo = null;
    controlsActive = false;
    var ctrls = document.getElementById('player-controls');
    if (ctrls) ctrls.classList.add('hidden');
    var mount = document.getElementById('player-mount');
    if (mount) mount.innerHTML = '';
    clearTimeout(state.overlayTimer);
  }

  // ==================== PLAYER CONTROL BAR ====================
  // controlsActive = paused mode: the button bar is visible, swipes move
  // focus between buttons, tap activates. Immersive (playing): swipes seek.
  var controlsActive = false;

  function playerControlButtons() {
    return Array.prototype.slice.call(
      document.querySelectorAll('#player-controls .pc-btn'));
  }

  function showPlayerControls() {
    controlsActive = true;
    var ctrls = document.getElementById('player-controls');
    if (ctrls) ctrls.classList.remove('hidden');
    setPlayerHint('controls');
    showOverlay(true);
    updatePlayPauseIcon();
    // Default focus to play/pause if nothing in the bar is focused yet.
    var btns = playerControlButtons();
    if (btns.indexOf(document.activeElement) === -1) {
      var pp = document.getElementById('pc-playpause');
      if (pp) pp.focus();
    }
  }

  function hidePlayerControls() {
    controlsActive = false;
    var ctrls = document.getElementById('player-controls');
    if (ctrls) ctrls.classList.add('hidden');
    setPlayerHint('playing');
    var sink = document.getElementById('player-focus-sink');
    if (sink) sink.focus();
  }

  function moveControlFocus(dir) {
    var btns = playerControlButtons();
    if (!btns.length) return;
    var i = btns.indexOf(document.activeElement);
    if (i === -1) i = 0;
    else i = (i + dir + btns.length) % btns.length;
    btns[i].focus();
    showOverlay(true);
  }

  function updatePlayPauseIcon() {
    var ic = document.getElementById('pc-playpause-ic');
    if (!ic) return;
    var playing = state.player && state.player.getPlayerState &&
      state.player.getPlayerState() === 1;
    ic.textContent = playing ? '⏸' : '▶';  // ⏸ / ▶
  }

  function setPlayerHint(mode) {
    var h = document.getElementById('player-hint');
    if (!h) return;
    h.textContent = mode === 'controls'
      ? 'Swipe ◀ ▶ to choose · Tap to select'
      : 'Swipe ◀ ▶ to seek · Tap for controls';
  }

  function togglePlay() {
    if (!state.player || !state.playerReady) return;
    var s = state.player.getPlayerState && state.player.getPlayerState();
    // 1 = playing, 2 = paused, 3 = buffering, 5 = cued
    if (s === 1) state.player.pauseVideo();
    else state.player.playVideo();
    // Overlay show/hide is driven by onStateChange — don't double-toggle here.
  }

  function seekBy(delta) {
    if (!state.player || !state.playerReady) return;
    try {
      var t = state.player.getCurrentTime() + delta;
      state.player.seekTo(Math.max(0, t), true);
    } catch (_) {}
    showOverlay();
  }

  function adjustVolume(delta) {
    if (!state.player || !state.playerReady) return;
    try {
      var v = state.player.getVolume();
      state.player.setVolume(Math.max(0, Math.min(100, v + delta)));
    } catch (_) {}
    showOverlay();
  }

  // ==================== RESUME POINT ====================
  var lastResumeSave = 0;
  var RESUME_MAX_AGE = 7 * 24 * 60 * 60 * 1000;  // 7 days

  // Persist the current position so the app can resume here next launch.
  // Skips the very start (<5s) and the tail end (treats near-finish as done).
  function saveResumePoint() {
    if (!state.player || !state.playerReady || !state.currentVideo) return;
    try {
      var cur = state.player.getCurrentTime() || 0;
      var dur = state.player.getDuration() || 0;
      if (dur > 0 && cur >= dur - 15) { clearResumePoint(); return; }
      if (cur < 5) return;
      state.data.resume = {
        id: state.currentVideo.id,
        title: state.currentVideo.title || '',
        thumb: state.currentVideo.thumb || '',
        time: cur,
        dur: dur,
        savedAt: Date.now(),
      };
      lastResumeSave = Date.now();
      saveData();
    } catch (_) {}
  }

  function clearResumePoint() {
    if (state.data.resume) {
      state.data.resume = null;
      saveData();
    }
  }

  // Resume on launch only if there's a recent, valid, unfinished point.
  function shouldResume() {
    var r = state.data.resume;
    if (!r || !r.id || !r.time) return false;
    if (Date.now() - (r.savedAt || 0) > RESUME_MAX_AGE) return false;
    if (r.dur > 0 && r.time >= r.dur - 15) return false;
    return true;
  }

  // ==================== PROGRESS BAR ====================
  var progressInterval = null;

  function formatTime(seconds) {
    var s = Math.floor(seconds || 0);
    var m = Math.floor(s / 60);
    s = s % 60;
    var h = Math.floor(m / 60);
    m = m % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function updateProgress() {
    if (!state.player || !state.playerReady) return;
    try {
      var cur = state.player.getCurrentTime() || 0;
      var dur = state.player.getDuration() || 0;
      document.getElementById('player-elapsed').textContent = formatTime(cur);
      document.getElementById('player-duration').textContent = formatTime(dur);
      var pct = dur > 0 ? (cur / dur) * 100 : 0;
      document.getElementById('player-progress').style.width = pct + '%';
      // Throttled resume save (~every 5s) while actively playing.
      if (state.player.getPlayerState && state.player.getPlayerState() === 1 &&
          Date.now() - lastResumeSave > 5000) {
        saveResumePoint();
      }
    } catch (_) {}
  }

  function startProgressTimer() {
    stopProgressTimer();
    updateProgress();
    progressInterval = setInterval(updateProgress, 500);
  }

  function stopProgressTimer() {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  // showOverlay(persistent) — if persistent is true (e.g. paused/ended), the
  // overlay stays up. Otherwise it auto-hides after 3s (e.g. seek confirmation).
  function showOverlay(persistent) {
    var ov = document.getElementById('player-overlay');
    if (ov) ov.classList.remove('hidden-overlay');
    updateProgress();
    clearTimeout(state.overlayTimer);
    if (!persistent && !controlsActive) scheduleHideOverlay();
  }

  function hideOverlay() {
    // Never hide while the control bar is up — the user is choosing an action.
    if (controlsActive) return;
    clearTimeout(state.overlayTimer);
    var ov = document.getElementById('player-overlay');
    if (ov) ov.classList.add('hidden-overlay');
  }

  function scheduleHideOverlay() {
    clearTimeout(state.overlayTimer);
    state.overlayTimer = setTimeout(hideOverlay, 3000);
  }

  // ==================== VOICE SEARCH ====================
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceRecognition = null;

  function isVoiceSupported() {
    if (!SpeechRecognition) return false;
    try {
      if (localStorage.getItem('mdg_yt_voice_unsupported') === '1') return false;
    } catch (_) {}
    return true;
  }

  function applyVoiceSupportUI() {
    var micBtn = document.getElementById('mic-btn');
    if (!micBtn) return;
    micBtn.classList.toggle('hidden', !isVoiceSupported());
  }

  function startVoiceSearch() {
    if (!isVoiceSupported()) {
      showToast('Voice search not supported on this device');
      applyVoiceSupportUI();
      return;
    }
    var micBtn = document.getElementById('mic-btn');

    // If already listening, stop
    if (voiceRecognition) {
      voiceRecognition.abort();
      voiceRecognition = null;
      if (micBtn) micBtn.classList.remove('listening');
      return;
    }

    voiceRecognition = new SpeechRecognition();
    voiceRecognition.lang = 'en-US';
    voiceRecognition.interimResults = false;
    voiceRecognition.maxAlternatives = 1;

    if (micBtn) micBtn.classList.add('listening');

    voiceRecognition.onresult = function (event) {
      var transcript = event.results[0][0].transcript;
      document.getElementById('search-input').value = transcript;
      if (micBtn) micBtn.classList.remove('listening');
      voiceRecognition = null;
      runSearch(transcript);
    };

    voiceRecognition.onerror = function (event) {
      if (micBtn) micBtn.classList.remove('listening');
      voiceRecognition = null;
      if (event.error === 'no-speech') {
        showToast('No speech detected — try again');
      } else if (event.error === 'not-allowed') {
        showToast('Microphone access denied');
      } else if (event.error === 'service-not-allowed') {
        // The WebView has no speech service backend (typical on the glasses).
        // Hide the mic button for future visits and tell the user how to search.
        try { localStorage.setItem('mdg_yt_voice_unsupported', '1'); } catch (_) {}
        applyVoiceSupportUI();
        showToast('Voice not supported on this device — use ?q= URL param');
      } else if (event.error === 'audio-capture') {
        showToast('No microphone available');
      } else if (event.error === 'network') {
        showToast('Voice search needs internet');
      } else {
        showToast('Voice error: ' + event.error);
      }
    };

    voiceRecognition.onend = function () {
      if (micBtn) micBtn.classList.remove('listening');
      voiceRecognition = null;
    };

    voiceRecognition.start();
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast';
    toast.offsetHeight;
    toast.classList.add('visible');
    setTimeout(function () { toast.classList.remove('visible'); }, 3000);
  }

  function renderKeyStatus() {
    var el = document.getElementById('key-status');
    if (!el) return;
    el.className = 'key-status';
    var icon = '', label = '', detail = '';
    if (state.data.apiKey) {
      el.classList.add('personal');
      icon = '✓';
      label = 'Using your personal key';
      detail = 'Higher quota — ~100 searches/day just for you.';
    } else if (getEmbeddedApiKey()) {
      el.classList.add('shared');
      icon = '✱';
      label = 'Using the shared key';
      detail = 'Works out of the box. Quota is shared with all users — add your own below if it runs out.';
    } else {
      el.classList.add('none');
      icon = '⚠';
      label = 'No API key configured';
      detail = 'Paste a YouTube Data API v3 key below to enable search.';
    }
    el.innerHTML =
      '<div class="key-status-icon"></div>' +
      '<div class="key-status-text"><strong></strong><span></span></div>';
    el.querySelector('.key-status-icon').textContent = icon;
    el.querySelector('strong').textContent = label;
    el.querySelector('span').textContent = detail;
    // Show/hide Clear button based on whether a personal key exists.
    var clearBtn = document.getElementById('clear-apikey-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !state.data.apiKey);
  }

  // ==================== ON-SCREEN KEYBOARD ====================
  // 10x4 grid. Each cell is one focusable key for predictable D-pad 2D nav.
  // Row 3 last 3 cells are action keys: space, backspace, submit.
  var KB_ROWS = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l',"'"],
    ['z','x','c','v','b','n','m','SPACE','BACK','GO'],
  ];
  var kbBuffer = '';
  var kbRendered = false;

  function renderKeyboardGrid() {
    if (kbRendered) return;
    var grid = document.getElementById('kb-grid');
    if (!grid) return;
    grid.innerHTML = '';
    KB_ROWS.forEach(function (row, rIdx) {
      row.forEach(function (ch, cIdx) {
        var btn = document.createElement('button');
        btn.className = 'kb-key focusable';
        btn.dataset.row = rIdx;
        btn.dataset.col = cIdx;
        if (ch === 'SPACE') {
          btn.classList.add('kb-action');
          btn.textContent = '␣';
          btn.dataset.action = 'kb-space';
        } else if (ch === 'BACK') {
          btn.classList.add('kb-action');
          btn.textContent = '⌫';
          btn.dataset.action = 'kb-backspace';
        } else if (ch === 'GO') {
          btn.classList.add('kb-action', 'kb-submit');
          btn.textContent = '⏎';
          btn.dataset.action = 'kb-submit';
        } else {
          btn.textContent = ch;
          btn.dataset.action = 'kb-char';
          btn.dataset.char = ch;
        }
        grid.appendChild(btn);
      });
    });
    kbRendered = true;
  }

  function updateKbDisplay() {
    var txt = document.getElementById('kb-text');
    if (txt) txt.textContent = kbBuffer;
  }

  function openKeyboard() {
    var input = document.getElementById('search-input');
    kbBuffer = (input && input.value) || '';
    navigateTo('keyboard');
  }

  function kbAppend(ch) {
    if (kbBuffer.length >= 80) return;
    kbBuffer += ch;
    updateKbDisplay();
  }

  function kbBackspace() {
    kbBuffer = kbBuffer.slice(0, -1);
    updateKbDisplay();
  }

  function kbSubmit() {
    var q = kbBuffer.trim();
    if (!q) return;
    var input = document.getElementById('search-input');
    if (input) input.value = q;
    // Pop the keyboard from history so back from results goes to home, not kb.
    if (state.screenHistory[state.screenHistory.length - 1] === 'home') {
      state.screenHistory.pop();
      state.currentScreen = 'home';
    }
    runSearch(q);
  }

  function kbCancel() {
    kbBuffer = '';
    navigateBack();
  }

  function kbMoveFocus(direction) {
    var current = document.activeElement;
    var rows = KB_ROWS.length;
    var cols = KB_ROWS[0].length;
    var row, col;
    if (current && current.classList.contains('kb-key')) {
      row = parseInt(current.dataset.row, 10);
      col = parseInt(current.dataset.col, 10);
    } else {
      row = 0; col = 0;
    }
    if (direction === 'up')         row = (row - 1 + rows) % rows;
    else if (direction === 'down')  row = (row + 1) % rows;
    else if (direction === 'left')  col = (col - 1 + cols) % cols;
    else if (direction === 'right') col = (col + 1) % cols;
    var next = document.querySelector(
      '#kb-grid .kb-key[data-row="' + row + '"][data-col="' + col + '"]'
    );
    if (next) next.focus();
  }

  // ==================== MY YOUTUBE (API-key-only account data) ====================
  // No OAuth: reads PUBLIC channel data with the same API key used for search.
  //   - Uploads:       any channel's uploads playlist
  //   - Playlists:     the channel's public playlists
  //   - Subscriptions: only if the user set subscriptions to public
  var YT_API_BASE = 'https://www.googleapis.com/youtube/v3/';

  function ytApi(path, params) {
    var key = getEffectiveApiKey();
    if (!key) {
      var ek = new Error('No API key');
      ek.reason = 'noKey';
      return Promise.reject(ek);
    }
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var url = YT_API_BASE + path + '?' + qs + '&key=' + encodeURIComponent(key);
    return fetch(url).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var err = body && body.error;
          var reason = err && err.errors && err.errors[0] && err.errors[0].reason;
          var e = new Error((err && err.message) || ('HTTP ' + res.status));
          e.reason = reason || '';
          e.status = res.status;
          throw e;
        }, function () {
          var e = new Error('HTTP ' + res.status);
          e.status = res.status;
          throw e;
        });
      }
      return res.json();
    });
  }

  function thumbOf(sn) {
    var t = sn && sn.thumbnails;
    if (!t) return '';
    return ((t.medium || t.high || t.default) || {}).url || '';
  }

  function mapPlaylistItem(it) {
    var sn = it.snippet || {};
    var rid = sn.resourceId || {};
    if (!rid.videoId) return null;
    if (sn.title === 'Private video' || sn.title === 'Deleted video') return null;
    return {
      type: 'video',
      videoId: rid.videoId,
      title: sn.title || '',
      channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle || '',
      thumb: thumbOf(sn),
    };
  }

  // Resolve a channel ID -> { title, uploads playlist id }, cached.
  function resolveChannel(id) {
    if (state.mine.channelCache[id]) return Promise.resolve(state.mine.channelCache[id]);
    return ytApi('channels', { part: 'snippet,contentDetails', id: id }).then(function (data) {
      var it = (data.items || [])[0];
      if (!it) throw new Error('Channel not found');
      var info = {
        title: (it.snippet && it.snippet.title) || '',
        uploads: (it.contentDetails && it.contentDetails.relatedPlaylists &&
                  it.contentDetails.relatedPlaylists.uploads) || '',
      };
      state.mine.channelCache[id] = info;
      return info;
    });
  }

  // --- Loaders (each returns a Promise of a normalized item array) ---
  function loadUploads() {
    return resolveChannel(state.data.channelId).then(function (ch) {
      if (!ch.uploads) return [];
      return ytApi('playlistItems', { part: 'snippet', maxResults: 25, playlistId: ch.uploads })
        .then(function (d) { return (d.items || []).map(mapPlaylistItem).filter(Boolean); });
    });
  }
  function loadPlaylistVideos(pid) {
    return ytApi('playlistItems', { part: 'snippet', maxResults: 25, playlistId: pid })
      .then(function (d) { return (d.items || []).map(mapPlaylistItem).filter(Boolean); });
  }
  function loadChannelUploads(cid) {
    return resolveChannel(cid).then(function (ch) {
      if (!ch.uploads) return [];
      return ytApi('playlistItems', { part: 'snippet', maxResults: 25, playlistId: ch.uploads })
        .then(function (d) { return (d.items || []).map(mapPlaylistItem).filter(Boolean); });
    });
  }
  function loadPlaylists() {
    return ytApi('playlists', { part: 'snippet,contentDetails', maxResults: 25, channelId: state.data.channelId })
      .then(function (d) {
        return (d.items || []).map(function (p) {
          var sn = p.snippet || {};
          return {
            type: 'playlist',
            id: p.id,
            title: sn.title || '',
            count: (p.contentDetails && p.contentDetails.itemCount),
            thumb: thumbOf(sn),
          };
        });
      });
  }
  function loadSubscriptions() {
    return ytApi('subscriptions', {
      part: 'snippet', maxResults: 25, channelId: state.data.channelId, order: 'alphabetical',
    }).then(function (d) {
      return (d.items || []).map(function (s) {
        var sn = s.snippet || {};
        var rid = sn.resourceId || {};
        return { type: 'channel', id: rid.channelId || '', title: sn.title || '', thumb: thumbOf(sn) };
      });
    });
  }

  // --- DOM builders ---
  function makeVideoButton(videoId, title, channelTitle, thumb) {
    if (!videoId) return null;
    var btn = document.createElement('button');
    btn.className = 'list-item result-item focusable';
    btn.dataset.action = 'play-video';
    btn.dataset.videoId = videoId;
    btn.dataset.title = title || '';
    btn.dataset.thumb = thumb || '';
    btn.innerHTML =
      '<img class="result-thumb" loading="lazy" alt="">' +
      '<div class="list-item-content">' +
        '<div class="result-title"></div>' +
        '<div class="result-channel"></div>' +
      '</div>';
    btn.querySelector('.result-thumb').src = thumb || '';
    btn.querySelector('.result-title').textContent = title || '(untitled)';
    btn.querySelector('.result-channel').textContent = channelTitle || '';
    return btn;
  }
  function makeRowButton(action, data, thumb, icon, title, meta) {
    var btn = document.createElement('button');
    btn.className = 'list-item focusable';
    btn.dataset.action = action;
    Object.keys(data).forEach(function (k) { btn.dataset[k] = data[k]; });
    btn.innerHTML =
      (thumb ? '<img class="row-thumb" loading="lazy" alt="">' : '<span class="list-item-icon"></span>') +
      '<div class="list-item-content">' +
        '<span class="list-item-title"></span>' +
        (meta ? '<span class="list-item-meta"></span>' : '') +
      '</div>';
    if (thumb) btn.querySelector('.row-thumb').src = thumb;
    else btn.querySelector('.list-item-icon').textContent = icon;
    btn.querySelector('.list-item-title').textContent = title || '';
    if (meta) btn.querySelector('.list-item-meta').textContent = meta;
    return btn;
  }

  function renderMineItems(listEl, items) {
    listEl.innerHTML = '';
    items.forEach(function (it) {
      var btn = null;
      if (it.type === 'video') {
        btn = makeVideoButton(it.videoId, it.title, it.channelTitle, it.thumb);
      } else if (it.type === 'playlist') {
        btn = makeRowButton('open-playlist', { playlistId: it.id, title: it.title },
          it.thumb, '☰', it.title, (it.count != null ? it.count + ' videos' : ''));
      } else if (it.type === 'channel') {
        btn = makeRowButton('open-channel', { channelId: it.id, title: it.title },
          it.thumb, '▶', it.title, '');
      }
      if (btn) listEl.appendChild(btn);
    });
  }

  // --- Hub ---
  function renderMineHub() {
    var noId = document.getElementById('mine-no-id');
    var menu = document.getElementById('mine-menu');
    var nameEl = document.getElementById('mine-channel-name');
    if (!state.data.channelId) {
      noId.classList.remove('hidden');
      menu.classList.add('hidden');
      return;
    }
    noId.classList.add('hidden');
    menu.classList.remove('hidden');
    nameEl.textContent = 'Loading…';
    resolveChannel(state.data.channelId).then(function (ch) {
      nameEl.textContent = ch.title || '';
    }).catch(function () { nameEl.textContent = ''; });
  }

  // --- Generic level-1 / level-2 list rendering ---
  // prefix is 'mine-list' or 'mine-sub'; d is the view descriptor:
  //   { title, items (null until loaded), loader }
  function enterMineScreen(prefix, d) {
    var titleEl = document.getElementById(prefix + '-title');
    var loadingEl = document.getElementById(prefix + '-loading');
    var errorEl = document.getElementById(prefix + '-error');
    var listEl = document.getElementById(prefix + '-items');
    if (!d) { return; }
    titleEl.textContent = d.title || 'My YouTube';
    errorEl.classList.add('hidden');

    function paint(items) {
      loadingEl.classList.add('hidden');
      if (!items.length) { showMineErr(prefix, 'Nothing here yet.'); return; }
      renderMineItems(listEl, items);
      var content = screens[prefix].querySelector('.content');
      if (content) content.scrollTop = 0;
      var first = listEl.querySelector('.focusable');
      if (first) { first.focus(); first.scrollIntoView({ block: 'start' }); }
    }

    if (d.items) { loadingEl.classList.add('hidden'); paint(d.items); return; }
    loadingEl.classList.remove('hidden');
    listEl.innerHTML = '';
    d.loader().then(function (items) {
      d.items = items;
      paint(items);
    }).catch(function (err) {
      loadingEl.classList.add('hidden');
      handleMineError(prefix, err);
    });
  }

  function showMineErr(prefix, msg) {
    var errorEl = document.getElementById(prefix + '-error');
    document.getElementById(prefix + '-error-message').textContent = msg;
    errorEl.classList.remove('hidden');
    focusFirst(screens[prefix]);
  }

  function handleMineError(prefix, err) {
    var msg;
    if (err.reason === 'quotaExceeded' || err.reason === 'dailyLimitExceeded') {
      msg = isUsingEmbeddedKey()
        ? 'Shared daily limit reached. Add your own key in Settings.'
        : 'Daily quota reached. Resets at midnight Pacific time.';
    } else if (err.reason === 'subscriptionForbidden') {
      msg = 'Your subscriptions are private. In YouTube: Settings → Privacy → ' +
            'turn off "Keep all my subscriptions private".';
    } else if (err.reason === 'playlistNotFound' || err.reason === 'playlistItemsNotAccessible') {
      msg = "That playlist isn't public.";
    } else if (err.reason === 'keyInvalid') {
      msg = 'API key is invalid. Update it in Settings.';
    } else if (err.message === 'Channel not found') {
      msg = 'Channel not found. Check the channel ID in Settings.';
    } else {
      msg = err.message || 'Could not load.';
    }
    showMineErr(prefix, msg);
  }

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back': navigateBack(); break;
      case 'open-settings': navigateTo('settings'); break;
      case 'run-search': {
        var input = document.getElementById('search-input');
        if (!input.value.trim()) {
          openKeyboard();
        } else {
          runSearch(input.value);
        }
        break;
      }
      case 'preset-search': {
        var q = element.dataset.query || '';
        document.getElementById('search-input').value = q;
        runSearch(q);
        break;
      }
      case 'play-video': {
        playVideo(element.dataset.videoId, element.dataset.title, element.dataset.thumb || '');
        break;
      }
      case 'save-apikey': {
        var v = document.getElementById('apikey-input').value.trim();
        if (!v) return;
        state.data.apiKey = v;
        saveData();
        // If no history (first visit → settings), go home; otherwise go back
        if (state.screenHistory.length > 0) {
          navigateBack();
        } else {
          navigateTo('home', { addToHistory: false });
        }
        break;
      }
      case 'clear-apikey': {
        state.data.apiKey = '';
        saveData();
        document.getElementById('apikey-input').value = '';
        renderKeyStatus();
        showToast('Personal key removed — using shared key');
        break;
      }
      case 'save-channelid': {
        var cv = document.getElementById('channelid-input').value.trim();
        if (!cv) return;
        state.data.channelId = cv;
        state.mine.channelCache = {};   // invalidate cached resolution
        saveData();
        showToast('Channel saved');
        navigateTo('mine');
        break;
      }
      case 'clear-channelid': {
        state.data.channelId = '';
        state.mine.channelCache = {};
        saveData();
        document.getElementById('channelid-input').value = '';
        showToast('Channel removed');
        break;
      }
      case 'open-mine': navigateTo('mine'); break;
      case 'mine-uploads':
        state.mineList = { title: 'My Uploads', items: null, loader: loadUploads };
        navigateTo('mine-list');
        break;
      case 'mine-playlists':
        state.mineList = { title: 'My Playlists', items: null, loader: loadPlaylists };
        navigateTo('mine-list');
        break;
      case 'mine-subs':
        state.mineList = { title: 'Subscriptions', items: null, loader: loadSubscriptions };
        navigateTo('mine-list');
        break;
      case 'open-playlist': {
        var pid = element.dataset.playlistId;
        var ptitle = element.dataset.title || 'Playlist';
        state.mineSub = { title: ptitle, items: null, loader: function () { return loadPlaylistVideos(pid); } };
        navigateTo('mine-sub');
        break;
      }
      case 'open-channel': {
        var cid = element.dataset.channelId;
        var ctitle = element.dataset.title || 'Channel';
        state.mineSub = { title: ctitle, items: null, loader: function () { return loadChannelUploads(cid); } };
        navigateTo('mine-sub');
        break;
      }
      case 'voice-search': startVoiceSearch(); break;
      case 'toggle-play': togglePlay(); break;
      case 'seek-back': seekBy(-10); break;
      case 'seek-fwd': seekBy(10); break;
      case 'open-keyboard': openKeyboard(); break;
      case 'kb-char': kbAppend(element.dataset.char || ''); break;
      case 'kb-space': kbAppend(' '); break;
      case 'kb-backspace': kbBackspace(); break;
      case 'kb-submit': kbSubmit(); break;
      case 'kb-cancel': kbCancel(); break;
    }
  }

  function onScreenEnter(screenId) {
    if (screenId === 'home') {
      renderRecent();
      renderHistory();
    } else if (screenId === 'settings') {
      document.getElementById('apikey-input').value = state.data.apiKey || '';
      document.getElementById('channelid-input').value = state.data.channelId || '';
      renderKeyStatus();
    } else if (screenId === 'mine') {
      renderMineHub();
    } else if (screenId === 'mine-list') {
      enterMineScreen('mine-list', state.mineList);
    } else if (screenId === 'mine-sub') {
      enterMineScreen('mine-sub', state.mineSub);
    } else if (screenId === 'player') {
      mountPlayer();
      // Route key events to our handler, not the iframe
      setTimeout(function () {
        var sink = document.getElementById('player-focus-sink');
        if (sink) sink.focus();
      }, 50);
    } else if (screenId === 'keyboard') {
      renderKeyboardGrid();
      updateKbDisplay();
      // Focus a sensible starting key (q) so typing feels natural
      setTimeout(function () {
        var start = document.querySelector('#kb-grid .kb-key[data-row="1"][data-col="0"]');
        if (start) start.focus();
      }, 30);
    }
  }

  // ==================== EVENTS ====================
  function setupEvents() {
    document.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function (e) {
      // Player screen: D-pad navigates between the "video" (focus-sink) and
      // the back chip. Left/right = seek. Enter activates whatever is focused.
      if (state.currentScreen === 'player') {
        switch (e.key) {
          case 'ArrowLeft':
            // Paused: move between control buttons. Playing: rewind.
            if (controlsActive) moveControlFocus(-1);
            else seekBy(-10);
            e.preventDefault();
            return;
          case 'ArrowRight':
            if (controlsActive) moveControlFocus(1);
            else seekBy(10);
            e.preventDefault();
            return;
          case 'ArrowUp':
          case 'ArrowDown':
            // Either vertical swipe summons the control bar (pausing the video),
            // so Back and the other buttons are always reachable.
            if (!controlsActive) togglePlay();
            e.preventDefault();
            return;
          case ' ':
          case 'Enter':
            if (controlsActive) {
              // Activate the focused control button (play/pause, seek, or back).
              var btn = document.activeElement;
              if (btn && btn.classList.contains('pc-btn')) btn.click();
              else togglePlay();
            } else {
              // Immersive tap → pause and reveal the controls.
              togglePlay();
            }
            e.preventDefault();
            return;
          case 'Escape':
            navigateBack();
            e.preventDefault();
            return;
        }
        return;
      }

      // On the keyboard screen, arrows do 2D grid nav.
      if (state.currentScreen === 'keyboard') {
        switch (e.key) {
          case 'ArrowUp':    kbMoveFocus('up');    e.preventDefault(); return;
          case 'ArrowDown':  kbMoveFocus('down');  e.preventDefault(); return;
          case 'ArrowLeft':  kbMoveFocus('left');  e.preventDefault(); return;
          case 'ArrowRight': kbMoveFocus('right'); e.preventDefault(); return;
          case 'Backspace':  kbBackspace(); e.preventDefault(); return;
          case 'Enter': {
            // If focus is on a key button, click it (handled by default below).
            var ae2 = document.activeElement;
            if (ae2 && ae2.classList.contains('kb-key')) {
              ae2.click();
              e.preventDefault();
              return;
            }
            // Fallback: submit the current buffer
            kbSubmit();
            e.preventDefault();
            return;
          }
          case 'Escape': kbCancel(); e.preventDefault(); return;
        }
        // Allow physical keyboard typing to work on desktop while keyboard screen is open
        if (e.key.length === 1 && /^[\w\d\s'.,!?-]$/.test(e.key)) {
          kbAppend(e.key.toLowerCase());
          e.preventDefault();
          return;
        }
        return;
      }

      // Other screens: text inputs still type letters, but arrows always
      // navigate (so you can swipe right off the search field to Go/keyboard/mic
      // and swipe down past the whole search row to the content).
      var ae = document.activeElement;
      var isInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      if (isInput && !['Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

      switch (e.key) {
        case 'ArrowUp':    moveFocus('up');    e.preventDefault(); break;
        case 'ArrowDown':  moveFocus('down');  e.preventDefault(); break;
        case 'ArrowLeft':  moveFocus('left');  e.preventDefault(); break;
        case 'ArrowRight': moveFocus('right'); e.preventDefault(); break;
        case 'Enter':
          if (isInput && ae.dataset.submitAction) {
            handleAction(ae.dataset.submitAction, ae);
          } else if (ae && ae.classList.contains('focusable')) {
            ae.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          navigateBack();
          e.preventDefault();
          break;
      }
    });
  }

  // ==================== URL PARAM BOOTSTRAP ====================
  // Supported params (stripped from URL after first read):
  //   ?key=AIza...    YouTube Data API key, saved to localStorage
  //   ?channel=UC...  your channel ID for the My YouTube tab, saved
  //   ?q=lofi+beats   one-shot search run on load (NOT saved)
  // Example URL to register on the glasses (no typing required):
  //   https://youtube-viewer.onrender.com?key=AIza...&channel=UC...
  var pendingQuery = null;
  function bootstrapFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var changed = false;
      var urlKey = params.get('key');
      if (urlKey && urlKey.length > 10) {
        state.data.apiKey = urlKey;
        params.delete('key');
        changed = true;
      }
      var urlChannel = params.get('channel');
      if (urlChannel && urlChannel.length > 6) {
        state.data.channelId = urlChannel;
        params.delete('channel');
        changed = true;
      }
      var urlQuery = params.get('q');
      if (urlQuery && urlQuery.trim()) {
        pendingQuery = urlQuery.trim();
        params.delete('q');
        changed = true;
      }
      if (changed) {
        saveData();
        if (window.history && window.history.replaceState) {
          var clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
          window.history.replaceState(null, '', clean);
        }
      }
    } catch (_) {}
  }

  // ==================== INIT ====================
  function init() {
    collectScreens();
    setupEvents();
    loadData();
    bootstrapFromUrl();
    setTimeout(function () {
      if (!getEffectiveApiKey()) {
        // No personal key and no embedded shared key -> force setup.
        navigateTo('settings', { addToHistory: false });
      } else if (pendingQuery) {
        navigateTo('home', { addToHistory: false });
        runSearch(pendingQuery);
        pendingQuery = null;
      } else if (shouldResume()) {
        // Resume the last in-progress video at its saved spot. Home is the
        // base screen so the back gesture from the player lands there.
        navigateTo('home', { addToHistory: false });
        var r = state.data.resume;
        playVideo(r.id, r.title, r.thumb, r.time);
      } else {
        navigateTo('home', { addToHistory: false });
      }
      applyVoiceSupportUI();
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
