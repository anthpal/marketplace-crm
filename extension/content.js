/* eslint-env browser, webextensions */

(function () {
  "use strict";

  // Se ejecuta en el contexto del content script; globalThis.FacebookData y
  // globalThis.SpottableLocal ya están definidos por los archivos cargados antes.
  //
  // Además de la barra en página, este script construye un INFORME por campos
  // (leído / error) que el popup de la extensión pinta en verde y rojo.

  var BAR_ID = "spottable-crm-bar";
  var HINT_ID = "spottable-crm-hint";

  var CRM_STATE = {
    mode: "idle", // idle | listing | messages | unsupported
    listingId: null,
    sellerId: null,
    sellerName: null,
    status: "idle", // idle | loading | done | error
    data: null,
    analysis: null,
    error: null,
  };

  // =========================================================================
  // Localizadores de la página
  // =========================================================================

  function listingIdFromPage() {
    // 1) La URL manda: /marketplace/item/<id>/
    var fromUrl = FacebookData.listingIdFromHref(location.pathname + location.search);
    if (fromUrl) return fromUrl;
    // En un chat hay enlaces a anuncios, pero NO estamos en la página del anuncio:
    // usarlos como respaldo convertiría la conversación en un análisis suelto.
    if (/^\/messages\//.test(location.pathname)) return null;
    // 2) Respaldo: primera tarjeta/enlace visible.
    var a = document.querySelector("a[href*='/marketplace/item/']");
    return a ? FacebookData.listingIdFromHref(a.getAttribute("href")) : null;
  }

  function listingLinkFromElement(a) {
    var href = a.getAttribute("href") || "";
    return FacebookData.listingIdFromHref(href);
  }

  /** URL de chat: https://www.facebook.com/messages/t/{sellerId}/ -> sellerId. */
  function sellerIdFromPage() {
    var m = location.pathname.match(/\/messages\/t\/([0-9]+)/);
    if (m) return m[1];
    var a = document.querySelector("a[href*='/messages/t/']");
    if (a) {
      var m2 = (a.getAttribute("href") || "").match(/\/messages\/t\/([0-9]+)/);
      if (m2) return m2[1];
    }
    return null;
  }

  function sharedListingIds() {
    var anchors = document.querySelectorAll("a[href*='/marketplace/item/']");
    var seen = {};
    var ids = [];
    for (var i = 0; i < anchors.length; i += 1) {
      var id = listingLinkFromElement(anchors[i]);
      if (!id || seen[id]) continue;
      seen[id] = true;
      ids.push(id);
    }
    return ids;
  }

  /** Nombre visible de la conversación, sacado del título de la pestaña. */
  function domSellerName() {
    var t = String(document.title || "")
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*[|·-]\s*(Facebook|Messenger).*$/i, "")
      .trim();
    if (!t || t.length > 80) return "";
    if (/^(facebook|messenger|marketplace)$/i.test(t)) return "";
    return t;
  }

  /** Lecturas de respaldo del DOM, sólo para no dejar la fila vacía si
   * GraphQL falla (doc_id caducado). Se marcan con origen "DOM". */
  function domHints() {
    var hints = { title: "", price: "" };
    try {
      var h1 = document.querySelector("h1");
      if (h1) {
        var title = (h1.textContent || "").trim();
        if (title) hints.title = title.slice(0, 120);
        var box = h1.parentElement;
        if (box) {
          var m = (box.innerText || "").match(/(?:MX\$|US\$|CA\$|A\$|\$|€|£)\s?\d[\d.,]*/);
          if (m) hints.price = m[0].trim();
        }
      }
    } catch (error) {
      /* DOM raro: se ignora */
    }
    return hints;
  }

  // =========================================================================
  // Informe por campos (verde = leído, rojo = error)
  // =========================================================================

  function rowText(label, value, source, errorText) {
    var has = value !== null && value !== undefined && String(value).trim() !== "";
    return {
      label: label,
      value: has ? String(value) : "",
      ok: has,
      source: source || "",
      error: has ? null : errorText || "sin dato",
    };
  }

  function rowBool(label, value, source) {
    var known = typeof value === "boolean";
    return {
      label: label,
      value: known ? (value ? "sí" : "no") : "",
      ok: known,
      source: source || "",
      error: known ? null : "sin dato",
    };
  }

  function countOf(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return 0;
  }

  function rowCount(label, value, source, singular, errorText) {
    var n = countOf(value);
    return {
      label: label,
      value: n === 1 ? "1 " + singular : n + " " + singular + "s",
      ok: n > 0,
      source: source || "",
      error: n > 0 ? null : errorText || "vacío",
    };
  }

  function truncate(text, max) {
    var s = String(text || "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function classificationFields() {
    var a = CRM_STATE.analysis && CRM_STATE.analysis.analysis;
    if (!a) return [];
    var notes = (a.itemDetails && a.itemDetails.conditionNotes) || [];
    return [
      rowText("Semáforo", a.shortVerdict, "local"),
      rowText("Resumen", a.summary, "local"),
      rowText("Señales de riesgo", String((a.redFlags || []).length), "local"),
      rowText("Señales leídas", notes.join(" · "), "local"),
    ];
  }

  function listingFields() {
    var data = CRM_STATE.data;
    var hints = domHints();
    var why = CRM_STATE.error || "sin dato";
    var rows = [];

    rows.push(rowText("ID del anuncio", CRM_STATE.listingId, "URL"));
    if (CRM_STATE.sellerId) {
      rows.push(rowText("Compartido en el chat de", CRM_STATE.sellerId, "URL"));
    }
    rows.push(
      rowText("Título", (data && data.title) || hints.title, data && data.title ? "GraphQL" : "DOM", why),
    );

    var price = "";
    if (data && data.price !== null && data.price !== undefined) {
      price = String(data.price) + (data.currency ? " " + data.currency : "");
    } else if (hints.price) {
      price = hints.price;
    }
    rows.push(rowText("Precio", price, data && data.price != null ? "GraphQL" : "DOM", why));

    rows.push(
      rowText("Descripción", data && data.description ? truncate(data.description, 90) : "", "GraphQL", why),
    );
    rows.push(rowText("Condición", data && data.condition, "GraphQL", why));
    rows.push(rowText("Ubicación", data && data.location, "GraphQL", why));
    rows.push(
      rowText(
        "Coordenadas",
        data && data.latitude != null && data.longitude != null
          ? data.latitude + ", " + data.longitude
          : "",
        "GraphQL",
        why,
      ),
    );
    rows.push(rowCount("Fotos", data && data.imageUrls, "GraphQL", "foto", why));
    rows.push(rowCount("Detalles de producto", data && data.productDetails, "GraphQL", "dato", why));
    rows.push(rowCount("Metadatos extra", data && data.extraMetadata, "GraphQL", "dato", why));
    rows.push(rowText("Vendedor", data && data.sellerName, "GraphQL", why));
    rows.push(rowText("ID del vendedor", data && data.sellerId, "GraphQL", why));
    rows.push(rowText("Alta de la cuenta", data && data.sellerAccountCreatedDate, "GraphQL/DOM", why));
    rows.push(
      rowText(
        "Publicado",
        data && data.createdTime ? new Date(data.createdTime).toLocaleString("es-ES") : "",
        "GraphQL",
        why,
      ),
    );
    rows.push(rowBool("Activo", data ? data.isLive : undefined, "GraphQL"));
    rows.push(rowBool("Vendido", data ? data.isSold : undefined, "GraphQL"));

    return rows.concat(classificationFields());
  }

  function messageFields() {
    var ids = sharedListingIds();
    var rows = [];
    rows.push(rowText("ID del vendedor", CRM_STATE.sellerId, "URL"));
    rows.push(rowText("Nombre en la conversación", domSellerName(), "DOM", "no visible en esta vista"));
    rows.push({
      label: "Anuncios de Marketplace en el chat",
      value: ids.length === 1 ? "1 anuncio" : ids.length + " anuncios",
      ok: ids.length > 0,
      source: "DOM",
      error: "no se encontraron enlaces /marketplace/item/",
    });
    ids.slice(0, 15).forEach(function (id, index) {
      rows.push(rowText("Anuncio compartido " + (index + 1), id, "DOM"));
    });
    if (ids.length > 15) {
      rows.push(rowText("… y más", "+" + (ids.length - 15) + " anuncios", "DOM"));
    }
    return rows.concat(classificationFields());
  }

  function unsupportedFields() {
    return [
      {
        label: "Página actual",
        value: location.pathname,
        ok: false,
        source: "URL",
        error: "no es un anuncio de Marketplace ni un chat /messages/t/",
      },
    ];
  }

  function buildReport() {
    var kind = CRM_STATE.listingId
      ? "listing"
      : CRM_STATE.sellerId
        ? "messages"
        : "unsupported";
    var fields =
      kind === "listing" ? listingFields() : kind === "messages" ? messageFields() : unsupportedFields();

    var verdict = null;
    var a = CRM_STATE.analysis && CRM_STATE.analysis.analysis;
    if (a) {
      verdict = {
        badge: a.shortVerdict,
        verdict: a.verdict,
        summary: a.summary,
        flags: (a.redFlags || []).map(function (flag) {
          return flag.description;
        }),
      };
    }

    return {
      kind: kind,
      status: CRM_STATE.status,
      ok: CRM_STATE.status === "done",
      error: CRM_STATE.error,
      url: location.href,
      listingId: CRM_STATE.listingId,
      sellerId: CRM_STATE.sellerId,
      verdict: verdict,
      fields: fields,
      updatedAt: Date.now(),
    };
  }

  // =========================================================================
  // Panel en página (barra superior)
  // =========================================================================

  function removeBar() {
    var bar = document.getElementById(BAR_ID);
    if (bar) bar.remove();
  }

  function showBar(borderColor, html) {
    removeBar();
    var el = document.createElement("div");
    el.id = BAR_ID;
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#1b1b1b;color:#fff;font-family:sans-serif;font-size:14px;" +
      "padding:8px 16px;z-index:2147483647;border-bottom:3px solid " + borderColor;

    var content = document.createElement("div");
    content.innerHTML = html;
    el.appendChild(content);

    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Cerrar";
    close.style.cssText =
      "position:absolute;top:4px;right:8px;background:transparent;border:0;color:#bbb;" +
      "font-size:18px;cursor:pointer;line-height:1;";
    close.addEventListener("click", removeBar);
    el.appendChild(close);

    document.body.appendChild(el);
    return el;
  }

  function ensureHint() {
    if (document.getElementById(HINT_ID)) return;
    var hint = document.createElement("div");
    hint.id = HINT_ID;
    hint.style.cssText =
      "position:fixed;bottom:20px;left:20px;z-index:2147483647;" +
      "background:#222;color:#ddd;font-family:sans-serif;font-size:12px;padding:6px 10px;border-radius:6px;";
    hint.textContent = "Marketplace CRM (local) · pulsa el icono para ver el detalle";
    document.body.appendChild(hint);
  }

  /** Panel: barra superior con el semáforo y la lista de banderas/notas. */
  function showResult(analysis) {
    if (!analysis) {
      showBar(
        "#b3261e",
        "<b>Marketplace CRM — lectura fallida</b>" +
          (CRM_STATE.listingId ? " | anuncio " + CRM_STATE.listingId : "") +
          " — " +
          (CRM_STATE.error || "sin datos"),
      );
      ensureHint();
      return;
    }

    var a = analysis.analysis;
    var color = { good_deal: "#2f7d32", fair_price: "#b7791f", avoid: "#b3261e" }[a.verdict] || "#555";

    var el = showBar(
      color,
      "<b>Marketplace CRM — " + a.shortVerdict + "</b>" +
        (CRM_STATE.listingId ? " | anuncio " + CRM_STATE.listingId : "") +
        (a.summary ? " — " + a.summary : ""),
    );

    var list = document.createElement("ul");
    list.style.cssText = "margin:8px 0 0;padding-left:20px;max-height:300px;overflow:auto;";

    var flags = a.redFlags || [];
    if (flags.length === 0) {
      var empty = document.createElement("li");
      empty.textContent = "Análisis local completo: no se detectaron señales de riesgo.";
      list.appendChild(empty);
    } else {
      flags.forEach(function (flag) {
        var li = document.createElement("li");
        li.textContent = flag.description;
        li.style.color = { high: "#ff6b6b", medium: "#f5c062", low: "#85e3bd" }[flag.severity] || "#fff";
        list.appendChild(li);
      });
    }

    var notes = (a.itemDetails && a.itemDetails.conditionNotes) || [];
    if (notes.length > 0) {
      var note = document.createElement("li");
      note.textContent = "Se leyó: " + notes.slice(0, 5).join(", ");
      list.appendChild(note);
    }
    el.appendChild(list);
    ensureHint();
  }

  /** Fase CRM — vendedor: panel informativo con acciones (perfil + anuncios compartidos). */
  function showSellerPanel(sellerId) {
    var el = showBar(
      "#555",
      "<b>Marketplace CRM — vendedor</b> | " + sellerId +
        "<div style='margin-top:6px;font-size:12px'>" +
        "<a href='https://www.facebook.com/marketplace/profile/" + sellerId +
        "' target='_blank' style='color:#9dcfff;margin-right:12px'>Ver publicaciones del vendedor</a>" +
        "<a href='#' id='spottable-scan-shared' style='color:#9dcfff;text-decoration:none'>" +
        "🔍 Analizar anuncios compartidos en este chat</a>" +
        "</div>",
    );

    var scan = el.querySelector("#spottable-scan-shared");
    if (scan) {
      scan.addEventListener("click", function (event) {
        event.preventDefault();
        scan.textContent = "Escaneando anuncios compartidos en el chat…";
        setTimeout(scanSharedListings, 300);
      });
    }
    console.log(
      "[spottable] vista de vendedor:",
      sellerId,
      "→ perfil: https://www.facebook.com/marketplace/profile/" + sellerId,
    );
  }

  /** Escanea el DOM del chat buscando enlaces de Marketplace compartidos y
   * pinta un botón por cada anuncio no analizado aún. */
  function scanSharedListings() {
    if (!CRM_STATE.sellerId) return;
    var seen = {};
    var anchors = document.querySelectorAll("a[href*='/marketplace/item/']");
    var n = 0;

    for (var i = 0; i < anchors.length; i += 1) {
      var id = listingLinkFromElement(anchors[i]);
      if (!id || seen[id]) continue;
      seen[id] = true;

      var btn = document.createElement("a");
      btn.href = "#";
      btn.textContent = "🛡️ Analizar anuncio";
      btn.style.cssText =
        "display:inline-block;background:#333;color:#fff;font-size:11px;padding:3px 6px;" +
        "border-radius:3px;margin-left:6px;text-decoration:none;cursor:pointer;";
      btn.title = "Clasificación local: fiabilidad de esta publicación (" + id + ")";

      (function (listingId, button) {
        button.addEventListener("click", function (event) {
          event.preventDefault();
          button.textContent = "Analizando…";
          analyzeListing(listingId, "compartido en el chat");
        });
      })(id, btn);

      var anchor = anchors[i];
      if (anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      n += 1;
    }

    if (n > 0) {
      console.log("[spottable] pintó " + n + " botón(es) de análisis para anuncios compartidos");
    }
  }

  // =========================================================================
  // Análisis
  // =========================================================================

  function analyzeListing(listingId, triggerLabel) {
    CRM_STATE.mode = "listing";
    CRM_STATE.listingId = listingId;
    CRM_STATE.sellerId = sellerIdFromPage();
    CRM_STATE.sellerName = null;
    CRM_STATE.status = "loading";
    CRM_STATE.data = null;
    CRM_STATE.analysis = null;
    CRM_STATE.error = null;

    console.log(
      "[spottable] analizando anuncio: " + listingId + (triggerLabel ? " (" + triggerLabel + ")" : ""),
    );

    FacebookData.fetchListingData(listingId, {
      onPdpResolved: function (pdp) {
        console.log("[spottable] anuncio:", pdp.id, pdp.title, "en", pdp.latitude, pdp.longitude);
        if (pdp.sellerName) CRM_STATE.sellerName = pdp.sellerName;
      },
    })
      .then(function (data) {
        if (!data) {
          CRM_STATE.status = "error";
          CRM_STATE.error =
            "GraphQL no devolvió el anuncio: los doc_id probablemente caducaron (ver README.md).";
          console.warn("[spottable] " + CRM_STATE.error);
          showResult(null);
          return;
        }
        console.log("[spottable]", data.title, data.price, data.currency);
        CRM_STATE.data = data;
        CRM_STATE.sellerName = data.sellerName || CRM_STATE.sellerName;
        CRM_STATE.analysis = SpottableLocal.classify(data);
        CRM_STATE.status = "done";
        showResult(CRM_STATE.analysis);
      })
      .catch(function (error) {
        CRM_STATE.status = "error";
        CRM_STATE.error = (error && error.message) || String(error);
        console.error("[spottable]", error);
        showResult(null);
      });
  }

  function route(force) {
    var listingId = listingIdFromPage();
    if (listingId) {
      if (force || CRM_STATE.listingId !== listingId || CRM_STATE.status === "error") {
        analyzeListing(listingId);
      }
      return;
    }

    var sellerId = sellerIdFromPage();
    if (sellerId) {
      if (CRM_STATE.mode !== "messages" || CRM_STATE.sellerId !== sellerId) {
        CRM_STATE.mode = "messages";
        CRM_STATE.listingId = null;
        CRM_STATE.sellerId = sellerId;
        CRM_STATE.status = "done";
        CRM_STATE.data = null;
        CRM_STATE.analysis = null;
        CRM_STATE.error = null;
        showSellerPanel(sellerId);
      }
      return;
    }

    CRM_STATE.mode = "unsupported";
    CRM_STATE.status = "error";
    CRM_STATE.error = "Esta página no es un anuncio de Marketplace ni un chat de Messenger.";
  }

  // =========================================================================
  // Puente con el popup
  // =========================================================================

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || !message.type) return undefined;
      if (message.type === "MCRM_GET_REPORT") {
        sendResponse(buildReport());
        return undefined;
      }
      if (message.type === "MCRM_REFRESH") {
        if (listingIdFromPage()) {
          analyzeListing(listingIdFromPage());
        } else {
          route(true);
        }
        sendResponse(buildReport());
        return undefined;
      }
      return undefined;
    });
  }

  // =========================================================================
  // Arranque (y navegación SPA de Facebook)
  // =========================================================================

  route(false);

  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    route(false);
  }, 1200);
})();
