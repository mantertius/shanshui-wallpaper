// Soak test of engine.js without a browser: stubs the canvas API, renders N
// tiles and reports that live chunks / planner grid stay bounded (no leak).
// usage: node tools/soak.cjs [tiles]
const fs = require("fs");
const load = (f) => fs.readFileSync(__dirname + "/../" + f, "utf8");
const ctx = new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }, { get: (t, k) => (k in t ? t[k] : () => ({ setTransform() {} })), set: (t, k, v) => ((t[k] = v), true) });
global.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return ctx; } transferToImageBitmap() { return {}; } };
global.DOMMatrix = class {};
const { SHANSHUI_ENGINE } = new Function(load("gen-core.js") + load("engine.js") + ";return {SHANSHUI_ENGINE};")();
const N = +process.argv[2] || 150;
const port = { postMessage(m) { if (m.type === "tile") got.push(m.index); } };
const got = [];
SHANSHUI_ENGINE(port);
port.onmessage({ data: { type: "init", gen: 1, seed: "soak", tileW: 512, tileH: 1080 } });
global.__probe = setInterval(() => {}, 1e9);
port.onmessage({ data: { type: "want", gen: 1, upTo: N } });
const t0 = Date.now();
const iv = setInterval(() => {
  if (got.length >= N) {
    clearInterval(iv);
    console.log({ tiles: got.length, ordered: got.every((v, i) => v === i), sec: (Date.now() - t0) / 1000, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) });
    process.exit(0);
  }
}, 200);
let lastLog = 0;
setInterval(() => { if (got.length - lastLog >= 30) { lastLog = got.length; global.gc && gc(); console.log("tiles", got.length, "heapMB", Math.round(process.memoryUsage().heapUsed / 1e6)); } }, 500);
