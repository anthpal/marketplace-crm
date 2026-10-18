/**
 * local-scoring.js — clasificación LOCAL de fiabilidad de vendedor.
 *
 * Sin dependencias ni red. El service worker lo carga con importScripts().
 * Expone: globalThis.SpottableLocal = { evaluateSeller, classify, toWire }
 *
 * Factores y pesos: ver README.md ("Factores y pesos"). Toda la afinación vive
 * en THRESHOLDS, PATTERNS y WIRE — no toques el resto para ajustar la heurística.
 *
 * Cada factor devuelve además su etiqueta. Los que llevan `severity` son señales
 * de riesgo; los que no, son datos leídos sin riesgo y se publican en
 * `itemDetails.conditionNotes` para que el usuario pueda validar qué se ha leído.
 *
 * AVISO: es una heurística, no un predictor. Da falsos positivos con vendedores
 * nuevos legítimos. La UI debe decir "posible riesgo", nunca "no fiable".
 */
(function (root) {
  "use strict";

  var DAY = 86400000;

  // Umbrales del semáforo (README).
  var THRESHOLDS = { green: 20, yellow: 50 };

  // Puntos de riesgo por antigüedad de cuenta, de más nueva a más vieja.
  var ACCOUNT_AGE = [
    { maxDays: 30, points: 35, severity: "high", label: "Cuenta creada hace menos de 1 mes" },
    { maxDays: 182, points: 22, severity: "high", label: "Cuenta de menos de 6 meses" },
    { maxDays: 365, points: 12, severity: "medium", label: "Cuenta de menos de 1 año" },
    { maxDays: 1095, points: 5, severity: "low", label: "Cuenta de menos de 3 años" },
  ];
  // Penalización leve por no poder verificar la cuenta. NO es un suelo: Facebook
  // no expone la fecha en el listing, así que forzar amarillo teñía todo de 5/10.
  var ACCOUNT_UNKNOWN = { points: 10, severity: "medium", label: "Sin fecha de alta de la cuenta" };

  // Banderas rojas en la descripción. Aditivas.
  var PATTERNS = [
    { re: /(transferenc|zelle|crypto|bitcoin|gift ?card|tarjeta regalo|western union|wire transfer|paypal friends|adelanto|dep[óo]sito por adelantado)/i,
      points: 12, severity: "high", label: "Método de pago dudoso" },
    { re: /(no (puedo|se puede) (mostrar|probar)|sin (mostrar|probar)|no test|as ?is|no returns?|no devoluciones?|sin garant[íi]a|no warranty)/i,
      points: 6, severity: "medium", label: "Sin posibilidad de probar ni devolución" },
    { re: /(urgent[ei]?|hoy mismo|se va hoy|today only|must go|quick sale|vendo ya|cuanto antes|asap)/i,
      points: 8, severity: "medium", label: "Lenguaje de urgencia" },
  ];
  var EMPTY_DESC = { points: 8, severity: "low", label: "Descripción vacía o muy corta" };
  var MIN_DESC = 20;

  // Mapeo semáforo -> wire-shape que el renderer ya consume (ver AGENTS.md).
  var WIRE = {
    green: { verdict: "good_deal", dealScore: 8, badge: "Sin señales de riesgo" },
    yellow: { verdict: "fair_price", dealScore: 5, badge: "Precaución" },
    red: { verdict: "avoid", dealScore: 2, badge: "Posible riesgo" },
  };

  function toMs(value) {
    if (value == null) return null;
    if (typeof value === "number" && isFinite(value)) {
      return value < 1e12 ? value * 1000 : value; // segundos vs milisegundos
    }
    if (typeof value === "string" && value.trim()) {
      var t = Date.parse(value.trim());
      return isNaN(t) ? null : t;
    }
    return null;
  }

  function factor(points, severity, label) {
    return { points: points, severity: severity, label: label };
  }

  function accountFactor(joinedMs, nowMs, raw) {
    if (joinedMs == null) return ACCOUNT_UNKNOWN;
    var days = (nowMs - joinedMs) / DAY;
    for (var i = 0; i < ACCOUNT_AGE.length; i++) {
      if (days < ACCOUNT_AGE[i].maxDays) return ACCOUNT_AGE[i];
    }
    // Se repite el valor original para poder comprobar de dónde sale la antigüedad.
    return factor(0, null, "Cuenta con " + Math.round(days / 365) + " años (alta " + raw + ")");
  }

  function photoFactor(imageUrls) {
    var n = Array.isArray(imageUrls) ? imageUrls.length : 0;
    if (n === 0) return factor(15, "medium", "Sin fotos");
    if (n === 1) return factor(10, "low", "Solo 1 foto");
    if (n <= 3) return factor(5, "low", "Pocas fotos (" + n + ")");
    return factor(0, null, "Fotos: " + n);
  }

  function nameFactor(sellerName) {
    var n = String(sellerName == null ? "" : sellerName).trim();
    // Ausente = dato que no se pudo leer, no un vendedor sospechoso.
    if (!n) return factor(0, null, null);
    if (n.length < 3 || /^\d+$/.test(n) || /^(marketplace|facebook|fb)\b/i.test(n) || /^user\s*\d*$/i.test(n)) {
      return factor(8, "low", "Nombre de vendedor genérico");
    }
    return factor(0, null, "Vendedor: " + n.slice(0, 40));
  }

  function descriptionFactor(description) {
    var text = String(description == null ? "" : description).trim();
    var out = [];
    if (text.length < MIN_DESC) out.push(EMPTY_DESC);
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i].re.test(text)) {
        out.push(factor(PATTERNS[i].points, PATTERNS[i].severity, PATTERNS[i].label));
      }
    }
    // Larga y sin banderas: se muestra el texto leído para poder validar la lectura.
    if (out.length === 0) {
      out.push(factor(0, null, "Descripción: " + (text.length > 80 ? text.slice(0, 80) + "…" : text)));
    }
    return out;
  }

  function priceFactor(price) {
    var value = typeof price === "string" ? Number(price) : price;
    if (typeof value !== "number" || !isFinite(value) || value <= 0) {
      return factor(10, "high", "Precio ausente o inválido");
    }
    // shortcut: sin baseline de mercado no se puede juzgar "demasiado barato".
    // Añadir catálogo de precios por categoría cuando exista (README, opción B/C).
    return factor(0, null, "Precio: " + value);
  }

  function comboFactor(accountDays, listingDays) {
    if (accountDays != null && listingDays != null && accountDays < 30 && listingDays < 7) {
      return factor(10, "medium", "Cuenta nueva con publicación reciente");
    }
    return factor(0, null, null);
  }

  function levelFor(risk) {
    if (risk < THRESHOLDS.green) return "green";
    if (risk < THRESHOLDS.yellow) return "yellow";
    return "red";
  }

  /**
   * Evalúa el perfil del vendedor a partir de los datos del listing.
   * @returns {{riskScore:number, level:string, summary:string, redFlags:Array, notes:Array}}
   */
  function evaluateSeller(listing, nowMs) {
    listing = listing || {};
    var now = typeof nowMs === "number" ? nowMs : Date.now();

    var joinedMs = toMs(listing.sellerAccountCreatedDate);
    var listingMs = toMs(listing.createdTime);
    var accountDays = joinedMs == null ? null : (now - joinedMs) / DAY;
    var listingDays = listingMs == null ? null : (now - listingMs) / DAY;

    var factors = [
      accountFactor(joinedMs, now, listing.sellerAccountCreatedDate),
      priceFactor(listing.price),
      comboFactor(accountDays, listingDays),
      photoFactor(listing.imageUrls),
      nameFactor(listing.sellerName),
    ].concat(descriptionFactor(listing.description));

    var risk = 0;
    var redFlags = [];
    var reasons = [];
    var notes = [];
    for (var i = 0; i < factors.length; i++) {
      var f = factors[i];
      risk += f.points;
      if (f.severity) {
        redFlags.push({ severity: f.severity, description: f.label });
        reasons.push(f.label);
      } else if (f.label) {
        notes.push(f.label);
      }
    }

    // Los datos ausentes se puntúan en su propio factor (p. ej. ACCOUNT_UNKNOWN),
    // nunca como suelo: no se puede castigar lo que no se ha podido observar.
    var level = levelFor(risk);
    var summary = reasons.length
      ? "Señales detectadas: " + reasons.join("; ") + "."
      : "Sin señales de riesgo detectadas. Evaluación local.";

    return { riskScore: risk, level: level, summary: summary, redFlags: redFlags, notes: notes };
  }

  /** Traduce el resultado interno al wire-shape que espera el renderer. */
  function toWire(result) {
    var w = WIRE[result.level] || WIRE.yellow;
    return {
      analysis: {
        dealScore: w.dealScore,
        verdict: w.verdict,
        shortVerdict: w.badge,
        summary: result.summary,
        redFlags: result.redFlags,
        // El renderer ya pinta esta lista con check verde / aviso ámbar (l0 + n0).
        itemDetails: { condition: "", conditionNotes: result.notes || [] },
      },
    };
  }

  /** Conveniencia: listing -> análisis listo para entregar al renderer. */
  function classify(listing) {
    return toWire(evaluateSeller(listing));
  }

  root.SpottableLocal = {
    evaluateSeller: evaluateSeller,
    toWire: toWire,
    classify: classify,
    THRESHOLDS: THRESHOLDS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

// Autochequeo: `node local-scoring.js`. Solo corre fuera del navegador.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  var assert = require("assert");
  var S = globalThis.SpottableLocal;
  var NOW = Date.UTC(2026, 9, 17);

  // Cuenta de 6 años, 4 fotos, descripción limpia -> verde
  var green = S.evaluateSeller({
    sellerName: "Jane Doe",
    sellerAccountCreatedDate: "2020-05-01",
    imageUrls: [1, 2, 3, 4],
    price: 300,
    description: "iPhone 13 en buen estado, entrego en persona, se puede probar.",
  }, NOW);
  assert.strictEqual(green.level, "green", "esperado green, fue " + green.level);

  // Cuenta de 10 días, 1 foto, urgencia + transferencia -> rojo
  var red = S.evaluateSeller({
    sellerName: "Vendedor",
    sellerAccountCreatedDate: new Date(NOW - 10 * 86400000).toISOString().slice(0, 10),
    createdTime: NOW / 1000,
    imageUrls: ["a"],
    price: 50,
    description: "URGENTE vendo hoy, pago por transferencia, no se puede probar",
  }, NOW);
  assert.strictEqual(red.level, "red", "esperado red, fue " + red.level);

  // Cuenta de 5 meses, 3 fotos, descripción vacía -> amarillo
  var yellow = S.evaluateSeller({
    sellerName: "Ana",
    sellerAccountCreatedDate: new Date(NOW - 150 * 86400000).toISOString().slice(0, 10),
    imageUrls: [1, 2, 3],
    price: 200,
    description: "",
  }, NOW);
  assert.strictEqual(yellow.level, "yellow", "esperado yellow, fue " + yellow.level);

  // Sin fecha de cuenta: es un dato ausente, no una señal de riesgo -> verde si el resto está limpio
  var unknown = S.evaluateSeller({ sellerName: "Ana", imageUrls: [1, 2, 3, 4], price: 200, description: "Buen estado, sin problemas." }, NOW);
  assert.strictEqual(unknown.level, "green", "dato ausente no debe teñir el resultado (riesgo " + unknown.riskScore + ")");

  // Las señales limpias se publican y reflejan el dato realmente leído.
  assert.ok(green.notes.length > 0, "un listing limpio debe reportar lo que se ha leído");
  assert.ok(
    green.notes.some(function (n) { return n.indexOf("2020-05-01") >= 0; }),
    "las señales deben mostrar el dato leído: " + green.notes.join(" | ")
  );
  assert.strictEqual(unknown.notes.some(function (n) { return n.indexOf("años") >= 0; }), false,
    "sin fecha de alta no hay señal de antigüedad");

  // Wire-shape correcto para el renderer
  var wire = S.classify({ sellerName: "Jane", sellerAccountCreatedDate: "2019-01-01", imageUrls: [1, 2, 3, 4], price: 100, description: "Todo correcto, entrego en mano sin problema." });
  assert.strictEqual(wire.analysis.verdict, "good_deal");
  assert.ok(typeof wire.analysis.shortVerdict === "string" && wire.analysis.shortVerdict.length > 0);
  assert.ok(wire.analysis.itemDetails.conditionNotes.length > 0, "el renderer necesita las señales leídas");

  console.log("local-scoring: autochequeo OK");
  console.log("  verde:", green.riskScore, "| amarillo:", yellow.riskScore, "| rojo:", red.riskScore);
  console.log("  señales leídas:", green.notes.join(" | "));
}
