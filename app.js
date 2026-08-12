(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $("status"),
    count: $("count"),
    groups: $("groups"),
    channels: $("channels"),
    search: $("search"),
    video: $("video"),
    freezeFrame: $("freezeFrame"),
    playerStage: document.querySelector(".video-stage"),
    start: $("startPlayback"),
    loading: $("loading"),
    playPauseToggle: $("playPauseToggle"),
    muteToggle: $("muteToggle"),
    volumeSlider: $("volumeSlider"),
    pipToggle: $("pipToggle"),
    fullscreenToggle: $("fullscreenToggle"),
    nowNumber: $("nowNumber"),
    nowName: $("nowName"),
    message: $("message"),
    error: $("errorBox"),
    sidebar: $("sidebar"),
    scrim: $("scrim"),
    modeDescription: $("modeDescription"),
    modeFooter: $("modeFooter"),
  };

  let sources = { "1": [], "2": [] };
  let activeSource = "1";
  let activeGroup = "全部";
  let activeKey = null;
  let query = "";
  let player = null;
  let audioBridge = null;
  let playbackStarted = false;
  let streamActive = false;
  let lastAudibleVolume = 1;
  let fullscreenControlsTimer = 0;

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function setStatus(kind, text) {
    ui.status.className = `status ${kind || ""}`;
    ui.status.querySelector("b").textContent = text;
  }

  function showError(text = "") {
    ui.error.textContent = text;
    ui.error.classList.toggle("show", Boolean(text));
  }

  function setStartOverlayVisible(visible) {
    ui.start.hidden = !visible;
    ui.start.disabled = !visible;
    ui.start.setAttribute("aria-hidden", String(!visible));
    if (visible) {
      ui.start.style.removeProperty("display");
      ui.start.style.removeProperty("pointer-events");
    } else {
      ui.start.style.setProperty("display", "none", "important");
      ui.start.style.setProperty("pointer-events", "none", "important");
    }
  }

  function captureFreezeFrame() {
    if (!ui.video.videoWidth || !ui.video.videoHeight) return;
    try {
      ui.freezeFrame.width = ui.video.videoWidth;
      ui.freezeFrame.height = ui.video.videoHeight;
      const context = ui.freezeFrame.getContext("2d", { alpha: false });
      context.drawImage(ui.video, 0, 0, ui.freezeFrame.width, ui.freezeFrame.height);
      ui.freezeFrame.hidden = false;
    } catch { /* Some protected streams may not allow frame capture. */ }
  }

  function hideFreezeFrame() {
    ui.freezeFrame.hidden = true;
  }

  function syncVolumeControls() {
    const muted = ui.video.muted || ui.video.volume === 0;
    if (!muted) lastAudibleVolume = ui.video.volume;
    ui.volumeSlider.value = String(ui.video.volume);
    const icon = ui.muteToggle.querySelector(".tool-icon");
    icon.textContent = muted ? "🔇" : ui.video.volume < 0.5 ? "🔉" : "🔊";
    ui.muteToggle.setAttribute("aria-label", muted ? "取消静音" : "静音");
    ui.muteToggle.title = muted ? "取消静音" : "静音";
  }

  function syncFullscreenControl() {
    const fullscreen = document.fullscreenElement === ui.playerStage || document.webkitFullscreenElement === ui.playerStage;
    const label = ui.fullscreenToggle.querySelector(".tool-label");
    label.textContent = fullscreen ? "退出" : "全屏";
    ui.fullscreenToggle.setAttribute("aria-label", fullscreen ? "退出全屏" : "全屏播放");
    ui.fullscreenToggle.title = fullscreen ? "退出全屏" : "全屏播放";
  }

  function syncPlayPauseControl() {
    const icon = ui.playPauseToggle.querySelector(".tool-icon");
    icon.textContent = streamActive ? "Ⅱ" : "▶";
    ui.playPauseToggle.setAttribute("aria-label", streamActive ? "暂停直播" : "重新连接并播放");
    ui.playPauseToggle.title = streamActive ? "暂停直播" : "重新连接并播放";
  }

  function syncPipControl() {
    const active = document.pictureInPictureElement === ui.video;
    const supported = Boolean(document.pictureInPictureEnabled && ui.video.requestPictureInPicture);
    const label = ui.pipToggle.querySelector(".tool-label");
    ui.pipToggle.disabled = !supported;
    label.textContent = active ? "退出画中画" : "画中画";
    ui.pipToggle.setAttribute("aria-label", active ? "退出画中画" : "画中画播放");
    ui.pipToggle.title = supported ? (active ? "退出画中画" : "画中画播放") : "当前浏览器不支持画中画";
  }

  function revealFullscreenControls() {
    const fullscreen = document.fullscreenElement === ui.playerStage || document.webkitFullscreenElement === ui.playerStage;
    if (!fullscreen) return;
    ui.playerStage.classList.remove("controls-hidden");
    ui.playerStage.classList.add("controls-visible");
    window.clearTimeout(fullscreenControlsTimer);
    fullscreenControlsTimer = window.setTimeout(() => {
      ui.playerStage.classList.remove("controls-visible");
      ui.playerStage.classList.add("controls-hidden");
    }, 2500);
  }

  async function toggleFullscreen() {
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (fullscreen) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (ui.playerStage.requestFullscreen) {
        await ui.playerStage.requestFullscreen();
      } else if (ui.playerStage.webkitRequestFullscreen) {
        ui.playerStage.webkitRequestFullscreen();
      }
    } catch {
      showError("浏览器未能进入全屏，请检查是否允许网页使用全屏功能。");
    }
  }

  async function togglePictureInPicture() {
    if (!document.pictureInPictureEnabled || !ui.video.requestPictureInPicture) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await ui.video.requestPictureInPicture();
    } catch {
      showError("画中画启动失败，请先开始播放后再试。");
    }
  }

  function currentChannels() {
    return sources[activeSource] || [];
  }

  function currentChannel() {
    return currentChannels().find((channel) => channel.key === activeKey) || currentChannels()[0];
  }

  function cleanName(name) {
    return name.replace(/^\s*\d{1,4}\s*[.．、_-]\s*/, "").trim();
  }

  function groupOf(name) {
    const normalized = name.toUpperCase().replaceAll(" ", "");
    if (name.startsWith("导视")) return "导视";
    if (name.includes("天津")) return "天津";
    if (normalized.includes("CCTV")) return "央视";
    if (name.includes("卫视") || name.includes("上海东方")) return "卫视";
    return "其他";
  }

  function parseM3u(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const channels = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line.toUpperCase().startsWith("#EXTINF:")) continue;
      const comma = line.indexOf(",");
      if (comma < 0) continue;

      let streamUrl = "";
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const candidate = lines[nextIndex].trim();
        if (!candidate || candidate.startsWith("#")) continue;
        streamUrl = candidate;
        break;
      }
      if (!streamUrl) continue;

      const displayName = line.slice(comma + 1).trim();
      const numberMatch = displayName.match(/^(\d{1,4})[.．、_-]\s*/);
      const id = String(numberMatch ? numberMatch[1] : channels.length + 1).padStart(3, "0");
      const name = cleanName(displayName);
      channels.push({ key: channels.length, id, name, group: groupOf(name), url: streamUrl });
    }
    return channels;
  }

  function renderGroups() {
    const order = ["全部", "导视", "天津", "央视", "卫视", "其他"];
    const available = new Set(currentChannels().map((channel) => channel.group));
    const groups = order.filter((name) => name === "全部" || available.has(name));
    if (!groups.includes(activeGroup)) activeGroup = "全部";

    ui.groups.innerHTML = groups.map((name) => (
      `<button type="button" data-group="${escapeHtml(name)}" class="${name === activeGroup ? "active" : ""}" aria-pressed="${name === activeGroup}">${escapeHtml(name)}</button>`
    )).join("");
  }

  function renderChannels() {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const visible = currentChannels().filter((channel) => {
      const groupMatches = activeGroup === "全部" || channel.group === activeGroup;
      const queryMatches = !normalizedQuery || `${channel.id} ${channel.name}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
      return groupMatches && queryMatches;
    });

    ui.count.textContent = `${currentChannels().length} 个频道`;
    if (!visible.length) {
      ui.channels.innerHTML = '<p class="empty-state">没有找到匹配的频道</p>';
      return;
    }

    ui.channels.innerHTML = visible.map((channel) => (
      `<button type="button" class="channel-item ${channel.key === activeKey ? "active" : ""}" data-key="${channel.key}" aria-label="播放 ${escapeHtml(channel.name)}">
        <span class="channel-number">${escapeHtml(channel.id)}</span>
        <span class="channel-text"><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(channel.group)} · 直播</small></span>
        <span class="arrow" aria-hidden="true">›</span>
      </button>`
    )).join("");
  }

  function updateNowPlaying(channel) {
    if (!channel) return;
    ui.nowNumber.textContent = channel.id;
    ui.nowName.textContent = channel.name;
    ui.message.textContent = `源${activeSource} · IPTV 代理`;
    ui.start.querySelector("small").textContent = `当前频道 · ${channel.name}`;
  }

  function selectChannel(key, playNow = true) {
    const channel = currentChannels().find((item) => item.key === Number(key)) || currentChannels()[0];
    if (!channel) return;
    activeKey = channel.key;
    updateNowPlaying(channel);
    renderChannels();
    closeSidebar();
    if (playNow) {
      playbackStarted = true;
      connect(channel);
    }
  }

  function destroyPlayer() {
    streamActive = false;
    if (audioBridge) {
      audioBridge.destroy();
      audioBridge = null;
    }
    if (player) {
      try {
        player.pause();
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch { /* The player may already be detached after a network failure. */ }
      player = null;
    }
    syncPlayPauseControl();
    ui.loading.classList.remove("show");
  }

  function pauseStream() {
    if (!streamActive) return;
    streamActive = false;
    captureFreezeFrame();
    ui.video.pause();
    if (audioBridge) {
      audioBridge.destroy();
      audioBridge = null;
    }
    if (player) {
      try {
        player.pause();
        player.unload();
      } catch { /* The stream may already be closing. */ }
    }
    ui.loading.classList.remove("show");
    setStatus("", "已暂停");
    ui.message.textContent = `源${activeSource} · 已暂停并断开直播流`;
    syncPlayPauseControl();
  }

  function toggleStreamPlayback() {
    if (streamActive) {
      pauseStream();
    } else {
      playbackStarted = true;
      connect();
    }
  }

  function connect(channel = currentChannel()) {
    if (!channel) return;
    destroyPlayer();
    showError();
    setStartOverlayVisible(false);
    ui.loading.classList.add("show");
    setStatus("connecting", "正在连接");
    ui.message.textContent = `源${activeSource} · 正在连接`;

    if (!window.mpegts || !window.mpegts.isSupported()) {
      streamActive = false;
      syncPlayPauseControl();
      ui.loading.classList.remove("show");
      setStatus("error", "浏览器不支持");
      showError("当前浏览器不支持 MPEG-TS 实时播放，请使用最新版 Chrome 或 Edge。");
      return;
    }

    streamActive = true;
    syncPlayPauseControl();

    const streamUrl = channel.url;
    if (window.IPTVAudio) {
      audioBridge = window.IPTVAudio.create({
        mediaElement: ui.video,
        onStatus: (text) => {
          if (text === "MPEG 音频播放中") ui.message.textContent = `源${activeSource} · 音视频播放中`;
        },
        onError: (error) => {
          showError(`画面可以继续播放，但音频解码失败：${error.message || error}。请重新连接或切换频道。`);
        },
      });
    } else {
      showError("未载入 MPEG 音频解码模块，请确认 audio-player.js 和 vendor/mpg123-decoder.min.js 已上传。");
    }

    player = window.mpegts.createPlayer({
      type: "mpegts",
      isLive: true,
      url: streamUrl,
      hasAudio: false,
      hasVideo: true,
      cors: true,
      withCredentials: false,
    }, {
      customLoader: window.IPTVAudio?.Loader,
      audioBridge,
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 393216,
      lazyLoad: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 0.8,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 10,
    });

    player.attachMediaElement(ui.video);
    player.on(window.mpegts.Events.MEDIA_INFO, () => {
      setStatus("connecting", "正在同步");
      ui.message.textContent = `源${activeSource} · 正在同步音视频`;
    });
    player.on(window.mpegts.Events.ERROR, (_type, detail) => {
      streamActive = false;
      syncPlayPauseControl();
      ui.loading.classList.remove("show");
      setStatus("error", "连接失败");
      showError(`无法播放 ${channel.name}${detail ? `（${detail}）` : ""}。请检查 IPTV 代理是否在线、M3U 地址是否正确，以及代理的跨域（CORS）支持是否开启。`);
    });
    player.load();
    player.play().catch(() => {
      ui.message.textContent = "直播流已连接，请点击底部控制栏的播放按钮";
    });
  }

  async function fetchSource(source) {
    const fileName = `source${source}.m3u`;
    const response = await fetch(fileName, { cache: "no-store" });
    if (!response.ok) throw new Error(`${fileName} 返回 ${response.status}`);
    return parseM3u(await response.text());
  }

  async function loadSources() {
    destroyPlayer();
    playbackStarted = false;
    setStartOverlayVisible(true);
    setStatus("connecting", "正在载入");
    showError();
    ui.channels.innerHTML = '<p class="empty-state">正在读取频道源…</p>';

    try {
      const [source1, source2] = await Promise.all([fetchSource("1"), fetchSource("2")]);
      if (!source1.length || !source2.length) throw new Error("频道源中没有有效的 #EXTINF 条目");
      sources = { "1": source1, "2": source2 };
      activeKey = currentChannels()[0]?.key ?? null;
      renderGroups();
      renderChannels();
      updateNowPlaying(currentChannel());
      setStatus("", "等待播放");
      ui.modeDescription.textContent = "H.264 画面由浏览器硬件解码，MPEG 音轨由内置 WASM 解码器播放。";
      ui.modeFooter.textContent = "自建 IPTV 代理 · WASM 音频";
    } catch (error) {
      setStatus("error", "载入失败");
      showError(`无法读取频道源：${error.message}。请确认 source1.m3u 和 source2.m3u 与 index.html 位于同一目录。`);
      ui.channels.innerHTML = '<p class="empty-state">频道源载入失败</p>';
    }
  }

  function openSidebar() {
    ui.sidebar.classList.add("open");
    ui.scrim.classList.add("show");
  }

  function closeSidebar() {
    ui.sidebar.classList.remove("open");
    ui.scrim.classList.remove("show");
  }

  document.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => {
      activeSource = button.dataset.source;
      document.querySelectorAll("[data-source]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      const previous = activeKey;
      activeKey = currentChannels().some((channel) => channel.key === previous) ? previous : currentChannels()[0]?.key ?? null;
      renderGroups();
      renderChannels();
      updateNowPlaying(currentChannel());
      if (playbackStarted) connect();
    });
  });

  ui.groups.addEventListener("click", (event) => {
    const button = event.target.closest("[data-group]");
    if (!button) return;
    activeGroup = button.dataset.group;
    renderGroups();
    renderChannels();
  });
  ui.channels.addEventListener("click", (event) => {
    const button = event.target.closest("[data-key]");
    if (button) selectChannel(button.dataset.key, true);
  });
  ui.search.addEventListener("input", (event) => { query = event.target.value; renderChannels(); });
  ui.start.addEventListener("click", () => {
    setStartOverlayVisible(false);
    playbackStarted = true;
    connect();
  });
  ui.playPauseToggle.addEventListener("click", toggleStreamPlayback);
  ui.muteToggle.addEventListener("click", () => {
    if (ui.video.muted || ui.video.volume === 0) {
      if (ui.video.volume === 0) ui.video.volume = Math.max(0.05, lastAudibleVolume);
      ui.video.muted = false;
    } else {
      ui.video.muted = true;
    }
    syncVolumeControls();
  });
  ui.volumeSlider.addEventListener("input", (event) => {
    const volume = Number(event.target.value);
    ui.video.volume = volume;
    ui.video.muted = volume === 0;
    syncVolumeControls();
  });
  ui.pipToggle.addEventListener("click", togglePictureInPicture);
  ui.fullscreenToggle.addEventListener("click", toggleFullscreen);
  $("reloadSources").addEventListener("click", loadSources);
  $("retryPlayback").addEventListener("click", () => { playbackStarted = true; connect(); });
  $("openSidebar").addEventListener("click", openSidebar);
  $("closeSidebar").addEventListener("click", closeSidebar);
  ui.scrim.addEventListener("click", closeSidebar);
  ui.video.addEventListener("playing", () => {
    streamActive = true;
    syncPlayPauseControl();
    hideFreezeFrame();
    setStartOverlayVisible(false);
    ui.loading.classList.remove("show");
    setStatus("playing", "直播中");
  });
  ui.video.addEventListener("play", () => {
    if (playbackStarted && !streamActive) connect();
  });
  ui.video.addEventListener("pause", () => {
    if (playbackStarted && streamActive) pauseStream();
    else if (playbackStarted) setStatus("", "已暂停");
  });
  ui.video.addEventListener("volumechange", syncVolumeControls);
  ui.video.addEventListener("enterpictureinpicture", syncPipControl);
  ui.video.addEventListener("leavepictureinpicture", syncPipControl);
  ui.playerStage.addEventListener("mousemove", revealFullscreenControls);
  ui.playerStage.addEventListener("touchstart", revealFullscreenControls, { passive: true });
  const handleFullscreenChange = () => {
    syncFullscreenControl();
    const fullscreen = document.fullscreenElement === ui.playerStage || document.webkitFullscreenElement === ui.playerStage;
    if (fullscreen) {
      ui.fullscreenToggle.blur();
      revealFullscreenControls();
    } else {
      window.clearTimeout(fullscreenControlsTimer);
      ui.playerStage.classList.remove("controls-visible", "controls-hidden");
    }
  };
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
    if (event.target.matches("input, button, video")) return;
    const list = currentChannels();
    const index = list.findIndex((channel) => channel.key === activeKey);
    if (event.key === "ArrowDown" && index < list.length - 1) {
      event.preventDefault();
      selectChannel(list[index + 1].key, true);
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      selectChannel(list[index - 1].key, true);
    }
  });

  syncVolumeControls();
  syncFullscreenControl();
  syncPlayPauseControl();
  syncPipControl();
  loadSources();
})();
