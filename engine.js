// Tile engine. Runs inside a Web Worker (normal path) or on the main thread
// (fallback). It is written as one self-contained function so main.js can ship
// it to a Blob worker via Function.prototype.toString, which avoids fetch() and
// works under file:// as well.
//
// Pipeline, per 512 device-px tile, strictly left to right:
//   generate chunks until no future chunk can reach the tile (LEAD)
//   -> rasterize every overlapping polygon once, in the original depth order
//   -> multiply onto the paper texture -> transfer an ImageBitmap (zero-copy)
// Chunks entirely left of the next tile are dropped, so memory stays flat no
// matter how long the wallpaper runs (the original page leaks every chunk).
function SHANSHUI_ENGINE(port) {
  // Measured with tools/probe.cjs: geometry spills at most ~1100 world units
  // left of the planner window that produced it. 1600 leaves headroom.
  var LEAD = 1600;
  var ORIGINAL_SCALE = 800 / 700.525; // px per world unit in the original page

  var eng = null;
  var want = -1;
  var scheduled = false;

  port.onmessage = function (e) {
    var m = e.data;
    if (m.type === "init") {
      eng = makeEngine(m);
      want = -1;
    } else if (m.type === "want" && eng && m.gen === eng.gen) {
      if (m.upTo > want) want = m.upTo;
    }
    schedule();
  };

  function schedule() {
    if (scheduled || !eng) return;
    scheduled = true;
    setTimeout(step, 0); // yield between units of work so messages get through
  }

  function step() {
    scheduled = false;
    if (!eng) return;
    var r = eng.work(want);
    if (r && r.bitmap) {
      port.postMessage(
        { type: "tile", gen: eng.gen, index: r.index, bitmap: r.bitmap },
        r.transferable ? [r.bitmap] : [],
      );
    }
    if (r && r.more) schedule();
  }

  function newCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function makeEngine(m) {
    var core = SHANSHUI_CORE(m.seed);
    var MEM = core.MEM;
    var TW = m.tileW;
    var H = m.tileH;
    var scale = H / 700.525; // fit the painting's full height to the screen
    var nextTile = 0;
    var planLow = -1e9;

    var layer = newCanvas(TW, H);
    var lctx = layer.getContext("2d");
    var paper = null;
    var paperPattern = null;
    var paperPeriod = 512 * (scale / ORIGINAL_SCALE);
    // Historical grounds. "multiply" keeps dark ink on the ground, as on paper
    // or silk; "gold" turns the ink into gold leaf on dyed indigo paper.
    var THEMES = {
      paper: { lo: [225, 214, 191], hi: [255, 242, 217], mode: "multiply", passes: 1 },
      silk: { lo: [92, 68, 42], hi: [124, 94, 60], mode: "multiply", passes: 2 },
      indigo: { lo: [16, 22, 44], hi: [30, 38, 66], mode: "gold", ink: "rgb(214,178,104)" },
    };
    var theme = THEMES[m.theme] || THEMES.paper;

    var alphaCache = new Map();
    function alphaOf(col) {
      var a = alphaCache.get(col);
      if (a === undefined) {
        var mm = /rgba\(([^)]*)\)/.exec(col);
        a = mm ? parseFloat(mm[1].split(",")[3]) : col === "none" ? 0 : 1;
        if (!(a >= 0)) a = 1;
        alphaCache.set(col, a);
      }
      return a;
    }
    var intern = new Map();
    function str(s) {
      var v = intern.get(s);
      if (v === undefined) {
        intern.set(s, s);
        v = s;
      }
      return v;
    }

    // SVG-ish token string -> flat drawable records with bounding boxes.
    function compile(canv) {
      var polys = [];
      var cminx = Infinity;
      var cmaxx = -Infinity;
      var toks = canv.split("\x03");
      for (var t = 0; t < toks.length; t++) {
        var tok = toks[t];
        var kind = tok.charCodeAt(0);
        if (kind === 1) {
          var parts = tok.substring(1).split("\x02");
          var wid = +parts[2] || 0;
          var fill = alphaOf(parts[0]) > 0 ? str(parts[0]) : null;
          var stroke = wid > 0 && alphaOf(parts[1]) > 0 ? str(parts[1]) : null;
          if (!fill && !stroke) continue;
          var a = parts[3].split(",");
          if (a.length < 4) continue;
          var pts = new Float32Array(a.length);
          var x0 = Infinity;
          var x1 = -Infinity;
          for (var i = 0; i < a.length; i++) {
            var v = +a[i];
            pts[i] = v;
            if ((i & 1) === 0 && v === v) {
              if (v < x0) x0 = v;
              if (v > x1) x1 = v;
            }
          }
          if (x0 === Infinity) continue;
          x0 -= wid;
          x1 += wid;
          polys.push({ t: 1, f: fill, s: stroke, w: wid, p: pts, x0: x0, x1: x1 });
          if (x0 < cminx) cminx = x0;
          if (x1 > cmaxx) cmaxx = x1;
        } else if (kind === 4) {
          var q = tok.substring(1).split("\x02");
          var size = +q[0];
          var tx = +q[1];
          var half = size * q[4].length;
          polys.push({ t: 4, size: size, x: tx, y: +q[2], deg: +q[3], text: q[4], x0: tx - half, x1: tx + half });
          if (tx - half < cminx) cminx = tx - half;
          if (tx + half > cmaxx) cmaxx = tx + half;
        }
      }
      return { polys: polys, minx: cminx, maxx: cmaxx };
    }

    function compileNew() {
      var ch = MEM.chunks;
      for (var i = 0; i < ch.length; i++) {
        if (!ch[i].cp) {
          ch[i].cp = compile(ch[i].canv);
          ch[i].canv = ""; // the token string can be ~1.7 MB; free it
        }
      }
    }

    function generateOne() {
      if (MEM.xmax === 0 && MEM.xmin === 0) core.chunkloader(0, 1);
      else core.chunkloader(MEM.xmin + MEM.cwid, MEM.xmax - MEM.cwid + 1);
      compileNew();
    }

    // Paper: same recipe as the original (mirrored noise, warm tint), but written
    // straight into ImageData instead of 66k fillRect calls.
    function makePaper() {
      var R = 512;
      var c = newCanvas(R, R);
      var ctx = c.getContext("2d");
      var img = ctx.createImageData(R, R);
      var d = img.data;
      function put(x, y, r, g, b) {
        if (x < 0 || y < 0 || x >= R || y >= R) return;
        var o = (y * R + x) * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      for (var i = 0; i < R / 2 + 1; i++) {
        for (var j = 0; j < R / 2 + 1; j++) {
          var cc = 245 + core.Noise.noise(i * 0.1, j * 0.1) * 10;
          cc -= Math.random() * 20;
          // Same grain as the original (cc in ~225..255), mapped onto the
          // theme's ground. For "paper" this reproduces the original exactly.
          var t = (cc - 225) / 30;
          var r = Math.round(theme.lo[0] + (theme.hi[0] - theme.lo[0]) * t);
          var g = Math.round(theme.lo[1] + (theme.hi[1] - theme.lo[1]) * t);
          var b = Math.round(theme.lo[2] + (theme.hi[2] - theme.lo[2]) * t);
          put(i, j, r, g, b);
          put(R - i, j, r, g, b);
          put(i, R - j, r, g, b);
          put(R - i, R - j, r, g, b);
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    }

    function drawChunk(cp, wx0, wx1) {
      var polys = cp.polys;
      var lastFill = null;
      var lastStroke = null;
      var lastW = -1;
      for (var k = 0; k < polys.length; k++) {
        var o = polys[k];
        if (o.x1 < wx0 || o.x0 > wx1) continue;
        if (o.t === 1) {
          var p = o.p;
          lctx.beginPath();
          lctx.moveTo(p[0], p[1]);
          for (var i = 2; i < p.length; i += 2) lctx.lineTo(p[i], p[i + 1]);
          if (o.f) {
            if (o.f !== lastFill) {
              lctx.fillStyle = o.f;
              lastFill = o.f;
            }
            lctx.fill();
          }
          if (o.s) {
            if (o.s !== lastStroke) {
              lctx.strokeStyle = o.s;
              lastStroke = o.s;
            }
            if (o.w !== lastW) {
              lctx.lineWidth = o.w;
              lastW = o.w;
            }
            lctx.stroke();
          }
        } else {
          lctx.save();
          lctx.translate(o.x, o.y);
          lctx.rotate((o.deg * Math.PI) / 180);
          lctx.font = o.size + "px Verdana, sans-serif";
          lctx.textAlign = "center";
          lctx.fillStyle = "rgba(100,100,100,0.9)";
          lctx.fillText(o.text, 0, 0);
          lctx.restore();
          lastFill = null;
        }
      }
    }

    function renderTile(index) {
      var px0 = index * TW;
      var wx0 = px0 / scale;
      var wx1 = (px0 + TW) / scale;

      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, TW, H);
      lctx.setTransform(scale, 0, 0, scale, -wx0 * scale, 0);
      lctx.lineJoin = "miter";
      lctx.lineCap = "butt";
      var ch = MEM.chunks; // kept sorted by depth (y) by the original add()
      for (var i = 0; i < ch.length; i++) {
        var cp = ch[i].cp;
        if (!cp || cp.maxx < wx0 || cp.minx > wx1) continue;
        drawChunk(cp, wx0, wx1);
      }

      var tile = newCanvas(TW, H);
      var tctx = tile.getContext("2d", { alpha: false });
      if (!paperPattern) {
        paper = makePaper();
        paperPattern = tctx.createPattern(paper, "repeat");
      }
      // Anchor the paper to the world so it scrolls seamlessly across tiles.
      var s = scale / ORIGINAL_SCALE;
      var off = -(px0 % paperPeriod);
      if (paperPattern.setTransform && typeof DOMMatrix !== "undefined") {
        paperPattern.setTransform(new DOMMatrix([s, 0, 0, s, off, 0]));
      }
      if (theme.mode === "multiply") {
        tctx.fillStyle = paperPattern;
        tctx.fillRect(0, 0, TW, H);
        // The original SVG used mix-blend-mode: multiply over the paper. On a
        // dark ground one pass is too faint, so silk deepens the ink twice.
        tctx.globalCompositeOperation = "multiply";
        for (var pass = 0; pass < theme.passes; pass++) tctx.drawImage(layer, 0, 0);
      } else {
        // Ink on neutral white, inverted to light ink on black, tinted gold, then
        // the indigo ground is screened in. White occluder fills invert to black
        // and disappear into the ground, exactly as they vanish under multiply.
        tctx.fillStyle = "#fff";
        tctx.fillRect(0, 0, TW, H);
        tctx.globalCompositeOperation = "multiply";
        tctx.drawImage(layer, 0, 0);
        tctx.globalCompositeOperation = "difference";
        tctx.fillRect(0, 0, TW, H);
        tctx.globalCompositeOperation = "multiply";
        tctx.fillStyle = theme.ink;
        tctx.fillRect(0, 0, TW, H);
        tctx.globalCompositeOperation = "screen";
        tctx.fillStyle = paperPattern;
        tctx.fillRect(0, 0, TW, H);
      }

      if (tile.transferToImageBitmap) return { bitmap: tile.transferToImageBitmap(), transferable: true };
      return { bitmap: tile, transferable: false };
    }

    function prune(worldX) {
      var ch = MEM.chunks;
      var keep = [];
      for (var i = 0; i < ch.length; i++) {
        if (!ch[i].cp || ch[i].cp.maxx >= worldX) keep.push(ch[i]);
      }
      MEM.chunks = keep;
      // The planner's occupancy grid is keyed by x/5 and never shrinks upstream.
      var hi = Math.floor((worldX - 4000) / 5);
      if (planLow < -1e8) planLow = Math.floor(MEM.xmin / 5) - 1;
      for (; planLow < hi; planLow++) delete MEM.planmtx[planLow];
    }

    return {
      gen: m.gen,
      work: function (upTo) {
        if (nextTile > upTo) return { more: false };
        var wxEnd = ((nextTile + 1) * TW) / scale;
        if (MEM.xmax - LEAD < wxEnd) {
          generateOne();
          return { more: true };
        }
        var r = renderTile(nextTile);
        r.index = nextTile;
        nextTile++;
        prune((nextTile * TW) / scale);
        r.more = nextTile <= upTo;
        return r;
      },
    };
  }
}
