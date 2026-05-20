/* =================================================================== *
 *  Investor Portal — editor runtime
 *  Password gate · AES viewer · Worker editor · live collaborative edit
 *  Injected into the public shell by build.py. Contains NO data.
 * =================================================================== */
(function () {
  "use strict";

  var CFG = window.__PORTAL_CONFIG__ || {};
  var WORKER_URL = (typeof CFG.workerUrl === "string" && CFG.workerUrl) ? CFG.workerUrl.replace(/\/+$/, "") : null;
  var SNAPSHOT_URL = CFG.snapshotUrl || "data/snapshot.enc";
  var ITER = CFG.pbkdf2Iterations || 100000;
  var SYNC_MS = 5000;

  var MODE = "locked";            // locked | viewer | editor
  var state = null;               // canonical state object
  var EDITOR_TOKEN = null;
  var viewerPw = null;            // kept in memory for viewer auto-refresh
  var encB64Cache = null;
  var lastSeenUpdatedAt = "";
  var myName = localStorage.getItem("ipf-name") || ("Editor-" + Math.floor(Math.random() * 900 + 100));

  var DIRTY = false;
  var dirtyUnits = Object.create(null);   // unitId -> true
  var chartDirty = Object.create(null);   // canvasId -> true
  var orderDirty = false;
  var sortable = null;
  var nestedSortables = [];
  var syncTimer = null;

  var $app = document.getElementById("app");

  /* ------------------------------------------------------------------ */
  /*  utilities                                                          */
  /* ------------------------------------------------------------------ */
  function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error("load failed: " + src)); };
      document.head.appendChild(s);
    });
  }
  function toast(msg, kind) {
    var wrap = document.querySelector(".eh-toast-wrap");
    if (!wrap) { wrap = el("div", { "class": "eh-toast-wrap" }); document.body.appendChild(wrap); }
    var t = el("div", { "class": "eh-toast " + (kind || "info") }, null);
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(function () { t.remove(); }, 320); }, 2600);
  }
  function setConn(kind, txt) {
    var c = document.getElementById("eh-conn");
    if (!c) return;
    c.className = "eh-conn " + kind;
    var s = c.querySelector("span"); if (s) s.textContent = txt;
  }

  /* ------------------------------------------------------------------ */
  /*  base64 + AES-256-CBC + PBKDF2 (openssl-compatible, byte-identical  */
  /*  to publish.sh / worker.js)                                         */
  /* ------------------------------------------------------------------ */
  function b64ToBytes(b64) {
    var bin = atob(b64.replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function decryptOpenSSL(b64, password) {
    // The stored file is itself base64 ASCII (openssl -base64 -A). When fetched
    // over HTTP we get that ASCII directly.
    var bytes = b64ToBytes(b64);
    if (bytes.length < 16) throw new Error("ciphertext too short");
    var magic = String.fromCharCode.apply(null, bytes.slice(0, 8));
    if (magic !== "Salted__") throw new Error("bad header");
    var salt = bytes.slice(8, 16);
    var ct = bytes.slice(16);
    var passKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    var derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: ITER, hash: "SHA-256" }, passKey, 48 * 8);
    var keyBytes = new Uint8Array(derived, 0, 32);
    var ivBytes = new Uint8Array(derived, 32, 16);
    var aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    var plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, aesKey, ct);
    return new TextDecoder().decode(plain);
  }

  /* ------------------------------------------------------------------ */
  /*  state normalization                                                */
  /*  Accepts either the initial seed {bodyHTML, appScript} or the        */
  /*  structured {order, sections, appScript}. Always returns structured. */
  /* ------------------------------------------------------------------ */
  function parseBodyToUnits(bodyHTML) {
    var tmp = el("div", null, bodyHTML);
    var order = [], sections = {};
    var idx = 0;
    Array.prototype.forEach.call(tmp.children, function (node) {
      if (node.nodeType !== 1) return;
      var id = node.id || ("u" + (idx++));
      node.setAttribute("data-eh-unit", id);
      order.push(id);
      sections[id] = { html: node.outerHTML, updatedAt: nowIso(), updatedBy: "seed" };
    });
    return { order: order, sections: sections };
  }
  function normalize(s) {
    s = s || {};
    if (!s.sections || !s.order) {
      var parsed = parseBodyToUnits(s.bodyHTML || "");
      s.order = parsed.order;
      s.sections = parsed.sections;
    }
    if (!s.meta) s.meta = { title: CFG.title || "Investor Portal" };
    if (typeof s.appScript !== "string") s.appScript = "";
    if (!s.chartData || typeof s.chartData !== "object") s.chartData = {};  // canvasId -> {labels, datasets:[[..],..]}
    if (!s.version) s.version = 3;
    return s;
  }

  /* ------------------------------------------------------------------ */
  /*  rendering                                                          */
  /* ------------------------------------------------------------------ */
  function buildUnitNode(id, html) {
    var tmp = el("div", null, html);
    var node = tmp.firstElementChild;
    if (!node) { node = el("section", null, ""); }
    node.setAttribute("data-eh-unit", id);
    return node;
  }
  function destroyCharts() {
    if (!window.Chart || !Chart.getChart) return;
    document.querySelectorAll("canvas").forEach(function (c) {
      var ex = Chart.getChart(c); if (ex) { try { ex.destroy(); } catch (e) {} }
    });
  }
  function runAppScript(js) {
    if (!js) { requestAnimationFrame(applyChartOverrides); return; }
    destroyCharts();
    requestAnimationFrame(function () {
      try { (new Function(js))(); }
      catch (e) { console.error("[portal] appScript error:", e); }
      requestAnimationFrame(applyChartOverrides);   // charts now exist -> patch their data
    });
  }
  // Apply stored per-chart data overrides onto the live Chart.js instances.
  // Styling stays in appScript; only labels + dataset values are overridden.
  function applyChartOverrides() {
    if (!window.Chart || !window.Chart.getChart || !state || !state.chartData) return;
    document.querySelectorAll("canvas").forEach(function (cv) {
      if (!cv.id) return;
      var ov = state.chartData[cv.id];
      if (!ov) return;
      var ch = window.Chart.getChart(cv);
      if (!ch) return;
      if (Array.isArray(ov.labels)) ch.data.labels = ov.labels.slice();
      if (Array.isArray(ov.datasets)) {
        ov.datasets.forEach(function (arr, i) {
          if (ch.data.datasets[i] && Array.isArray(arr)) ch.data.datasets[i].data = arr.slice();
        });
      }
      try { ch.update(); } catch (e) {}
    });
  }
  function renderState(s) {
    state = normalize(s);
    if (state.meta && state.meta.title) document.title = state.meta.title;
    $app.innerHTML = "";
    state.order.forEach(function (id) {
      var unit = state.sections[id];
      if (!unit) return;
      $app.appendChild(buildUnitNode(id, unit.html));
    });
    lastSeenUpdatedAt = state.updatedAt || lastSeenUpdatedAt;
    runAppScript(state.appScript);
    document.body.classList.remove("portal-locked");
    $app.setAttribute("aria-busy", "false");
    if (MODE === "editor") decorateEditing();
  }

  /* ------------------------------------------------------------------ */
  /*  editor: which text elements become contenteditable                */
  /* ------------------------------------------------------------------ */
  // DIV is included but the leaf-only child check below means only DIVs whose
  // children are all inline (text divs like .section-kicker, stat numbers)
  // become editable — layout/wrapper DIVs with block children are skipped.
  var EDITABLE = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "SPAN", "LI", "TD", "TH", "EM", "STRONG", "B", "I", "A", "LABEL", "FIGCAPTION", "BLOCKQUOTE", "DT", "DD", "DIV"];
  var INLINE_OK = ["SPAN", "STRONG", "EM", "B", "I", "BR", "SUP", "SUB", "SMALL", "A", "U"];
  var SKIP_SEL = "canvas,svg,script,style,.eh-ctl,.eh-resize,.eh-bar";
  function isEditable(node) {
    if (!node || node.nodeType !== 1 || EDITABLE.indexOf(node.tagName) === -1) return false;
    if (node.closest(SKIP_SEL)) return false;
    if (!node.textContent.trim()) return false;
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 1 && INLINE_OK.indexOf(n.tagName) === -1) return false;
    }
    return true;
  }

  function decorateUnit(unitNode) {
    var id = unitNode.getAttribute("data-eh-unit");
    var isNav = unitNode.tagName === "NAV";
    var isSection = unitNode.tagName === "SECTION";

    // contenteditable on text blocks
    unitNode.querySelectorAll("*").forEach(function (n) {
      if (isEditable(n)) n.setAttribute("contenteditable", "true");
    });
    if (isEditable(unitNode)) unitNode.setAttribute("contenteditable", "true");

    // chart "Edit data" button over each canvas
    unitNode.querySelectorAll("canvas").forEach(function (cv) {
      if (!cv.id) cv.id = "cv" + Math.random().toString(36).slice(2, 9);
      var host = cv.parentElement || unitNode;
      host.classList.add("eh-chart-host");
      if (!host.querySelector(":scope > .eh-chart-edit")) {
        var b = el("button", { "class": "eh-chart-edit", title: "Edit chart data" }, "📊 Edit data");
        b.addEventListener("click", function (ev) {
          ev.stopPropagation(); ev.preventDefault();
          openChartEditor(cv.id, id);
        });
        host.appendChild(b);
      }
    });

    // drag-to-reorder elements WITHIN this unit (card grids, lists, metric rows)
    initNestedSortables(unitNode, id);

    if (!isSection) return;  // only sections get drag/resize/hide chrome

    // control chip (drag + hide)
    if (!unitNode.querySelector(":scope > .eh-ctl")) {
      var ctl = el("div", { "class": "eh-ctl" });
      var drag = el("button", { "class": "eh-handle", title: "Drag to reorder" }, "☰");
      var hide = el("button", { "class": "eh-hide", title: "Hide / show this section" }, "👁");
      hide.addEventListener("click", function (ev) {
        ev.stopPropagation();
        unitNode.classList.toggle("eh-hidden");
        markUnitDirty(id);
      });
      ctl.appendChild(drag); ctl.appendChild(hide);
      unitNode.appendChild(ctl);
    }
    // resize handle
    if (!unitNode.querySelector(":scope > .eh-resize")) {
      var rz = el("div", { "class": "eh-resize", title: "Drag to resize" });
      attachResize(rz, unitNode, id);
      unitNode.appendChild(rz);
    }
  }

  function decorateEditing() {
    nestedSortables.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    nestedSortables = [];
    Array.prototype.forEach.call($app.children, function (n) {
      if (n.nodeType === 1) decorateUnit(n);
    });
    initSortable();
  }

  function attachResize(handle, unitNode, id) {
    handle.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      var container = unitNode.querySelector(".container") || unitNode;
      var startX = e.clientX, startY = e.clientY;
      var startW = container.getBoundingClientRect().width;
      var startH = unitNode.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      function move(ev) {
        var w = Math.max(320, Math.round(startW + (ev.clientX - startX)));
        var h = Math.max(80, Math.round(startH + (ev.clientY - startY)));
        container.style.maxWidth = w + "px";
        container.style.marginLeft = "auto"; container.style.marginRight = "auto";
        unitNode.style.minHeight = h + "px";
      }
      function up(ev) {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        markUnitDirty(id);
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  function initSortable() {
    if (!window.Sortable) return;
    if (sortable) { try { sortable.destroy(); } catch (e) {} sortable = null; }
    sortable = window.Sortable.create($app, {
      draggable: "section[data-eh-unit]",
      handle: ".eh-handle",
      animation: 160,
      ghostClass: "eh-ghost",
      chosenClass: "eh-chosen",
      onEnd: function () { orderDirty = true; setDirty(true); }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  intra-section drag: reorder cards/list-items inside a section      */
  /* ------------------------------------------------------------------ */
  function initNestedSortables(unitNode, sectionId) {
    if (!window.Sortable) return;
    var candidates = [];
    unitNode.querySelectorAll("*").forEach(function (c) {
      if (c === unitNode) return;
      if (c.matches(".eh-ctl,.eh-resize,.eh-bar,.eh-grip,.eh-chart-edit")) return;
      if (c.closest(".eh-ctl,.eh-resize")) return;
      if (c.querySelector("canvas")) return;          // don't reorder chart wrappers
      var kids = Array.prototype.filter.call(c.children, function (k) {
        return k.nodeType === 1 && !k.matches(".eh-ctl,.eh-resize,.eh-grip,.eh-chart-edit");
      });
      if (kids.length < 2) return;
      // dominant tag must repeat (card grid / list), not a mixed text block
      var tags = {}, top = 0;
      kids.forEach(function (k) { tags[k.tagName] = (tags[k.tagName] || 0) + 1; if (tags[k.tagName] > top) top = tags[k.tagName]; });
      if (top < 2) return;
      // children must be "card-like": list/table rows, or compound blocks with their own children
      var cardish = kids.every(function (k) {
        return k.tagName === "LI" || k.tagName === "TR" || k.children.length >= 1;
      });
      if (!cardish) return;
      candidates.push({ el: c, kids: kids });
    });
    // keep only innermost containers (a parent that contains another candidate is skipped)
    var keep = candidates.filter(function (ci) {
      return !candidates.some(function (cj) { return cj.el !== ci.el && ci.el.contains(cj.el); });
    });
    keep.forEach(function (ci) {
      ci.kids.forEach(function (k) {
        k.classList.add("eh-has-grip");
        if (!k.querySelector(":scope > .eh-grip")) {
          k.appendChild(el("button", { "class": "eh-grip", title: "Drag to reorder" }, "⠿"));
        }
      });
      try {
        nestedSortables.push(window.Sortable.create(ci.el, {
          handle: ".eh-grip", animation: 140,
          ghostClass: "eh-ghost", chosenClass: "eh-chosen",
          onEnd: function () { markUnitDirty(sectionId); }
        }));
      } catch (e) {}
    });
  }

  /* ------------------------------------------------------------------ */
  /*  chart data editor (spreadsheet-style + paste from Excel)           */
  /* ------------------------------------------------------------------ */
  function readChart(canvasId) {
    var cv = document.getElementById(canvasId);
    var ch = cv && window.Chart && window.Chart.getChart ? window.Chart.getChart(cv) : null;
    if (!ch) return null;
    return {
      labels: (ch.data.labels || []).map(function (x) { return x; }),
      datasets: (ch.data.datasets || []).map(function (d) {
        return { label: d.label || "", data: (d.data || []).map(function (v) { return v; }) };
      })
    };
  }
  function closeModal() { var m = document.querySelector(".eh-modal-ov"); if (m) m.remove(); }
  function openChartEditor(canvasId, sectionId) {
    var cur = readChart(canvasId);
    if (!cur) { toast("Chart not ready yet — try again in a moment.", "err"); return; }

    var ov = el("div", { "class": "eh-modal-ov" });
    var box = el("div", { "class": "eh-modal" });
    box.innerHTML =
      '<h3>Edit chart data</h3>' +
      '<div class="eh-modal-sub">Type values directly, or paste a block copied from Excel/Sheets below. The chart updates when you click Apply.</div>' +
      '<div class="eh-grid-wrap"><table class="eh-grid"></table></div>' +
      '<div class="eh-hint-sm" style="margin-bottom:8px">Paste from Excel — first row = labels, each next row = one dataset’s values (dataset names are kept):</div>' +
      '<textarea class="eh-paste" placeholder="Jul&#9;Aug&#9;Sep\n143&#9;2509&#9;882\n143&#9;321&#9;882"></textarea>' +
      '<div class="eh-modal-row"><button class="eh-mbtn" id="eh-fill">Fill grid from paste</button></div>' +
      '<div class="eh-modal-actions">' +
        '<button class="eh-mbtn" id="eh-cancel">Cancel</button>' +
        '<button class="eh-mbtn primary" id="eh-apply">Apply to chart</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);

    var table = box.querySelector("table.eh-grid");
    function renderGrid(model) {
      var html = "<tr><td class='eh-rowlbl'>Label →</td>";
      model.labels.forEach(function (lb, i) {
        html += "<td><input class='eh-lbl-in' data-col='" + i + "' value='" + String(lb).replace(/'/g, "&#39;") + "'></td>";
      });
      html += "</tr>";
      model.datasets.forEach(function (ds, r) {
        html += "<tr><td class='eh-rowlbl'>" + (ds.label || ("Series " + (r + 1))) + "</td>";
        model.labels.forEach(function (_, c) {
          var v = ds.data[c]; if (v == null) v = "";
          html += "<td><input data-row='" + r + "' data-col='" + c + "' value='" + String(v).replace(/'/g, "&#39;") + "'></td>";
        });
        html += "</tr>";
      });
      table.innerHTML = html;
    }
    function gridToModel() {
      var labels = [];
      table.querySelectorAll("input.eh-lbl-in").forEach(function (inp) { labels[+inp.dataset.col] = inp.value; });
      var datasets = cur.datasets.map(function (ds) { return { label: ds.label, data: [] }; });
      table.querySelectorAll("input[data-row]").forEach(function (inp) {
        var r = +inp.dataset.row, c = +inp.dataset.col;
        var raw = inp.value.trim().replace(/[, ]/g, "");
        var num = raw === "" ? null : Number(raw);
        datasets[r].data[c] = (raw !== "" && isFinite(num)) ? num : inp.value;
      });
      return { labels: labels, datasets: datasets };
    }
    renderGrid(cur);

    box.querySelector("#eh-fill").addEventListener("click", function () {
      var txt = box.querySelector(".eh-paste").value.replace(/\r/g, "");
      if (!txt.trim()) return;
      var rows = txt.split("\n").filter(function (l) { return l.trim() !== ""; })
                    .map(function (l) { return l.split("\t"); });
      if (!rows.length) return;
      var model = { labels: rows[0].slice(), datasets: [] };
      var body = rows.slice(1);
      cur.datasets.forEach(function (ds, i) {
        var src = body[i] || [];
        // if the first cell of the row is non-numeric, treat it as a name and drop it
        if (src.length === model.labels.length + 1 && isNaN(Number(src[0].replace(/[, ]/g, "")))) src = src.slice(1);
        var data = model.labels.map(function (_, c) {
          var raw = (src[c] || "").trim().replace(/[, ]/g, "");
          var n = raw === "" ? null : Number(raw);
          return (raw !== "" && isFinite(n)) ? n : (src[c] || "");
        });
        model.datasets.push({ label: ds.label, data: data });
      });
      cur = model; renderGrid(model);
      toast("Grid filled from paste — review, then Apply.", "info");
    });
    box.querySelector("#eh-cancel").addEventListener("click", closeModal);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeModal(); });
    box.querySelector("#eh-apply").addEventListener("click", function () {
      var model = gridToModel();
      state.chartData = state.chartData || {};
      state.chartData[canvasId] = { labels: model.labels, datasets: model.datasets.map(function (d) { return d.data; }) };
      chartDirty[canvasId] = true;
      applyChartOverrides();
      markUnitDirty(sectionId);
      closeModal();
      toast("Chart updated — click Save changes to publish.", "ok");
    });
  }

  /* ------------------------------------------------------------------ */
  /*  text formatting toolbar (color / bold / italic) — Google-Docs-ish  */
  /* ------------------------------------------------------------------ */
  var SWATCHES = ["#0a0a08", "#5F2EEA", "#1a60e8", "#12a05c", "#d97706", "#d93b3b", "#7c3aed", "#0891b2", "#6b6b68", "#ffffff"];
  function initFormatBar() {
    if (document.querySelector(".eh-fmt")) return;
    var bar = el("div", { "class": "eh-fmt" });
    var html = '<button data-cmd="bold" title="Bold" style="font-weight:800">B</button>' +
               '<button data-cmd="italic" title="Italic" style="font-style:italic">I</button>' +
               '<button data-cmd="underline" title="Underline" style="text-decoration:underline">U</button>' +
               '<span class="eh-fmt-sep"></span>';
    SWATCHES.forEach(function (c) { html += '<button class="eh-sw" data-color="' + c + '" title="' + c + '" style="background:' + c + '"></button>'; });
    html += '<label title="Custom colour"><input type="color" id="eh-fmt-color" value="#5F2EEA"></label>' +
            '<span class="eh-fmt-sep"></span>' +
            '<button data-cmd="removeFormat" title="Clear formatting">⌫</button>';
    bar.innerHTML = html;
    document.body.appendChild(bar);

    // prevent the toolbar from stealing the selection
    bar.addEventListener("mousedown", function (e) { e.preventDefault(); });

    function activeUnit() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      var node = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentElement;
      var ce = node && node.closest ? node.closest('[contenteditable="true"]') : null;
      if (!ce) return null;
      var unit = node.closest("[data-eh-unit]");
      return unit ? unit.getAttribute("data-eh-unit") : null;
    }
    function applyCmd(cmd, val) {
      var uid = activeUnit();
      try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
      document.execCommand(cmd, false, val || null);
      if (uid) markUnitDirty(uid);
    }
    bar.querySelectorAll("button[data-cmd]").forEach(function (b) {
      b.addEventListener("click", function () { applyCmd(b.getAttribute("data-cmd")); });
    });
    bar.querySelectorAll("button[data-color]").forEach(function (b) {
      b.addEventListener("click", function () { applyCmd("foreColor", b.getAttribute("data-color")); });
    });
    bar.querySelector("#eh-fmt-color").addEventListener("input", function (e) { applyCmd("foreColor", e.target.value); });

    function place() {
      if (MODE !== "editor") return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { bar.classList.remove("show"); return; }
      if (!activeUnit()) { bar.classList.remove("show"); return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { bar.classList.remove("show"); return; }
      bar.classList.add("show");
      var top = rect.top + window.scrollY - bar.offsetHeight - 8;
      if (top < window.scrollY + 4) top = rect.bottom + window.scrollY + 8;
      var left = rect.left + window.scrollX + rect.width / 2 - bar.offsetWidth / 2;
      left = Math.max(8, Math.min(left, window.scrollX + document.documentElement.clientWidth - bar.offsetWidth - 8));
      bar.style.top = top + "px"; bar.style.left = left + "px";
    }
    document.addEventListener("selectionchange", place);
    window.addEventListener("scroll", function () { if (bar.classList.contains("show")) place(); }, true);
  }

  /* ------------------------------------------------------------------ */
  /*  dirty tracking                                                     */
  /* ------------------------------------------------------------------ */
  function markUnitDirty(id) { if (id) dirtyUnits[id] = true; setDirty(true); }
  function setDirty(v) {
    DIRTY = v;
    var btn = document.getElementById("eh-save");
    if (btn) { btn.classList.toggle("dirty", v); btn.textContent = v ? "Save changes •" : "Saved"; }
  }

  /* ------------------------------------------------------------------ */
  /*  serialization                                                      */
  /* ------------------------------------------------------------------ */
  function serializeUnit(unitNode) {
    var clone = unitNode.cloneNode(true);
    clone.querySelectorAll(".eh-ctl,.eh-resize,.eh-grip,.eh-chart-edit").forEach(function (n) { n.remove(); });
    clone.querySelectorAll("[contenteditable]").forEach(function (n) { n.removeAttribute("contenteditable"); });
    clone.querySelectorAll(".eh-has-grip").forEach(function (n) { n.classList.remove("eh-has-grip"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    clone.querySelectorAll(".eh-chart-host").forEach(function (n) { n.classList.remove("eh-chart-host"); if (!n.getAttribute("class")) n.removeAttribute("class"); });
    clone.classList.remove("eh-chosen", "eh-ghost", "eh-drag-over");
    return clone.outerHTML;
  }
  function currentOrder() {
    var ids = [];
    Array.prototype.forEach.call($app.children, function (n) {
      if (n.nodeType === 1 && n.getAttribute("data-eh-unit")) ids.push(n.getAttribute("data-eh-unit"));
    });
    return ids;
  }
  function unitNodeById(id) { return $app.querySelector('[data-eh-unit="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); }

  /* ------------------------------------------------------------------ */
  /*  worker calls                                                       */
  /* ------------------------------------------------------------------ */
  async function workerJson(path, body) {
    var r = await fetch(WORKER_URL + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    return r;
  }
  async function fetchRemoteState() {
    var r = await workerJson("/api/snapshot", { token: EDITOR_TOKEN });
    if (r.status === 401) { sessionExpired(); throw new Error("unauthorized"); }
    if (!r.ok) throw new Error("snapshot HTTP " + r.status);
    var j = await r.json();
    return normalize(j.state);
  }
  function sessionExpired() {
    sessionStorage.removeItem("ipf-token"); EDITOR_TOKEN = null;
    toast("Session expired — reload and re-enter the editor password.", "err");
  }

  /* ------------------------------------------------------------------ */
  /*  SAVE — section-level merge so two editors don't clobber            */
  /* ------------------------------------------------------------------ */
  async function saveNow() {
    if (MODE !== "editor" || !WORKER_URL || !EDITOR_TOKEN) { toast("Editor/worker not configured.", "err"); return; }
    var btn = document.getElementById("eh-save");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      var remote = await fetchRemoteState();           // freshest base
      var merged = remote;
      // my edited sections win
      Object.keys(dirtyUnits).forEach(function (id) {
        var node = unitNodeById(id);
        if (!node) return;
        merged.sections[id] = { html: serializeUnit(node), updatedAt: nowIso(), updatedBy: myName };
      });
      // order: mine if I reordered, else keep remote but append any new ids
      if (orderDirty) {
        merged.order = currentOrder();
      } else {
        var have = {}; merged.order.forEach(function (i) { have[i] = 1; });
        currentOrder().forEach(function (i) { if (!have[i]) merged.order.push(i); });
      }
      // keep appScript + meta from whoever has them (chart STYLING lives here)
      merged.appScript = remote.appScript || state.appScript || "";
      merged.meta = state.meta || merged.meta;
      // chart DATA overrides: start from remote, my edited charts win
      merged.chartData = (remote.chartData && typeof remote.chartData === "object") ? remote.chartData : {};
      Object.keys(chartDirty).forEach(function (cid) {
        if (state.chartData && state.chartData[cid]) merged.chartData[cid] = state.chartData[cid];
      });
      merged.version = 3;
      merged.updatedAt = nowIso();
      merged.updatedBy = myName;

      var r = await workerJson("/api/commit", { token: EDITOR_TOKEN, state: merged, message: "edit by " + myName });
      if (r.status === 401) { sessionExpired(); return; }
      if (!r.ok) { var t = await r.text(); throw new Error("HTTP " + r.status + " " + t); }
      var j = await r.json();

      // adopt merged as truth; reflect other editors' non-conflicting changes
      applyRemoteUnits(merged, {});      // dirty already merged in, safe to apply all
      state = merged;
      dirtyUnits = Object.create(null); chartDirty = Object.create(null); orderDirty = false; setDirty(false);
      lastSeenUpdatedAt = merged.updatedAt;
      toast("Saved ✓  (published, live in ~30s)", "ok");
    } catch (e) {
      toast("Save failed: " + (e.message || e), "err");
    } finally {
      if (btn) { btn.disabled = false; setDirty(DIRTY); }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  apply remote units into the DOM without disturbing edited ones     */
  /* ------------------------------------------------------------------ */
  function applyRemoteUnits(remote, skip) {
    remote = normalize(remote);
    var needFull = false;

    // adopt remote chart-data overrides for charts I'm not actively editing
    state = state || {}; state.chartData = state.chartData || {};
    if (remote.chartData) {
      Object.keys(remote.chartData).forEach(function (cid) {
        if (!chartDirty[cid]) state.chartData[cid] = remote.chartData[cid];
      });
    }

    // patch / insert
    remote.order.forEach(function (id) {
      if (skip[id]) return;
      var ru = remote.sections[id]; if (!ru) return;
      var node = unitNodeById(id);
      if (!node) { needFull = true; return; }                 // new section appeared
      if (serializeUnit(node) === ru.html) return;            // unchanged
      if (node.querySelector("canvas")) { needFull = true; return; } // chart section -> full rerender
      var fresh = buildUnitNode(id, ru.html);
      node.replaceWith(fresh);
      decorateUnit(fresh);
    });

    // reorder to match remote (only if user hasn't manually reordered)
    if (!orderDirty) {
      var desired = remote.order.filter(function (id) { return !!unitNodeById(id); });
      desired.forEach(function (id) {
        var node = unitNodeById(id);
        if (node) $app.appendChild(node);   // appends in order => final order == desired
      });
    }

    if (needFull) {
      // full re-render (charts changed or new sections). Preserves my dirty units
      // only if none are dirty; if some are dirty we keep DOM and skip.
      if (Object.keys(dirtyUnits).length === 0) {
        renderState(remote);
        if (MODE === "editor") { /* decorateEditing already called in renderState */ }
      }
    } else {
      initSortable();
      applyChartOverrides();   // reflect collaborator's chart-data edits without a full re-render
    }
  }

  /* ------------------------------------------------------------------ */
  /*  auto-sync (editor) + auto-refresh (viewer)                         */
  /* ------------------------------------------------------------------ */
  function startEditorSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(async function () {
      if (MODE !== "editor" || !EDITOR_TOKEN) return;
      // don't yank text the user is actively typing into
      if (document.activeElement && document.activeElement.isContentEditable) return;
      try {
        var remote = await fetchRemoteState();
        if (!remote.updatedAt || remote.updatedAt === lastSeenUpdatedAt) return;
        if (remote.updatedBy === myName) { lastSeenUpdatedAt = remote.updatedAt; return; }
        applyRemoteUnits(remote, dirtyUnits);
        lastSeenUpdatedAt = remote.updatedAt;
        toast("Synced changes from " + (remote.updatedBy || "your collaborator"), "info");
      } catch (e) { /* transient; ignore */ }
    }, SYNC_MS);
  }
  function startViewerRefresh() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(async function () {
      if (MODE !== "viewer" || !viewerPw) return;
      try {
        var enc = await fetch(SNAPSHOT_URL, { cache: "no-store" }).then(function (r) { return r.text(); });
        if (enc === encB64Cache) return;
        var json = await decryptOpenSSL(enc, viewerPw);
        var s = normalize(JSON.parse(json));
        if (s.updatedAt && s.updatedAt !== lastSeenUpdatedAt) { encB64Cache = enc; renderState(s); }
      } catch (e) { /* ignore */ }
    }, 20000);
  }

  /* ------------------------------------------------------------------ */
  /*  mode entry                                                         */
  /* ------------------------------------------------------------------ */
  async function enterEditor(token, remoteState) {
    EDITOR_TOKEN = token;
    sessionStorage.setItem("ipf-token", token);
    MODE = "editor";
    document.body.classList.remove("portal-locked", "portal-viewer");
    document.body.classList.add("portal-editor");
    try { await loadScript("https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"); } catch (e) {}
    renderState(remoteState);
    buildToolbar();
    initFormatBar();
    setConn("ok", "editor — live");
    startEditorSync();
    // delegated input listener => mark the edited section dirty
    $app.addEventListener("input", function (ev) {
      var unit = ev.target.closest && ev.target.closest("[data-eh-unit]");
      if (unit) markUnitDirty(unit.getAttribute("data-eh-unit"));
    });
    window.addEventListener("beforeunload", function (ev) { if (DIRTY) { ev.preventDefault(); ev.returnValue = ""; } });
  }
  function enterViewer(s, pw) {
    MODE = "viewer"; viewerPw = pw;
    document.body.classList.remove("portal-locked", "portal-editor");
    document.body.classList.add("portal-viewer");
    renderState(s);
    startViewerRefresh();
  }

  function buildToolbar() {
    if (document.querySelector(".eh-bar")) return;
    var bar = el("div", { "class": "eh-bar" });
    bar.innerHTML =
      '<span class="eh-badge">EDITOR</span>' +
      '<span class="eh-conn ok" id="eh-conn"><i></i><span>editor — live</span></span>' +
      '<span class="eh-name">editing as <b id="eh-whoami"></b> <button class="eh-btn" id="eh-rename" style="padding:3px 8px">rename</button></span>' +
      '<span class="eh-spacer"></span>' +
      '<button class="eh-btn" id="eh-help">How editing works</button>' +
      '<button class="eh-btn primary" id="eh-save">Saved</button>' +
      '<button class="eh-btn" id="eh-signout">sign out</button>';
    document.body.appendChild(bar);
    document.getElementById("eh-whoami").textContent = myName;
    document.getElementById("eh-save").addEventListener("click", saveNow);
    document.getElementById("eh-rename").addEventListener("click", function () {
      var n = prompt("Your name (shown to your collaborator on sync):", myName);
      if (n && n.trim()) { myName = n.trim(); localStorage.setItem("ipf-name", myName); document.getElementById("eh-whoami").textContent = myName; }
    });
    document.getElementById("eh-signout").addEventListener("click", function () {
      if (DIRTY && !confirm("You have unsaved edits. Sign out anyway?")) return;
      sessionStorage.removeItem("ipf-token"); location.reload();
    });
    document.getElementById("eh-help").addEventListener("click", function () {
      alert("EDITING\n\n• Click any text to edit it inline. Select text to get a floating toolbar for COLOUR, bold, italic & underline.\n• Hover a section: drag the ☰ handle to reorder sections, click 👁 to hide/show, drag the bottom-right corner to resize.\n• Hover a card / list item: drag its ⠿ grip to reorder elements WITHIN a section.\n• Hover a chart: click “📊 Edit data” to change the numbers (type them, or paste a block from Excel). The chart updates live.\n• Click “Save changes” to publish. Your collaborator sees your saved changes within ~5 seconds.\n• You can both edit different sections at the same time safely. If you edit the SAME section, the last save wins.");
    });
  }

  /* ------------------------------------------------------------------ */
  /*  password gate                                                      */
  /* ------------------------------------------------------------------ */
  function promptPassword(errMsg, busy) {
    return new Promise(function (resolve) {
      var prev = document.querySelector(".pg-overlay");
      if (prev) prev.remove();
      var ov = el("div", { "class": "pg-overlay" });
      ov.innerHTML =
        '<div class="pg-card">' +
        '<div class="pg-brand"><span class="pg-dot"></span><b>Nbyula</b></div>' +
        '<div class="pg-title">Investor Portal</div>' +
        '<div class="pg-sub">Pre‑Series A 2026 · confidential. Enter your access password to continue.</div>' +
        '<input class="pg-input" type="password" id="pg-pw" placeholder="Access password" autofocus />' +
        '<button class="pg-btn" id="pg-go">Unlock</button>' +
        '<div class="pg-err" id="pg-err">' + (errMsg || "") + '</div>' +
        '<div class="pg-hint">Viewer password → read‑only. Editor password → live editing.</div>' +
        '</div>';
      document.body.appendChild(ov);
      var input = ov.querySelector("#pg-pw"), go = ov.querySelector("#pg-go");
      function submit() {
        var v = input.value; if (!v) return;
        go.disabled = true; go.textContent = "Checking…";
        ov.remove(); resolve(v);
      }
      go.addEventListener("click", submit);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      setTimeout(function () { input.focus(); }, 30);
    });
  }

  async function enterDemo(seed) {
    MODE = "editor";
    document.body.classList.remove("portal-locked", "portal-viewer");
    document.body.classList.add("portal-editor");
    try { await loadScript("https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"); } catch (e) {}
    renderState(seed);
    buildToolbar();
    initFormatBar();
    var b = document.getElementById("eh-save");
    if (b) b.textContent = "Demo — edits not saved";
    setConn("warn", "DEMO (local only)");
    $app.addEventListener("input", function (ev) {
      var unit = ev.target.closest && ev.target.closest("[data-eh-unit]");
      if (unit) markUnitDirty(unit.getAttribute("data-eh-unit"));
    });
    // in demo, Save just shows a toast
    var save = document.getElementById("eh-save");
    if (save) { save.onclick = function () { toast("This is a preview — connect the Worker to save for real.", "info"); }; }
  }

  async function boot() {
    if (!$app) return;
    document.title = CFG.title || document.title;

    // DEMO preview: no password, no worker, edits are local only
    if (window.__PORTAL_DEMO__ && window.__SEED__) { await enterDemo(window.__SEED__); return; }

    // resume an editor session if we have a cached token
    var cached = sessionStorage.getItem("ipf-token");
    if (cached && WORKER_URL) {
      try {
        var r = await fetch(WORKER_URL + "/api/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cached }) });
        if (r.ok) { var j = await r.json(); await enterEditor(cached, j.state); return; }
        sessionStorage.removeItem("ipf-token");
      } catch (e) { /* fall through to gate */ }
    }

    // pre-fetch the encrypted snapshot so the viewer path works even if the
    // worker is unreachable
    try { encB64Cache = await fetch(SNAPSHOT_URL, { cache: "no-store" }).then(function (r) { if (!r.ok) throw 0; return r.text(); }); }
    catch (e) { encB64Cache = null; }

    var lastErr = "";
    for (var attempt = 0; attempt < 8; attempt++) {
      var pw = await promptPassword(lastErr);
      // 1) try the worker (tells us editor vs viewer)
      if (WORKER_URL) {
        try {
          var a = await fetch(WORKER_URL + "/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
          if (a.ok) {
            var aj = await a.json();
            if (aj.role === "editor" && aj.token) {
              var sn = await fetch(WORKER_URL + "/api/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: aj.token }) });
              if (sn.ok) { var snj = await sn.json(); await enterEditor(aj.token, snj.state); return; }
              lastErr = "Editor OK but snapshot fetch failed (" + sn.status + ")."; continue;
            }
            // role viewer -> fall through to client-side decrypt with pw
          } else if (a.status === 401) {
            lastErr = "Wrong password.";
            // still try AES below in case worker secrets drifted
          }
        } catch (e) { /* worker unreachable -> AES path */ }
      }
      // 2) client-side AES decrypt (viewer)
      if (!encB64Cache) { lastErr = "Snapshot unavailable and worker unreachable."; continue; }
      try {
        var json = await decryptOpenSSL(encB64Cache, pw);
        enterViewer(normalize(JSON.parse(json)), pw);
        return;
      } catch (e2) { lastErr = "Wrong password."; }
    }
    document.body.innerHTML = '<div style="font:14px system-ui;padding:40px;color:#555">Too many attempts. Refresh to try again.</div>';
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
