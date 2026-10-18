/* eslint-env browser */

(function () {
  "use strict";

  // Se ejecuta en el contexto del content script; globalThis.FacebookData y
  // globalThis.SpottableLocal ya están definidos por los archivos cargados antes.

  function listingIdFromPage() {
    var href = "";
    var a = document.querySelector("a[href*='/marketplace/item/']");
    if (a) href = a.getAttribute("href");
    return FacebookData.listingIdFromHref(href);
  }

  /** Pinta un panel simple en la página con el resultado del análisis local. */
  function showResult(analysis) {
    var bar = document.getElementById("spottable-crm-bar");
    if (bar) bar.remove();

    var badge = {
      green: "Sin señales de riesgo",
      yellow: "Precaución",
      red: "Posible riesgo",
    }[analysis.analysis.shortVerdict] || analysis.analysis.shortVerdict;

    var color = { green: "#2f7d32", yellow: "#b7791f", red: "#b3261e" }[analysis.analysis.verdict] || "#555";

    var el = document.createElement("div");
    el.id = "spottable-crm-bar";
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#1b1b1b;color:#fff;font-family:sans-serif;font-size:14px;" +
      "padding:8px 16px;z-index:2147483647;border-bottom:3px solid " + color;
    el.innerHTML =
      "<b>Marketplace CRM — " + badge + "</b>" +
      (analysis.analysis.summary ? (" — " + analysis.analysis.summary) : "");

    var list = document.createElement("ul");
    list.style.cssText = "margin:8px 0 0;padding-left:20px;max-height:300px;overflow:auto;";
    var flags = analysis.analysis.redFlags || [];
    if (flags.length === 0) {
      var li = document.createElement("li");
      li.textContent = "Análisis local completo: no se detectaron señales de riesgo.";
      list.appendChild(li);
    } else {
      flags.forEach(function (f) {
        var li = document.createElement("li");
        li.textContent = f.description;
        li.style.color =
          { high: "#ff6b6b", medium: "#f5c062", low: "#85e3bd" }[f.severity] || "#fff";
        list.appendChild(li);
      });
    }
    var notes = (analysis.analysis.itemDetails && analysis.analysis.itemDetails.conditionNotes) || [];
    if (notes.length > 0) {
      var li = document.createElement("li");
      li.textContent = "Se leyó: " + notes.slice(0, 5).join(", ");
      list.appendChild(li);
    }
    el.appendChild(list);

    var hint = document.createElement("div");
    hint.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:2147483647;" +
      "background:#222;color:#ddd;font-family:sans-serif;font-size:12px;padding:6px 10px;border-radius:6px;";
    hint.textContent = "Marketplace CRM (local)";
    document.body.appendChild(hint);

    document.body.appendChild(el);
  }

  var listingId = listingIdFromPage();
  if (!listingId) return;

  FacebookData.fetchListingData(listingId, {
    onPdpResolved: function (pdp) {
      console.log("[spottable] anuncio:", pdp.id, pdp.title, "en", pdp.latitude, pdp.longitude);
    },
  })
    .then(function (data) {
      if (!data) {
        console.warn(
          "[spottable] fetchListingData === null: los doc_id probablemente caducaron (lee README.md); prueba copiar los nuevos de DevTools.",
        );
        return;
      }
      console.log("[spottable]", data.title, data.price, data.currency);
      showResult(SpottableLocal.classify(data));
    })
    .catch(function (error) {
      console.error("[spottable]", error);
    });
})();
