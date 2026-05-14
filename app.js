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

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    data: {
      apiKey: '',
      recent: [],
      history: [],   // { id, title, thumb, time }
    },
    cache: {},
    player: null,
    playerReady: false,
    currentVideo: null,
    overlayTimer: null,
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
  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;
    var focusables = Array.from(
      container.querySelectorAll('.focusable:not([disabled]):not(.hidden)')
    );
    if (focusables.length === 0) return;
    var idx = focusables.indexOf(document.activeElement);
    if (idx === -1) { focusFirst(container); return; }
    var nextIdx;
    if (direction === 'up' || direction === 'left') {
      nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[nextIdx].focus();
    focusables[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    if (!state.data.apiKey) {
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
      '&key=' + encodeURIComponent(state.data.apiKey);

    fetch(url)
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            var msg = (body && body.error && body.error.message) || ('HTTP ' + res.status);
            throw new Error(msg);
          }, function () { throw new Error('HTTP ' + res.status); });
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
        showError(err.message || 'Search failed');
      });
  }

  function showError(msg) {
    var errorEl = document.getElementById('results-error');
    document.getElementById('results-error-message').textContent = msg;
    errorEl.classList.remove('hidden');
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
    focusFirst(screens.results);
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
  function playVideo(videoId, title, thumb) {
    pushHistory(videoId, title, thumb);
    state.currentVideo = { id: videoId, title: title };
    document.getElementById('player-title').textContent = title || '';
    navigateTo('player');
  }

  function mountPlayer() {
    if (!state.currentVideo) return;
    var mount = document.getElementById('player-mount');
    mount.innerHTML = '<div id="yt-player"></div>';

    var build = function () {
      state.player = new window.YT.Player('yt-player', {
        width: '600',
        height: '600',
        videoId: state.currentVideo.id,
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          fs: 0,
          disablekb: 1,
          playsinline: 1,
        },
        events: {
          onReady: function (e) {
            state.playerReady = true;
            try { e.target.playVideo(); } catch (_) {}
            startProgressTimer();
            scheduleHideOverlay();
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
    stopProgressTimer();
    state.playerReady = false;
    if (state.player && typeof state.player.destroy === 'function') {
      try { state.player.destroy(); } catch (_) {}
    }
    state.player = null;
    state.currentVideo = null;
    var mount = document.getElementById('player-mount');
    if (mount) mount.innerHTML = '';
    clearTimeout(state.overlayTimer);
    showOverlay();
  }

  function togglePlay() {
    if (!state.player || !state.playerReady) return;
    var s = state.player.getPlayerState && state.player.getPlayerState();
    // 1 = playing, 2 = paused, 3 = buffering, 5 = cued
    if (s === 1) state.player.pauseVideo();
    else state.player.playVideo();
    showOverlay();
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

  function showOverlay() {
    var ov = document.getElementById('player-overlay');
    if (!ov) return;
    ov.classList.remove('hidden-overlay');
    scheduleHideOverlay();
    updateProgress();
  }

  function scheduleHideOverlay() {
    clearTimeout(state.overlayTimer);
    state.overlayTimer = setTimeout(function () {
      var ov = document.getElementById('player-overlay');
      if (ov) ov.classList.add('hidden-overlay');
    }, 3000);
  }

  // ==================== VOICE SEARCH ====================
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceRecognition = null;

  function startVoiceSearch() {
    if (!SpeechRecognition) {
      showToast('Voice search not supported on this device');
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

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back': navigateBack(); break;
      case 'open-settings': navigateTo('settings'); break;
      case 'run-search': {
        var input = document.getElementById('search-input');
        runSearch(input.value);
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
        navigateBack();
        break;
      }
      case 'voice-search': startVoiceSearch(); break;
      case 'toggle-play': togglePlay(); break;
    }
  }

  function onScreenEnter(screenId) {
    if (screenId === 'home') {
      renderRecent();
      renderHistory();
    } else if (screenId === 'settings') {
      var input = document.getElementById('apikey-input');
      input.value = state.data.apiKey || '';
    } else if (screenId === 'player') {
      mountPlayer();
      // Route key events to our handler, not the iframe
      setTimeout(function () {
        var sink = document.getElementById('player-focus-sink');
        if (sink) sink.focus();
      }, 50);
    }
  }

  // ==================== EVENTS ====================
  function setupEvents() {
    document.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function (e) {
      // On the player screen, intercept everything regardless of focus.
      if (state.currentScreen === 'player') {
        switch (e.key) {
          case 'ArrowLeft':  seekBy(-10); e.preventDefault(); return;
          case 'ArrowRight': seekBy(10);  e.preventDefault(); return;
          case 'ArrowUp':    adjustVolume(10);  e.preventDefault(); return;
          case 'ArrowDown':  adjustVolume(-10); e.preventDefault(); return;
          case ' ':
          case 'Enter':      togglePlay(); e.preventDefault(); return;
          case 'Escape':     navigateBack(); e.preventDefault(); return;
        }
        return;
      }

      // Other screens: text inputs swallow most keys.
      var ae = document.activeElement;
      var isInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      if (isInput && !['Escape', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;

      switch (e.key) {
        case 'ArrowUp':    moveFocus('up');    e.preventDefault(); break;
        case 'ArrowDown':  moveFocus('down');  e.preventDefault(); break;
        case 'ArrowLeft':
          if (!isInput) { moveFocus('left'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (!isInput) { moveFocus('right'); e.preventDefault(); }
          break;
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
  // Allows passing the API key via URL so you never have to type it on-device:
  //   https://youtube-viewer.onrender.com?key=AIza...
  // The key is saved to localStorage on first visit, then the param is stripped.
  function bootstrapFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var urlKey = params.get('key');
      if (urlKey && urlKey.length > 10) {
        state.data.apiKey = urlKey;
        saveData();
        // Strip the key from the address bar so it isn't visible / bookmarked
        if (window.history && window.history.replaceState) {
          params.delete('key');
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
      if (!state.data.apiKey) {
        navigateTo('settings', { addToHistory: false });
      } else {
        navigateTo('home', { addToHistory: false });
      }
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
