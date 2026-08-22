const $ = (id) => document.getElementById(id);

/* ---------- state ---------- */

let library = [];
let playlists = [];
let screens = [];
let currentPlaylistId = null;
let pickerTargetPlaylistId = null;
let detailEditingItemId = null;

const loginScreen = $("login-screen");
const dashboard = $("dashboard");
const loginForm = $("login-form");
const loginError = $("login-error");

/* ---------- auth ---------- */

async function checkSession() {
  const res = await fetch("/api/session");
  const data = await res.json();
  if (data.authenticated) {
    loginScreen.hidden = true;
    dashboard.hidden = false;
    startListeners();
  } else {
    loginScreen.hidden = false;
    dashboard.hidden = true;
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const btn = $("login-submit");
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error();
    loginScreen.hidden = true;
    dashboard.hidden = false;
    startListeners();
  } catch (err) {
    loginError.textContent =
      "Couldn't sign in — check the email and password and try again.";
    loginError.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("signout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  loginScreen.hidden = false;
  dashboard.hidden = true;
});

/* ---------- nav ---------- */

document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".nav-item[data-view]")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $("view-" + btn.dataset.view).classList.add("active");
  });
});

/* ---------- live data ---------- */

let listenersStarted = false;
function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;

  loadContent();
  loadPlaylists();
  loadScreens();

  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (payload.resource === "content") debounce("content", loadContent);
    if (payload.resource === "playlists") debounce("playlists", loadPlaylists);
    if (payload.resource === "screens") debounce("screens", loadScreens);
  };

  setInterval(renderScreens, 5000); // keep "last seen" times fresh between events
}

// Coalesces rapid-fire updates (e.g. changing several screens' playlists in
// quick succession) into a single reload instead of one per event.
const debounceTimers = {};
function debounce(key, fn, wait = 200) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(fn, wait);
}

async function loadContent() {
  const res = await fetch("/api/content");
  library = await res.json();
  renderLibrary();
  renderPickerGrid();
  renderPlaylistEditor(); // slide thumbnails may reference library items
}

async function loadPlaylists() {
  const res = await fetch("/api/playlists");
  playlists = await res.json();
  renderPlaylistList();
  renderPlaylistEditor();
  renderScreens(); // playlist names shown in the screens table
}

async function loadScreens() {
  const res = await fetch("/api/screens", { credentials: "include" });
  screens = await res.json();
  renderScreens();
}

/* ================= CONTENT LIBRARY ================= */

$("upload-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  try {
    await uploadFiles(files);
    loadContent();
  } catch (err) {
    alert("Upload failed. Check the server is running and try again.");
  }
  e.target.value = "";
});

// Reads a video/audio file's real length before it's even uploaded, using a
// throwaway media element pointed at a local object URL. Resolves to null
// (not 0) for images or if detection fails/times out, so the server can
// tell "unknown" apart from a genuine zero-length clip.
function detectDuration(file) {
  if (!file.type.startsWith("video") && !file.type.startsWith("audio")) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const el = document.createElement(
      file.type.startsWith("video") ? "video" : "audio"
    );
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = "metadata";
    el.src = url;
    el.onloadedmetadata = () =>
      finish(isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000); // don't let a weird file stall the whole upload
  });
}

function uploadFiles(files) {
  const progressEl = $("upload-progress");
  progressEl.hidden = false;
  progressEl.textContent = "Reading file info…";

  return Promise.all(files.map(detectDuration)).then((durations) => {
    progressEl.textContent = "Uploading…";
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("durations", JSON.stringify(durations));

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/content");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          progressEl.textContent =
            "Uploading — " + Math.round((evt.loaded / evt.total) * 100) + "%";
        }
      };
      xhr.onload = () => {
        progressEl.hidden = true;
        if (xhr.status >= 200 && xhr.status < 300)
          resolve(JSON.parse(xhr.responseText));
        else reject(new Error("Upload failed"));
      };
      xhr.onerror = () => {
        progressEl.hidden = true;
        reject(new Error("Upload failed"));
      };
      xhr.send(form);
    });
  });
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + ":" + String(rem).padStart(2, "0");
}

