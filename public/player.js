const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "signal_screen_id";
const CACHE_KEY = "signal_player_cache";

let screenId = null;
let currentPlaylistId;
let slides = [];
let ticker = [];
let screenName = "";
let offline = false;

/* ---------- local cache ----------
   Keeps the screen showing its last-known content through a network drop
   or a full reboot, instead of going blank or bouncing back to the pairing
   screen just because the server was briefly unreachable. */

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      screenId, screenName, playlistId: currentPlaylistId || null,
      slides, ticker, current, savedAt: Date.now()
    }));
  } catch (e) { /* storage unavailable — playback still works, just won't survive an offline reload */ }
}

function setOffline(value) {
  if (offline === value) return;
  offline = value;
  $("conn-badge").hidden = !offline;
}

/* ---------- boot: figure out which screen this device is ---------- */

async function boot() {
  const savedId = safeGet(STORAGE_KEY);
  if (!savedId) { showPairing(); return; }

  screenId = savedId;

  // Restore last-known content immediately, before we've even checked in
  // with the server — so a reboot on a flaky connection still shows
  // something right away instead of a blank screen.
  const cached = loadCache();
  if (cached && cached.screenId === savedId) {
    screenName = cached.screenName || "";
    currentPlaylistId = cached.playlistId;
    slides = cached.slides || [];
    ticker = cached.ticker || [];
    $("pairing-screen").hidden = true;
    if (slides.length) {
      $("waiting-screen").hidden = true;
      $("app").hidden = false;
      renderSlideshow();
      renderTicker();
      goTo(cached.current || 0);
    } else {
      $("waiting-screen-name").textContent = screenName;
      $("waiting-screen").hidden = false;
      $("app").hidden = true;
    }
  } else {
    // No cache yet (first-ever boot on this device) — we know we're
    // paired, just don't have anything to show yet, so say so rather
    // than looking blank or reverting to the pairing form.
    $("pairing-screen").hidden = true;
    $("waiting-message").textContent = "Connecting to the server for the first time…";
    $("waiting-screen").hidden = false;
    $("app").hidden = true;
  }

  connectScreen(savedId);
}

function showPairing() {
  stopAllMedia();
  $("pairing-screen").hidden = false;
  $("waiting-screen").hidden = true;
  $("app").hidden = true;
}

$("pairing-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("pairing-code-input").value.trim().toUpperCase();
  const errorEl = $("pairing-error");
  errorEl.hidden = true;

  try {
    const res = await fetch("/api/screens/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) {
      errorEl.textContent = "No screen matches that code. Double-check it in the dashboard.";
      errorEl.hidden = false;
      return;
    }
    const screen = await res.json();
    safeSet(STORAGE_KEY, screen.id);
    connectScreen(screen.id);
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server. Check the connection and try again.";
    errorEl.hidden = false;
  }
});

function connectScreen(id) {
  screenId = id;
  $("pairing-screen").hidden = true;

  sendHeartbeat();
  setInterval(sendHeartbeat, 25000);
  setInterval(refreshScreen, 30000); // safety net alongside the SSE stream below

  refreshScreen();

  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch (err) { return; }
    if (payload.resource === "screens" && (payload.id === screenId || payload.id === null)) {
      refreshScreen();
    }
    if (payload.resource === "playlists" && currentPlaylistId && (payload.id === currentPlaylistId || payload.id === null)) {
      refreshPlaylist();
    }
  };
}

async function refreshScreen() {
  if (!screenId) return;
  try {
    const res = await fetch("/api/screens/" + screenId);
    if (!res.ok) {
      // A real 404 means this screen was actually deleted from the admin
      // dashboard — that's the one case where forgetting it is correct.
      safeRemove(STORAGE_KEY);
      try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
      showPairing();
      return;
    }
    setOffline(false);
    const data = await res.json();
    screenName = data.name || "";
    $("waiting-screen-name").textContent = screenName;

    if (data.playlist_id !== currentPlaylistId) {
      currentPlaylistId = data.playlist_id || null;
      if (!currentPlaylistId) {
        slides = []; ticker = [];
        saveCache();
        stopAllMedia();
        $("waiting-message").textContent = "This screen is paired. Assign it a playlist from the dashboard's Screens tab to start playback.";
        $("waiting-screen").hidden = false;
        $("app").hidden = true;
        return;
      }
      refreshPlaylist();
    } else {
      saveCache();
    }
  } catch (e) {
    // Network unreachable — a real problem worth surfacing quietly, but
    // NOT a reason to forget pairing or stop showing whatever we've got.
    setOffline(true);
  }
}

