// Measures generation cost and how far each chunk's geometry spills left of the
// planner window that produced it. The spill sizes the render lead in the
// renderer: a tile can only be rasterized once no future chunk can reach it.
// usage: node tools/probe.cjs [seed] [chunks]
const fs = require("fs");
const SHANSHUI_CORE = new Function(
  fs.readFileSync(__dirname + "/../gen-core.js", "utf8") + ";return SHANSHUI_CORE;",
)();
const g = SHANSHUI_CORE(process.argv[2] || "12345");
const N = +process.argv[3] || 30;
const seen = new Set();
let spill = 0, polys = 0, bytes = 0, worst = 0;
const t0 = Date.now();
for (let k = 0; k < N; k++) {
  const winStart = g.MEM.xmax;
  const t = Date.now();
  // Only extends to the right: xmin sits exactly on the left guard.
  g.chunkloader(g.MEM.xmin + g.MEM.cwid, g.MEM.xmax - g.MEM.cwid + 1);
  worst = Math.max(worst, Date.now() - t);
  for (const c of g.MEM.chunks) {
    if (seen.has(c)) continue;
    seen.add(c);
    let minx = Infinity;
    for (const tok of c.canv.split("\x03")) {
      const p = tok.indexOf("\x01");
      if (p < 0) continue;
      const pts = tok.slice(p + 1).split("\x02")[3].split(",");
      polys++;
      for (let i = 0; i < pts.length; i += 2) if (+pts[i] < minx) minx = +pts[i];
    }
    bytes += c.canv.length;
    if (k > 0) spill = Math.max(spill, winStart - minx);
  }
}
const ms = Date.now() - t0;
console.log({ perChunkMs: +(ms / N).toFixed(1), worstChunkMs: worst, maxLeftSpill: Math.round(spill), polysPerChunk: Math.round(polys / N), KBPerChunk: Math.round(bytes / N / 1024) });