function renderLibrary() {
  const grid = $("library-grid");
  grid.innerHTML = "";
  $("library-empty").hidden = library.length > 0;

  library.forEach((item) => {
    const card = document.createElement("div");
    card.className = "content-card";
    card.appendChild(mediaThumb(item));
    const meta = document.createElement("div");
    meta.className = "content-meta";
    meta.innerHTML =
      '<div class="content-name"></div>' +
      '<div class="content-row"><span class="tag"></span><button class="delete-btn" title="Delete">✕</button></div>';
    meta.querySelector(".content-name").textContent = item.name;
    meta.querySelector(".tag").textContent =
      item.type +
      (item.duration_seconds
        ? " · " + formatDuration(item.duration_seconds)
        : "");
    meta.querySelector(".delete-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteContent(item);
    });
    card.appendChild(meta);
    grid.appendChild(card);
  });
}

function mediaThumb(item) {
  if (item.type === "video") {
    const v = document.createElement("video");
    v.className = "content-thumb";
    v.src = item.url;
    v.muted = true;
    v.preload = "metadata";
    return v;
  }
  if (item.type === "audio") {
    const div = document.createElement("div");
    div.className = "content-thumb audio-thumb";
    div.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
    return div;
  }
  const img = document.createElement("img");
  img.className = "content-thumb";
  img.src = item.url;
  img.alt = item.name;
  return img;
}

async function deleteContent(item) {
  if (
    !confirm(
      'Delete "' +
        item.name +
        '"? This removes the file and takes it out of any playlist using it.'
    )
  )
    return;
  await fetch("/api/content/" + item.id, { method: "DELETE" });
}

/* ================= PLAYLISTS ================= */

$("new-playlist-btn").addEventListener("click", async () => {
  const res = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Untitled playlist" }),
  });
  const created = await res.json();
  currentPlaylistId = created.id;
});

function renderPlaylistList() {
  const list = $("playlist-list");
  list.innerHTML = "";
  playlists.forEach((p) => {
    const li = document.createElement("li");
    li.className = p.id === currentPlaylistId ? "active" : "";
    li.innerHTML = '<span></span><span class="count"></span>';
    li.querySelector("span").textContent = p.name || "Untitled playlist";
    li.querySelector(".count").textContent = (p.items || []).length + " slides";
    li.addEventListener("click", () => {
      currentPlaylistId = p.id;
      renderPlaylistList();
      renderPlaylistEditor();
    });
    list.appendChild(li);
  });
}

