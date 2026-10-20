/* eslint-env browser */

(function () {
  "use strict";

  // Se ejecuta en el contexto del content script; globalThis.FacebookData y
  // globalThis.SpottableLocal ya están definidos por los archivos cargados antes.

  var CRM_STATE = {
    mode: "idle", // idle | listing | seller
    listingId: null,
    sellerId: null,
    sellerName: null,
    analysis: null,
  };

  function listingIdFromPage() {
    var href = "";
    var a = document.querySelector("a[href*='/marketplace/item/']");
    if (a) href = a.getAttribute("href");
    return FacebookData.listingIdFromHref(href);
  }

  function listingLinkFromElement(a) {
    var href = a.getAttribute("href") || "";
    return FacebookData.listingIdFromHref(href);
  }

  /** URL de chat: https://www.facebook.com/messages/t/{sellerId}/ -> sellerId. */
  function sellerIdFromPage() {
    var href = "";
    var a = document.querySelector("a[href*='/messages/t/']");
    if (a) href = a.getAttribute("href");
    var m = href.match(/\/messages\/t\/([0-9]+)/);
    return m ? m[1] : null;
  }

  /** Contexto que se muestra en el panel: anuncio vs. vendedor. */
  function contextLabel() {
    if (CRM_STATE.listingId) return "anuncio " + CRM_STATE.listingId;
    if (CRM_STATE.sellerId) return "vendedor " + CRM_STATE.sellerId;
    return "";
  }

  /** Panel: barra superior con el semáforo y la lista de banderas/notas. */
  function showResult(analysis) {
    CRM_STATE.analysis = analysis;
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
      (contextLabel() ? " | " + contextLabel() : "") +
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

  /** Análisis de un anuncio concreto (se invoca desde botones del DOM). */
  function analyzeListing(listingId, triggerLabel) {
    CRM_STATE.mode = "listing";
    CRM_STATE.listingId = listingId;
    CRM_STATE.sellerName = null;
    if (triggerLabel) console.log("[spottable] analizando anuncio compartido: " + listingId + " (" + triggerLabel + ")");
    else console.log("[spottable] analizando anuncio: " + listingId);

    FacebookData.fetchListingData(listingId, {
      onPdpResolved: function (pdp) {
        console.log("[spottable] anuncio:", pdp.id, pdp.title, "en", pdp.latitude, pdp.longitude);
        if (pdp.sellerName) CRM_STATE.sellerName = pdp.sellerName;
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
        CRM_STATE.sellerName = data.sellerName;
        showResult(SpottableLocal.classify(data));
      })
      .catch(function (error) {
        console.error("[spottable]", error);
      });
  }

  /** Fase CRM — vendedor: panel informativo con acciones (perfil + anuncios compartidos). */
  function showSellerPanel(sellerId) {
    CRM_STATE.mode = "seller";
    CRM_STATE.sellerId = sellerId;

    var bar = document.getElementById("spottable-crm-bar");
    if (bar) bar.remove();

    var el = document.createElement("div");
    el.id = "spottable-crm-bar";
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#1b1b1b;color:#fff;font-family:sans-serif;font-size:14px;" +
      "padding:8px 16px;z-index:2147483647;border-bottom:3px solid #555";
    el.innerHTML =
      "<b>Marketplace CRM — vendedor</b> | " + sellerId +
      "<div style='margin-top:6px;font-size:12px'>" +
      "<a href='https://www.facebook.com/marketplace/profile/" + sellerId + "' target='_blank' style='color:#9dcfff;margin-right:12px'>" +
      "Ver publicaciones del vendedor</a>" +
      "<a href='javascript:(function(){window.spottableScanShared=true;})()' " +
      "onclick=\"window.spottableScanShared=true; this.textContent='Escaneando anuncios compartidos en el chat...'\"" +
      "style='color:#9dcfff;text-decoration:none'>" + "🔍 Analizar anuncios compartidos en este chat</a>" +
      "</div>";
    document.body.appendChild(el);
    console.log("[spottable] vista de vendedor:", sellerId, "→ perfil:", "https://www.facebook.com/marketplace/profile/" + sellerId);
  }

  /** Escanea el DOM del chat buscando enlaces de Marketplace compartidos y
   * pinta un botón por cada anuncio no analizado aún. */
  function scanSharedListings() {
    if (!CRM_STATE.sellerId) return;
    var seen = new Set();
    if (CRM_STATE.listingId) seen.add(CRM_STATE.listingId);

    var anchors = document.querySelectorAll("a[href*='/marketplace/item/']");
    var n = 0;
    for (var i = 0; i < anchors.length; i += 1) {
      var id = listingLinkFromElement(anchors[i]);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      var btn = document.createElement("a");
      btn.href = "#";
      btn.textContent = "🛡️ Analizar anuncio";
      btn.style.cssText =
        "display:inline-block;background:#333;color:#fff;font-size:11px;padding:3px 6px;" +
        "border-radius:3px;margin-left:6px;text-decoration:none;cursor:pointer;";
      btn.title = "Clasificación local: fiabilidad de esta publicación";

      var img = anchors[i].querySelector("img");
      var imgSrc = img ? img.getAttribute("src") : "";
      if (imgSrc) btn.title += " | " + imgSrc.split("/").pop();

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        this.textContent = "Analizando...";
        this.disabled = true;
        var anchor = e.currentTarget;
        var a = anchor;
        while (a && a !== anchors[i] && a.parentElement) {
          var id = listingLinkFromElement(a);
          if (id) break;
          a = a.parentElement;
        }
        var link = listingLinkFromElement(anchor);
        if (!link) link = listingLinkFromElement(e.currentTarget);
        analyzeListing(link || id, "compartido en el chat");
      });

      // Insertar a la derecha del ancla / previsualización
      var a = anchors[i];
      var wrap = a.parentElement;
      var prev = a.previousElementSibling;
      if (a instanceof HTMLAnchorElement && wrap) {
        wrap.appendChild(btn);
      } else {
        a.parentNode.insertBefore(btn, a.nextSibling);
      }
      n += 1;
    }
    if (n > 0) {
      console.log("[spottable] pintó " + n + " botón(es) de análisis para anuncios compartidos");
    }
  }

  // --- Inicialización ---

  var listingId = listingIdFromPage();
  var sellerId = sellerIdFromPage();

  if (listingId) {
    // Página de anuncio de Marketplace: análisis directo.
    analyzeListing(listingId);
  } else if (sellerId) {
    // Fase CRM: chat de Marketplace. Panel de vendedor + botón para escanear
    // los links de Marketplace que hayas compartido en la conversación.
    showSellerPanel(sellerId);

    // Si la extensión se recarga y el usuario pidió escanear el chat, lo hacemos.
    if (window.spottableScanShared) {
      delete window.spottableScanShared;
      setTimeout(scanSharedListings, 3000); // esperar a que carguen los mensajes
    }

    // Escaneo automático también: útil cuando se comparten links sin hacer clic.
    // (Opcional: desactivar si molesta en chats muy largos.)
    // setTimeout(scanSharedListings, 2000);
  }
})();
