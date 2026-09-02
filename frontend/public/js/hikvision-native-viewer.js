"use strict";

(() => {
  const api = window.electronAPI;
  const surface = document.getElementById("nativeSurface");
  const video = document.getElementById("nativeVideo");
  const placeholder = document.getElementById("nativePlaceholder");
  const placeholderText = document.getElementById("nativePlaceholderText");
  const retryButton = document.getElementById("nativeRetry");

  let nativeRunning = false;
  let hlsInstance = null;
  let updateQueued = false;
  let stallWatchdog = null;
  let mediaReadyAbortController = null;

  const requestedTheme = new URLSearchParams(window.location.search).get("theme") || "dark";
  if (["dark", "light", "classic", "midnight"].includes(requestedTheme)) {
    document.body.dataset.theme = requestedTheme;
  }

  function nativeRect() {
    const rect = surface?.getBoundingClientRect();
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      scaleFactor: window.devicePixelRatio || 1,
    };
  }

  function showError(message) {
    nativeRunning = false;
    placeholder.classList.add("error");
    placeholder.style.display = "flex";
    placeholderText.textContent = message || "Hikvision camera could not start.";
    retryButton.hidden = false;
  }

  async function nextLayoutFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function stopHls() {
    mediaReadyAbortController?.abort();
    mediaReadyAbortController = null;
    if (stallWatchdog) {
      clearInterval(stallWatchdog);
      stallWatchdog = null;
    }
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (_) {}
      hlsInstance = null;
    }
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.style.display = "none";
    }
  }

  async function startHls(mode = "compatible") {
    stopHls();
    if (!video) return;
    video.style.display = "block";
    video.muted = true;
    const url = `/api/hikvision/hls/master.m3u8?mode=${encodeURIComponent(mode)}&_=${Date.now()}`;

    const onPlaying = () => {
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      placeholder.style.display = "none";
      retryButton.hidden = true;
      mediaReadyAbortController?.abort();
      mediaReadyAbortController = null;
    };
    mediaReadyAbortController = new AbortController();
    const mediaReadySignal = mediaReadyAbortController.signal;
    video.addEventListener("playing", onPlaying, { signal: mediaReadySignal });
    video.addEventListener("loadeddata", onPlaying, { signal: mediaReadySignal });
    video.addEventListener("canplay", onPlaying, { signal: mediaReadySignal });
    video.addEventListener("timeupdate", () => {
      if (video.currentTime > 0) onPlaying();
    }, { signal: mediaReadySignal });

    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 10,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        maxBufferSize: 30 * 1024 * 1024,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 5,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 5,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
      });
      hlsInstance = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              if (mode !== "compatible") {
                console.warn("[hikvision popout] Fatal error on high-res HLS, trying compatible substream...");
                startHls("compatible");
                return;
              }
              showError(`Hikvision stream error: ${data.details || "playback failed"}`);
              break;
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.play().catch(() => {});
      video.addEventListener("error", () => showError("Hikvision HLS playback failed"), { once: true, signal: mediaReadySignal });
    } else {
      showError("HLS playback is unavailable in this runtime.");
      return;
    }

    if (stallWatchdog) {
      clearInterval(stallWatchdog);
      stallWatchdog = null;
    }
    let lastTime = -1;
    let stallCount = 0;
    stallWatchdog = setInterval(() => {
      if (!video || video.style.display === "none") {
        clearInterval(stallWatchdog);
        stallWatchdog = null;
        return;
      }
      if (document.hidden) return;
      const cur = video.currentTime;
      if (cur > 0 && cur === lastTime && !video.paused) {
        stallCount++;
        if (stallCount >= 3) {
          if (hlsInstance) {
            try {
              const b = video.buffered;
              if (b && b.length > 0) {
                const liveEnd = b.end(b.length - 1);
                if (liveEnd > cur + 1) {
                  video.currentTime = Math.max(0, liveEnd - 0.5);
                }
              }
              hlsInstance.startLoad();
              video.play().catch(() => {});
            } catch (_) {}
          }
        }
        if (stallCount >= 10) {
          console.warn("[hikvision popout] Persistent playback stall, recovering stream...");
          clearInterval(stallWatchdog);
          stallWatchdog = null;
          if (mode !== "compatible") {
            startHls("compatible");
          } else {
            showError("Playback stalled");
          }
        }
      } else {
        lastTime = cur;
        stallCount = 0;
      }
    }, 4000);
  }

  async function startPlayback() {
    retryButton.hidden = true;
    placeholder.classList.remove("error");
    placeholder.style.display = "flex";
    placeholderText.textContent = "Connecting to Hikvision camera…";

    let delivery = null;
    let config = null;
    try {
      const resp = await fetch("/api/hikvision/config", { cache: "no-store" });
      if (resp.ok) {
        const data = await resp.json();
        delivery = data?.delivery;
        config = data?.config;
      }
    } catch (_) {}

    const isRemote = delivery?.operationMode === "remote" || !delivery?.localFallback && delivery?.compactPath === "gateway-relay";
    if (isRemote || !api?.hikvisionNativeStart) {
      await fetch("/api/hikvision/start", { method: "POST" }).catch(() => {});
      const streamMode = config?.playbackMode === "compatible" ? "compatible" : "browser";
      return startHls(streamMode);
    }

    await nextLayoutFrame();
    const rect = nativeRect();
    if (!rect) {
      await fetch("/api/hikvision/start", { method: "POST" }).catch(() => {});
      return startHls("browser");
    }
    try {
      await api.hikvisionNativeStart(rect);
      nativeRunning = true;
      placeholder.style.display = "none";
    } catch (err) {
      console.warn("[hikvision popout] Native start failed, falling back to HLS:", err?.message);
      await fetch("/api/hikvision/start", { method: "POST" }).catch(() => {});
      return startHls("browser");
    }
  }

  async function updateGeometry() {
    updateQueued = false;
    if (!nativeRunning || document.hidden) return;
    const rect = nativeRect();
    if (!rect) return;
    try { await api.hikvisionNativeUpdate(rect); } catch (_) {}
  }

  function queueGeometryUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(updateGeometry);
  }

  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    try { await api?.hikvisionNativeStop?.(); } catch (_) {}
    stopHls();
    retryButton.disabled = false;
    startPlayback();
  });
  window.addEventListener("resize", queueGeometryUpdate);
  document.addEventListener("visibilitychange", async () => {
    if (!nativeRunning) return;
    try {
      if (document.hidden) await api.hikvisionNativeHide();
      else {
        const rect = nativeRect();
        if (rect) await api.hikvisionNativeUpdate(rect);
        await api.hikvisionNativeShow();
      }
    } catch (_) {}
  });
  window.addEventListener("beforeunload", () => {
    stopHls();
    if (nativeRunning) api?.hikvisionNativeStop?.().catch(() => {});
  });

  if (typeof ResizeObserver !== "undefined" && surface) {
    new ResizeObserver(queueGeometryUpdate).observe(surface);
  }

  startPlayback();
})();