function renderPlaylistEditor() {
  const wrap = $("playlist-editor");
  const playlist = playlists.find((p) => p.id === currentPlaylistId);
  if (!playlist) {
    wrap.innerHTML =
      '<p class="empty-state">Select a playlist on the left, or create a new one.</p>';
    return;
  }

  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.className = "playlist-editor-head";
  const nameInput = document.createElement("input");
  nameInput.value = playlist.name || "";
  nameInput.addEventListener("change", () =>
    updatePlaylist(playlist.id, {
      name: nameInput.value.trim() || "Untitled playlist",
    })
  );
  head.appendChild(nameInput);
  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-danger";
  delBtn.textContent = "Delete playlist";
  delBtn.addEventListener("click", async () => {
    if (
      !confirm(
        'Delete playlist "' +
          playlist.name +
          '"? Screens using it will show as unassigned.'
      )
    )
      return;
    await fetch("/api/playlists/" + playlist.id, { method: "DELETE" });
    currentPlaylistId = null;
  });
  head.appendChild(delBtn);
  wrap.appendChild(head);

  const list = document.createElement("ol");
  list.className = "slide-items";
  (playlist.items || []).forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "slide-item";

    if (item.type === "audio") {
      const div = document.createElement("div");
      div.className = "slide-item-audio-icon";
      div.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
      li.appendChild(div);
    } else if (item.url) {
      const thumb =
        item.type === "video"
          ? document.createElement("video")
          : document.createElement("img");
      thumb.className = "slide-item-thumb";
      thumb.src = item.url;
      if (item.type === "video") {
        thumb.muted = true;
        thumb.preload = "metadata";
      }
      li.appendChild(thumb);
    } else {
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = item.accent || "#f5a623";
      li.appendChild(swatch);
    }

    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = item.title || item.name || "(untitled)";
    li.appendChild(title);

    const meta = document.createElement("span");
    meta.className = "item-meta";
    const soundNote =
      item.type === "audio"
        ? " · 🔊"
        : item.type === "video" && item.muted === false
        ? " · 🔊 own audio"
        : item.voiceoverName
        ? " · 🔊 voiceover"
        : "";
    meta.textContent = item.duration + "s" + soundNote;
    li.appendChild(meta);

    const actions = document.createElement("span");
    actions.className = "item-actions";
    actions.innerHTML =
      '<button class="edit" title="Edit">✎</button>' +
      '<button class="up" title="Move up">↑</button>' +
      '<button class="down" title="Move down">↓</button>' +
      '<button class="remove" title="Remove">✕</button>';
    actions
      .querySelector(".edit")
      .addEventListener("click", () => openDetailModal(playlist, item.itemId));
    actions
      .querySelector(".up")
      .addEventListener("click", () => moveItem(playlist, i, -1));
    actions
      .querySelector(".down")
      .addEventListener("click", () => moveItem(playlist, i, 1));
    actions
      .querySelector(".remove")
      .addEventListener("click", () => removeItem(playlist, item.itemId));
    li.appendChild(actions);

    list.appendChild(li);
  });
  wrap.appendChild(list);

  if (!(playlist.items || []).length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No slides yet. Add one below.";
    wrap.appendChild(empty);
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "editor-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-primary";
  addBtn.textContent = "Add slide";
  addBtn.addEventListener("click", () => openPicker(playlist.id));
  actionsRow.appendChild(addBtn);
  wrap.appendChild(actionsRow);

  const tickerWrap = document.createElement("div");
  tickerWrap.className = "ticker-editor";
  tickerWrap.innerHTML =
    "<h3>Ticker messages</h3>" +
    '<textarea rows="3" placeholder="One message per line"></textarea>' +
    '<button class="btn btn-ghost">Update ticker</button>';
  const ta = tickerWrap.querySelector("textarea");
  ta.value = (playlist.ticker || []).join("\n");
  tickerWrap.querySelector("button").addEventListener("click", () => {
    const lines = ta.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    updatePlaylist(playlist.id, { ticker: lines });
  });
  wrap.appendChild(tickerWrap);
}

async function updatePlaylist(id, patch) {
  await fetch("/api/playlists/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function moveItem(playlist, index, delta) {
  const items = (playlist.items || []).slice();
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= items.length) return;
  [items[index], items[newIndex]] = [items[newIndex], items[index]];
  updatePlaylist(playlist.id, { items });
}

function removeItem(playlist, itemId) {
  const items = (playlist.items || []).filter((it) => it.itemId !== itemId);
  updatePlaylist(playlist.id, { items });
}

/* ---------- picker modal (add slide) ---------- */

const pickerModal = $("picker-modal");
$("picker-close").addEventListener("click", () => (pickerModal.hidden = true));
pickerModal.addEventListener("click", (e) => {
  if (e.target === pickerModal) pickerModal.hidden = true;
});

document.querySelectorAll(".picker-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".picker-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("picker-media").hidden = tab.dataset.kind !== "media";
    $("picker-announcement-form").hidden = tab.dataset.kind !== "announcement";
  });
});

function openPicker(playlistId) {
  pickerTargetPlaylistId = playlistId;
  pickerModal.hidden = false;
  $("pk-media-duration").value = 10;
  renderPickerGrid();
}

function renderPickerGrid() {
  const grid = $("picker-grid");
  if (!grid) return;
  grid.innerHTML = "";
  library.forEach((item) => {
    const card = document.createElement("div");
    card.className = "content-card";
    card.appendChild(mediaThumb(item));
    const meta = document.createElement("div");
    meta.className = "content-meta";
    meta.innerHTML = '<div class="content-name"></div>';
    meta.querySelector(".content-name").textContent = item.name;
    card.appendChild(meta);
    card.addEventListener("click", () => addMediaSlide(item));
    grid.appendChild(card);
  });
}

