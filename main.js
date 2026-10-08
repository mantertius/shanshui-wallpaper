// Display side. Owns no geometry: it only blits finished tiles.
//
// Per frame the cost is one CSS transform write (compositor-only). The canvas is
// repainted only when the scroll crosses a whole device pixel, and then it is a
// handful of drawImage calls of GPU-resident ImageBitmaps. Sub-pixel motion comes
// from translating that single layer, so tiles never show seams.
(function () {
  "use strict";

  var TILE = 512; // device px
  var PREFETCH = 3; // tiles ahead of the right edge

  var cfg = { seed: "", speed: 25, snap: false, fps: 0 };
  var canvas = document.getElementById("view");
  var ctx = canvas.getContext("2d", { alpha: false });

  var W = 0, H = 0, dpr = 1;
  var gen = 0;
  var port = null;
  var worker = null;
  var tiles = new Map();
  var offset = 0; // device px scrolled
  var drawnInt = -1;
  var lastWant = -1;
  var paused = false;
  var last = 0;
  var lastPaint = 0;
  var rafId = 0;
  var shown = false;

  function startEngine() {
    gen++;
    tiles.forEach(function (b) { if (b.close) b.close(); });
    tiles.clear();
    offset = 0;
    drawnInt = -1;
    lastWant = -1;
    shown = false;
    canvas.style.opacity = "0";

    dpr = window.devicePixelRatio || 1;
    W = Math.round(window.innerWidth * dpr);
    H = Math.round(window.innerHeight * dpr);
    // One spare device pixel absorbs the sub-pixel translate.
    canvas.width = W + 1;
    canvas.height = H;
    canvas.style.width = (W + 1) / dpr + "px";
    canvas.style.height = H / dpr + "px";

    if (!port) port = connect();
    var seed = cfg.seed !== "" ? cfg.seed : String(Date.now());
    port.postMessage({ type: "init", gen: gen, seed: seed, tileW: TILE, tileH: H });
    requestTiles();
  }

  function connect() {
    try {
      if (typeof OffscreenCanvas === "undefined") throw new Error("no OffscreenCanvas");
      if (/[?&]noworker/.test(location.search)) throw new Error("disabled by ?noworker");
      var src =
        SHANSHUI_CORE.toString() + "\n" + SHANSHUI_ENGINE.toString() + "\nSHANSHUI_ENGINE(self);";
      var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = onMessage;
      worker.onerror = function (e) {
        console.warn("worker failed, falling back to main thread", e.message);
        worker.terminate();
        worker = null;
        port = localPort();
        startEngine();
      };
      return worker;
    } catch (e) {
      console.warn("worker unavailable, running on main thread:", e.message);
      return localPort();
    }
  }

  // Same engine on the main thread, behind a MessagePort-shaped shim.
  function localPort() {
    var engineSide = { postMessage: function (m) { setTimeout(function () { onMessage({ data: m }); }, 0); } };
    SHANSHUI_ENGINE(engineSide);
    return { postMessage: function (m) { setTimeout(function () { engineSide.onmessage({ data: m }); }, 0); } };
  }

  function onMessage(e) {
    var m = e.data;
    if (m.type !== "tile" || m.gen !== gen) {
      if (m.bitmap && m.bitmap.close) m.bitmap.close();
      return;
    }
    tiles.set(m.index, m.bitmap);
    drawnInt = -1; // a newly arrived tile may be on screen
    wake();
  }

  function requestTiles() {
    var want = Math.floor((Math.floor(offset) + W + 1) / TILE) + PREFETCH;
    if (want !== lastWant) {
      lastWant = want;
      port.postMessage({ type: "want", gen: gen, upTo: want });
    }
  }

  function visibleReady(ox) {
    var a = Math.floor(ox / TILE);
    var b = Math.floor((ox + W) / TILE);
    for (var i = a; i <= b; i++) if (!tiles.has(i)) return false;
    return true;
  }

  function paint(ox) {
    var a = Math.floor(ox / TILE);
    var b = Math.floor((ox + W) / TILE);
    for (var i = a; i <= b; i++) ctx.drawImage(tiles.get(i), i * TILE - ox, 0);
    // Tiles fully behind the left edge are never needed again.
    tiles.forEach(function (bmp, k) {
      if (k < a) {
        if (bmp.close) bmp.close();
        tiles.delete(k);
      }
    });
  }

  function frame(now) {
    rafId = 0;
    if (paused) return;
    var minGap = cfg.fps > 0 ? 1000 / cfg.fps - 1 : 0;
    if (now - lastPaint < minGap) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    lastPaint = now;

    var ox = Math.floor(offset);
    if (!visibleReady(ox)) {
      // Hold still until the worker catches up (only happens at start/reseed).
      requestTiles();
      last = 0;
      return; // onMessage will wake us
    }
    if (ox !== drawnInt) {
      paint(ox);
      drawnInt = ox;
      if (!shown) {
        shown = true;
        canvas.style.opacity = "1";
      }
    }
    var frac = cfg.snap ? 0 : offset - ox;
    canvas.style.transform = "translate3d(" + -frac / dpr + "px,0,0)";

    var next = offset + cfg.speed * dpr * dt;
    // Never scroll onto a tile that has not arrived yet.
    if (visibleReady(Math.floor(next))) offset = next;
    requestTiles();

    if (cfg.speed > 0 || drawnInt !== Math.floor(offset)) rafId = requestAnimationFrame(frame);
  }

  function wake() {
    if (!rafId && !paused) rafId = requestAnimationFrame(frame);
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(startEngine, 300);
  });
  document.addEventListener("visibilitychange", function () {
    setPaused(document.hidden);
  });

  function setPaused(p) {
    paused = p;
    last = 0;
    if (!p) wake();
  }

  // Wallpaper Engine integration.
  window.wallpaperPropertyListener = {
    applyUserProperties: function (p) {
      var reseed = false;
      if (p.seed && p.seed.value !== cfg.seed) {
        cfg.seed = String(p.seed.value).trim();
        reseed = true;
      }
      if (p.speed) cfg.speed = +p.speed.value;
      if (p.pixelsnap) cfg.snap = !!p.pixelsnap.value;
      if (reseed && port) startEngine();
      wake();
    },
    applyGeneralProperties: function (p) {
      if (p.fps !== undefined) cfg.fps = +p.fps;
    },
    setPaused: setPaused,
  };

  // Outside Wallpaper Engine (plain browser): ?seed=...&speed=...
  var q = new URLSearchParams(location.search);
  if (q.has("seed")) cfg.seed = q.get("seed");
  if (q.has("speed")) cfg.speed = +q.get("speed");

  // Let Wallpaper Engine deliver the saved properties before the first build.
  setTimeout(function () {
    if (!port) startEngine();
  }, 0);
})();