async function refreshPlaylist() {
  if (!currentPlaylistId) return;
  try {
    const res = await fetch("/api/playlists/" + currentPlaylistId);
    setOffline(false);
    if (!res.ok) {
      slides = []; ticker = [];
      saveCache();
      stopAllMedia();
      $("waiting-message").textContent = "This screen is paired. Assign it a playlist from the dashboard's Screens tab to start playback.";
      $("waiting-screen").hidden = false;
      $("app").hidden = true;
      return;
    }
    const data = await res.json();
    slides = data.items || [];
    ticker = data.ticker || [];

    if (!slides.length) {
      saveCache();
      stopAllMedia();
      $("waiting-message").textContent = "This screen is paired. Assign it a playlist from the dashboard's Screens tab to start playback.";
      $("waiting-screen").hidden = false;
      $("app").hidden = true;
      return;
    }
    $("waiting-screen").hidden = true;
    $("app").hidden = false;
    renderSlideshow();
    renderTicker();
    goTo(0);
    saveCache();
  } catch (e) {
    setOffline(true);
  }
}

function sendHeartbeat() {
  if (!screenId) return;
  fetch("/api/screens/" + screenId + "/heartbeat", { method: "POST" }).catch(() => {});
}

function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
function safeRemove(key) { try { localStorage.removeItem(key); } catch (e) {} }

/* ================= RENDERING ENGINE ================= */

let current = 0;
let timer = null;
let segmentEls = [];

function stopAllMedia() {
  // Removing/hiding these elements alone doesn't reliably stop playback —
  // browsers can keep audio going in the background regardless. Call this
  // before every transition away from the active slideshow.
  document.querySelectorAll("#slideshow video, #slideshow audio").forEach((el) => {
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch (e) { /* element already gone or in a bad state — nothing more to do */ }
  });
}

function renderSlideshow() {
  const slideshow = $("slideshow");
  const segments = $("segments");

  stopAllMedia();

  slideshow.innerHTML = "";
  segments.innerHTML = "";
  segmentEls = [];

  slides.forEach((slide) => {
    const node = document.createElement("div");
    node.className = "slide type-" + slide.type;
    node.style.setProperty("--slide-accent", slide.accent || "#f5a623");
    node.style.setProperty("--slide-accent-soft", hexToSoft(slide.accent));

    if ((slide.type === "image" || slide.type === "video") && slide.url) {
      const media = slide.type === "video" ? document.createElement("video") : document.createElement("img");
      media.className = "slide-media";
      media.src = slide.url;
      if (slide.type === "video") {
        media.loop = true;
        media.playsInline = true;
        const isMuted = slide.muted !== false; // treat missing/undefined as muted, matching prior behavior
        media.muted = isMuted;
        if (isMuted) {
          media.autoplay = true; // browsers freely autoplay muted video, no gesture needed
        } else {
          media.classList.add("needs-play-lifecycle"); // has its own audio — only plays while its slide is active
        }
      }
      if (slide.type === "image") media.alt = slide.title || "";
      node.appendChild(media);
      const gradient = document.createElement("div");
      gradient.className = "slide-gradient";
      node.appendChild(gradient);

      // Optional voiceover track — plays alongside an image or video slide,
      // independent of that slide's own audio.
      if (slide.voiceoverUrl) {
        const voiceoverEl = document.createElement("audio");
        voiceoverEl.className = "needs-play-lifecycle";
        voiceoverEl.src = slide.voiceoverUrl;
        voiceoverEl.loop = true;
        voiceoverEl.preload = "auto";
        node.appendChild(voiceoverEl);
      }
    }

    if (slide.type === "audio" && slide.url) {
      const audioEl = document.createElement("audio");
      audioEl.className = "needs-play-lifecycle";
      audioEl.src = slide.url;
      audioEl.loop = true;
      audioEl.preload = "auto";
      node.appendChild(audioEl);
    }

    const content = document.createElement("div");
    content.className = "slide-content";
    content.innerHTML =
      (slide.type === "audio"
        ? '<div class="audio-visual"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>'
        : "") +
      '<div class="slide-eyebrow">' + labelForType(slide.type) + "</div>" +
      '<h1 class="slide-title"></h1>' +
      '<p class="slide-body"></p>';
    content.querySelector(".slide-title").textContent = slide.title || "";
    content.querySelector(".slide-body").textContent = slide.body || "";
    node.appendChild(content);

    slideshow.appendChild(node);

    const seg = document.createElement("div");
    seg.className = "segment";
    const fill = document.createElement("div");
    fill.className = "segment-fill";
    seg.appendChild(fill);
    segments.appendChild(seg);
    segmentEls.push(seg);
  });

  if (current >= slides.length) current = 0;
}