function addMediaSlide(content) {
  const playlist = playlists.find((p) => p.id === pickerTargetPlaylistId);
  if (!playlist) return;

  const hasOwnDuration =
    (content.type === "video" || content.type === "audio") &&
    typeof content.duration_seconds === "number" &&
    content.duration_seconds > 0;
  const duration = hasOwnDuration
    ? Math.min(3600, Math.max(3, Math.ceil(content.duration_seconds)))
    : Math.min(3600, Math.max(3, Number($("pk-media-duration").value) || 10));

  const item = {
    itemId: "i" + Date.now(),
    type: content.type,
    contentId: content.id,
    url: content.url,
    name: content.name,
    title: content.name,
    body: "",
    duration: duration,
    accent: "#f5a623",
  };
  if (content.type === "video") item.muted = true;
  const items = (playlist.items || []).concat(item);
  updatePlaylist(playlist.id, { items });
  pickerModal.hidden = true;
}

$("picker-announcement-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const playlist = playlists.find((p) => p.id === pickerTargetPlaylistId);
  if (!playlist) return;
  const item = {
    itemId: "i" + Date.now(),
    type: "announcement",
    title: $("pk-title").value.trim(),
    body: $("pk-body").value.trim(),
    duration: Math.min(3600, Math.max(3, Number($("pk-duration").value) || 10)),
    accent: $("pk-accent").value,
  };
  const items = (playlist.items || []).concat(item);
  updatePlaylist(playlist.id, { items });
  pickerModal.hidden = true;
  e.target.reset();
  $("pk-duration").value = 10;
});

/* ---------- detail modal (edit existing slide) ---------- */

const detailModal = $("detail-modal");
$("detail-close").addEventListener("click", () => (detailModal.hidden = true));
detailModal.addEventListener("click", (e) => {
  if (e.target === detailModal) detailModal.hidden = true;
});

function populateVoiceoverOptions(selectedContentId) {
  const select = $("dt-voiceover");
  const audioContent = library.filter((c) => c.type === "audio");
  select.innerHTML =
    '<option value="">None</option>' +
    audioContent
      .map(
        (c) =>
          '<option value="' + c.id + '">' + escapeHtml(c.name) + "</option>"
      )
      .join("");
  select.value = selectedContentId || "";
}

function openDetailModal(playlist, itemId) {
  const item = (playlist.items || []).find((it) => it.itemId === itemId);
  if (!item) return;
  detailEditingItemId = itemId;
  $("dt-title").value = item.title || "";
  $("dt-body").value = item.body || "";
  $("dt-duration").value = item.duration || 10;
  $("dt-accent").value = item.accent || "#f5a623";

  const isVideo = item.type === "video";
  const canHaveVoiceover = item.type === "image" || item.type === "video";

  $("dt-unmute-wrap").hidden = !isVideo;
  $("dt-unmute").checked = isVideo && item.muted === false;

  $("dt-voiceover-wrap").hidden = !canHaveVoiceover;
  if (canHaveVoiceover) populateVoiceoverOptions(item.voiceoverContentId);

  updateDetailMutualExclusion();

  detailModal.dataset.playlistId = playlist.id;
  detailModal.hidden = false;
}

// A video playing its own audio and an attached voiceover would overlap —
// keep these two mutually exclusive in the UI rather than letting both play at once.
function updateDetailMutualExclusion() {
  const unmuteChecked = $("dt-unmute").checked;
  const voiceoverSelect = $("dt-voiceover");
  voiceoverSelect.disabled = unmuteChecked;
  if (unmuteChecked) voiceoverSelect.value = "";
  $("dt-unmute").disabled =
    voiceoverSelect.value !== "" && !unmuteChecked ? true : false;
}

$("dt-unmute").addEventListener("change", updateDetailMutualExclusion);
$("dt-voiceover").addEventListener("change", updateDetailMutualExclusion);

