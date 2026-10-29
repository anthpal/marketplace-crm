/* eslint-env browser, webextensions */

/**
 * popup.js — panel de la acción de la extensión.
 *
 * No lee Facebook por su cuenta: pregunta al content script de la pestaña
 * activa (`MCRM_GET_REPORT`) y pinta el informe que ya calculó él. Cada fila
 * va de verde (dato leído) o de rojo (error o dato ausente).
 *
 * Si el content script aún está esperando a GraphQL, el popup vuelve a
 * preguntar cada POLL_MS hasta MAX_POLLS veces.
 */
(function () {
  "use strict";

  var POLL_MS = 700;
  var MAX_POLLS = 30;

  var ui = {
    ctx: document.getElementById("ctx"),
    badge: document.getElementById("badge"),
    summary: document.getElementById("summary"),
    stats: document.getElementById("stats"),
    rows: document.getElementById("rows"),
    empty: document.getElementById("empty"),
    refresh: document.getElementById("refresh"),
    copy: document.getElementById("copy"),
  };

  var state = { tabId: null, report: null, polls: 0, timer: null, retries: 0 };

  var LEVEL_BY_VERDICT = { good_deal: "green", fair_price: "yellow", avoid: "red" };

  var KIND_LABEL = {
    listing: "Anuncio de Marketplace",
    messages: "Conversación de Messenger",
    unsupported: "Página no compatible",
  };

  function clearTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function setBadge(text, level) {
    ui.badge.textContent = text;
    ui.badge.className = "badge" + (level ? " " + level : "");
    ui.badge.hidden = !text;
  }

  function rowNode(field) {
    var li = document.createElement("li");
    li.className = "row " + (field.ok ? "ok" : "err");

    var dot = document.createElement("span");
    dot.className = "dot";

    var body = document.createElement("span");
    body.className = "body";

    var label = document.createElement("span");
    label.className = "label";
    label.textContent = field.label;
    body.appendChild(label);

    var value = document.createElement("span");
    value.className = "value";
    value.textContent = field.ok ? field.value : "error: " + (field.error || "sin dato");
    if (field.ok && field.value.length > 90) {
      value.title = field.value;
    }
    body.appendChild(value);

    li.appendChild(dot);
    li.appendChild(body);

    if (field.source) {
      var src = document.createElement("span");
      src.className = "src";
      src.textContent = field.source;
      li.appendChild(src);
    }
    return li;
  }

  function render(report) {
    state.report = report;
    var fields = (report && report.fields) || [];
    var okCount = fields.filter(function (f) {
      return f.ok;
    }).length;
    var errCount = fields.length - okCount;

    ui.ctx.textContent = "";
    var kind = document.createElement("span");
    kind.textContent = KIND_LABEL[report.kind] || "Página";
    ui.ctx.appendChild(kind);
    var id = report.listingId || report.sellerId;
    if (id) {
      var small = document.createElement("small");
      small.textContent = " · " + id;
      ui.ctx.appendChild(small);
    }

    var verdict = report.verdict;
    if (verdict && verdict.badge) {
      setBadge(verdict.badge, LEVEL_BY_VERDICT[verdict.verdict] || null);
    } else if (report.status === "loading") {
      setBadge("Leyendo anuncio…", null);
    } else if (report.status === "error") {
      setBadge("Lectura fallida", "red");
    } else {
      setBadge("", null);
    }
    ui.summary.textContent = (verdict && verdict.summary) || "";

    ui.stats.textContent = "";
    if (fields.length > 0) {
      var ok = document.createElement("span");
      var okB = document.createElement("b");
      okB.className = "ok";
      okB.textContent = String(okCount);
      ok.appendChild(okB);
      ok.appendChild(document.createTextNode(" datos leídos"));

      var err = document.createElement("span");
      var errB = document.createElement("b");
      errB.className = "err";
      errB.textContent = String(errCount);
      err.appendChild(errB);
      err.appendChild(document.createTextNode(" con error"));

      ui.stats.appendChild(ok);
      ui.stats.appendChild(err);

      if (report.status === "loading") {
        var pending = document.createElement("span");
        pending.textContent = "leyendo…";
        ui.stats.appendChild(pending);
      }
    }

    ui.rows.textContent = "";
    fields.forEach(function (field) {
      ui.rows.appendChild(rowNode(field));
    });

    if (fields.length === 0) {
      ui.empty.hidden = false;
      ui.empty.textContent =
        report.kind === "unsupported"
          ? "Abre un anuncio de Marketplace o un chat de Messenger (/messages/t/…) y vuelve a pulsar el icono."
          : "Sin datos todavía. Pulsa «Re-analizar».";
    } else {
      ui.empty.hidden = true;
    }

    ui.copy.disabled = !fields.length;
    ui.refresh.disabled = report.status === "loading";
  }

  function renderNoContent(reason) {
    render({
      kind: "unsupported",
      status: "error",
      ok: false,
      fields: [
        {
          label: "Content script",
          value: "",
          ok: false,
          source: "extensión",
          error: reason,
        },
      ],
      error: reason,
    });
  }

  function schedulePoll() {
    clearTimer();
    if (state.polls >= MAX_POLLS) return;
    state.polls += 1;
    state.timer = setTimeout(request, POLL_MS);
  }

  function request() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) {
        renderNoContent("No hay pestaña activa.");
        return;
      }
      state.tabId = tab.id;
      chrome.tabs.sendMessage(tab.id, { type: "MCRM_GET_REPORT" }, function (report) {
        if (chrome.runtime.lastError || !report) {
          // El content script puede no haber arrancado aún (document_idle):
          // reintenta un par de veces antes de dar la página por incompatible.
          if (state.retries < 3) {
            state.retries += 1;
            state.timer = setTimeout(request, 400);
            return;
          }
          renderNoContent(
            "La extensión no está activa en esta pestaña. Recárgala (F5) o abre una página de Facebook Marketplace / Messenger.",
          );
          return;
        }
        state.retries = 0;
        render(report);
        if (report.status === "loading") schedulePoll();
      });
    });
  }

  function refresh() {
    if (state.tabId == null) return;
    clearTimer();
    state.polls = 0;
    state.retries = 0;
    ui.refresh.disabled = true;
    chrome.tabs.sendMessage(state.tabId, { type: "MCRM_REFRESH" }, function (report) {
      if (chrome.runtime.lastError || !report) {
        renderNoContent("No se pudo contactar con la página. Recárgala (F5).");
        return;
      }
      render(report);
      if (report.status === "loading") schedulePoll();
    });
  }

  function copyJson() {
    if (!state.report) return;
    var text = JSON.stringify(state.report, null, 2);
    var done = function () {
      ui.copy.textContent = "Copiado ✓";
      setTimeout(function () {
        ui.copy.textContent = "Copiar JSON";
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      done();
    }
  }

  ui.refresh.addEventListener("click", refresh);
  ui.copy.addEventListener("click", copyJson);
  ui.copy.disabled = true;

  request();
})();