function labelForType(type) {
  if (type === "image") return "Notice";
  if (type === "video") return "Now playing";
  if (type === "audio") return "Now playing";
  return "Announcement";
}

function hexToSoft(hex) {
  if (!hex) return "rgba(245,166,35,0.16)";
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if ([r, g, b].some(isNaN)) return "rgba(245,166,35,0.16)";
  return "rgba(" + r + "," + g + "," + b + ",0.18)";
}

function attemptPlay(mediaEl) {
  const p = mediaEl.play();
  if (p && p.catch) {
    p.catch(() => {
      // Autoplay-with-sound was blocked. Falling back to muted playback
      // means the visual content still plays (a frozen frame is worse
      // than silence) — sound recovers automatically once there's any
      // interaction with the page, via the listener below, or once the
      // browser itself is launched with the autoplay flag from the README.
      if (!mediaEl.muted) {
        mediaEl.dataset.wantsSound = "true";
        mediaEl.muted = true;
        mediaEl.play().catch(() => {});
      }
    });
  }
}

// The moment there's ANY interaction with the page — a click, a tap, a
// keypress — browsers consider that consent for audio going forward. This
// silently un-mutes whatever's currently playing and needed sound, with no
// visible prompt (unlike the old "tap to enable sound" overlay).
function unlockSoundOnInteraction() {
  document.querySelectorAll(".needs-play-lifecycle").forEach((el) => {
    if (el.dataset.wantsSound === "true" && el.muted) {
      el.muted = false;
      el.play().catch(() => {});
    }
  });
}
["click", "touchstart", "keydown"].forEach((evt) => {
  document.addEventListener(evt, unlockSoundOnInteraction);
});

function showSlide(index) {
  const nodes = document.querySelectorAll("#slideshow .slide");
  nodes.forEach((n, i) => {
    n.classList.toggle("active", i === index);
    const mediaEls = n.querySelectorAll(".needs-play-lifecycle");
    mediaEls.forEach((el) => {
      if (i === index) {
        el.currentTime = 0;
        attemptPlay(el);
      } else {
        el.pause();
      }
    });
  });

  segmentEls.forEach((seg, i) => {
    const fill = seg.querySelector(".segment-fill");
    seg.classList.remove("active", "done");
    fill.style.transition = "none";
    if (i < index) { seg.classList.add("done"); } else { fill.style.width = "0%"; }
  });

  if (segmentEls[index]) {
    const seg = segmentEls[index];
    const fill = seg.querySelector(".segment-fill");
    const duration = (slides[index] && slides[index].duration) || 10;
    seg.classList.add("active");
    void fill.offsetWidth;
    fill.style.transition = "width " + duration + "s linear";
    requestAnimationFrame(() => { fill.style.width = "100%"; });
  }
}

function goTo(index) {
  if (!slides.length) return;
  current = ((index % slides.length) + slides.length) % slides.length;
  showSlide(current);
  scheduleNext();
  saveCache();
}

function scheduleNext() {
  clearTimeout(timer);
  if (!slides.length) return;
  const duration = (slides[current] && slides[current].duration) || 10;
  timer = setTimeout(() => goTo(current + 1), duration * 1000);
}

/* ---------- clock ---------- */

function tickClock() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("date-line").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- weather (Open-Meteo, no API key) ---------- */

const WEATHER_ICONS = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "🌨️",
  80: "🌦️", 81: "🌧️", 82: "⛈️",
  95: "⛈️", 96: "⛈️", 99: "⛈️"
};

async function loadWeather(lat, lon, place) {
  try {
    const res = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&current=temperature_2m,weather_code&temperature_unit=celsius"
    );
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code;
    $("weather-temp").textContent = temp + "°C";
    $("weather-icon").textContent = WEATHER_ICONS[code] || "◌";
    $("weather-place").textContent = place;
  } catch (e) {
    $("weather-place").textContent = "weather unavailable";
  }
}

const SCREEN_LOCATION = { lat: 6.5244, lon: 3.3792, place: "Lagos" };

function initWeather() {
  loadWeather(SCREEN_LOCATION.lat, SCREEN_LOCATION.lon, SCREEN_LOCATION.place);
}
initWeather();
setInterval(initWeather, 30 * 60 * 1000);

/* ---------- ticker ---------- */

function renderTicker() {
  const el = $("ticker");
  el.innerHTML = ticker.map(() => '<span class="msg"></span>').join("");
  const spans = el.querySelectorAll(".msg");
  spans.forEach((span, i) => (span.textContent = ticker[i]));
  const approxWidth = ticker.join("").length * 9;
  el.style.animationDuration = Math.max(18, approxWidth / 55) + "s";
}

/* keep the display awake and tidy on fullscreen kiosks */
document.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }
});

boot();