$("detail-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const playlistId = detailModal.dataset.playlistId;
  const playlist = playlists.find((p) => p.id === playlistId);
  if (!playlist) return;

  const voiceoverId = $("dt-voiceover").disabled ? "" : $("dt-voiceover").value;
  const voiceoverContent = voiceoverId
    ? library.find((c) => c.id === voiceoverId)
    : null;

  const items = (playlist.items || []).map((it) => {
    if (it.itemId !== detailEditingItemId) return it;
    const patch = {
      ...it,
      title: $("dt-title").value.trim(),
      body: $("dt-body").value.trim(),
      duration: Math.min(
        3600,
        Math.max(3, Number($("dt-duration").value) || 10)
      ),
      accent: $("dt-accent").value,
    };
    if (it.type === "video") {
      patch.muted = !$("dt-unmute").checked;
    }
    if (it.type === "image" || it.type === "video") {
      if (voiceoverContent) {
        patch.voiceoverContentId = voiceoverContent.id;
        patch.voiceoverUrl = voiceoverContent.url;
        patch.voiceoverName = voiceoverContent.name;
      } else {
        delete patch.voiceoverContentId;
        delete patch.voiceoverUrl;
        delete patch.voiceoverName;
      }
    }
    return patch;
  });
  updatePlaylist(playlistId, { items });
  detailModal.hidden = true;
});

/* ================= SCREENS ================= */

$("new-screen-btn").addEventListener("click", async () => {
  const name = prompt(
    'Name this screen (e.g. "Lobby TV" or "Break room"):',
    "New screen"
  );
  if (name === null) return;
  await fetch("/api/screens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || "New screen" }),
  });
});

function renderScreens() {
  const tbody = $("screens-tbody");
  tbody.innerHTML = "";
  $("screens-empty").hidden = screens.length > 0;

  screens.forEach((screen) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = screen.name;
    tr.appendChild(nameTd);

    const statusTd = document.createElement("td");
    const seenMs = screen.last_seen_at || 0;
    const online = seenMs && Date.now() - seenMs < 90 * 1000;
    statusTd.innerHTML =
      '<span class="status-cell"><span class="dot ' +
      (online ? "online" : "offline") +
      '"></span><span></span></span>';
    statusTd.querySelector("span span:last-child").textContent = seenMs
      ? online
        ? "Online"
        : "Last seen " + formatRelative(seenMs)
      : "Never connected";
    tr.appendChild(statusTd);

    const codeTd = document.createElement("td");
    codeTd.innerHTML = '<span class="pairing-code"></span>';
    codeTd.querySelector(".pairing-code").textContent = screen.pairing_code;
    tr.appendChild(codeTd);

    const playlistTd = document.createElement("td");
    const select = document.createElement("select");
    select.innerHTML =
      '<option value="">Unassigned</option>' +
      playlists
        .map(
          (p) =>
            '<option value="' + p.id + '">' + escapeHtml(p.name) + "</option>"
        )
        .join("");
    select.value = screen.playlist_id || "";
    select.addEventListener("change", async () => {
      await fetch("/api/screens/" + screen.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: select.value || null }),
      });
    });
    playlistTd.appendChild(select);
    tr.appendChild(playlistTd);

    const actionsTd = document.createElement("td");
    actionsTd.innerHTML =
      '<span class="row-actions">' +
      '<button class="btn btn-ghost copy-link">Copy player link</button>' +
      '<button class="btn btn-danger remove-screen">Remove</button></span>';
    actionsTd.querySelector(".copy-link").addEventListener("click", (ev) => {
      const url = new URL("player.html", window.location.href);
      copyToClipboard(url.toString());
      const btn = ev.currentTarget;
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = original), 1500);
    });
    actionsTd
      .querySelector(".remove-screen")
      .addEventListener("click", async () => {
        if (!confirm('Remove screen "' + screen.name + '"?')) return;
        await fetch("/api/screens/" + screen.id, { method: "DELETE" });
      });
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

function formatRelative(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text) {
  // navigator.clipboard requires HTTPS or localhost; this fallback works over
  // plain HTTP (e.g. accessing the dashboard via a local IP like 192.168.x.x).
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(textarea);
  if (!ok) prompt("Copy this link manually:", text);
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

checkSession();
