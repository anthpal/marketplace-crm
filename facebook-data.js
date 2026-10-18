/**
 * facebook-data.js — capa de datos de Facebook Marketplace.
 *
 * Extraído del bundle (content-scripts/content.js, v0.0.14), traducido y sin
 * minificar. Sin dependencias, sin `chrome`, sin React. Sólo fetch + parsers
 * + DOM. Expone: globalThis.FacebookData = { ... }
 *
 * Portado tal cual: dónde decía `// era:` es el nombre en el bundle, para poder
 * diffear. Los `console.log` de depuración del original se han quitado (eran
 * "response status", "raw response length", "first 300 chars"...); sólo quedan
 * los avisos de fallo. Si algo deja de funcionar, vuelve a ponerlos.
 *
 * ---------------------------------------------------------------------------
 * AVISO 1 — los doc_id CADUCAN. Son identificadores de "persisted query": los
 * asigna Facebook y los rota cuando despliega. No hay API para descubrirlos ni
 * forma de adivinarlos; se copian del tráfico de Facebook en DevTools. Los tres
 * de abajo funcionaban el 2026-10. Si el scraping devuelve `null` y los logs
 * dicen "no target in response", es esto.
 *
 * AVISO 2 — `sellerAccountCreatedDate` casi nunca existe. La query del anuncio
 * devuelve el vendedor como {id, name} y nada más, así que findJoinDate() no
 * encuentra nada NUNCA (recorre el objeto buscando "join"/"member_since" pero la
 * fecha no está ahí). El valor real sale del DOM con joinDateFromPage(), que
 * depende de que la página muestre literalmente "Joined ... <año>". Es decir:
 * ese dato es estructuralmente frágil.
 *
 * AVISO 3 — todo esto es scraping no oficial. Replica la query del propio
 * cliente web con credentials:"omit" (anónimo, sin cookies). Si Facebook exige
 * login en Marketplace, el camino entero se cae. El escaneo de cuadrícula
 * dispara una petición por anuncio visible; eso invita a que te limiten.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  // --- Constantes (eran Rr, Pu, G0, Y0, zi, X0, Q0, ef, V0, K0, Z0, J0, $0, F0)
  var GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
  var DOC_ID_LISTING = "33071634612482224"; // marketplace_product_details_page
  var DOC_ID_PHOTOS = "10059604367394414"; // fotos del anuncio (query aparte)
  var DOC_ID_SEARCH = "7111939778879383"; // búsqueda por texto (comparables)
  var REQUEST_TIMEOUT_MS = 15000;

  var COMPARABLES_COUNT = 24; // cuántos resultados pide por página
  var COMPARABLES_MAX_PAGES = 3;
  var COMPARABLES_MAX_RESULTS = 52;
  var COMPARABLES_RADIUS_DEFAULT_KM = 200;
  var COMPARABLES_RADIUS_MIN_KM = 5;
  var COMPARABLES_RADIUS_MAX_KM = 200;
  var COMPARABLES_WAIT_DEFAULT_MS = 4500;
  var COMPARABLES_WAIT_MIN_MS = 1200;
  var COMPARABLES_PAGE_FLOOR_MS = 500;

  // Cabeceras idénticas en las tres llamadas. `same-origin` es lo que hace que
  // Facebook acepte la petición como si viniera de su propio cliente web.
  var POST_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };

  // =========================================================================
  // Transporte
  // =========================================================================

  /** era: Br — fetch con timeout. Se usa setTimeout a secas: en un service
   * worker no existe `window`. */
  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(
      function () {
        clearTimeout(timer);
      },
    );
  }

  /** era: Hr — Facebook antepone un prefijo anti-secuestro de JSON a algunas
   * respuestas. Sin quitarlo, JSON.parse falla. Si aun así falla, prueba con la
   * primera línea que empiece por "{". Devuelve null si no hay forma. */
  function parseGraphQLResponse(raw, label) {
    var text = raw;
    var prefixes = ["for (;;);", "while(1);", ")]}'"];
    for (var i = 0; i < prefixes.length; i += 1) {
      if (text.indexOf(prefixes[i]) === 0) text = text.slice(prefixes[i].length);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      var lines = text.split("\n");
      for (var j = 0; j < lines.length; j += 1) {
        if (lines[j].trim().indexOf("{") === 0) {
          try {
            return JSON.parse(lines[j]);
          } catch (e2) {
            /* sigue abajo */
          }
        }
      }
      return null;
    }
  }

  /** era: fb — true si TODOS los errores son "missing_required_variable_value".
   * Eso significa "las variables no son las que espera esta query", y es lo que
   * autoriza a reintentar con otro nombre de variable. */
  function hasMissingRequiredVariable(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return false;
    return errors.every(function (error) {
      return (
        error &&
        typeof error.message === "string" &&
        error.message.indexOf("missing_required_variable_value") >= 0
      );
    });
  }

  function postForm(body, timeoutMs) {
    return fetchWithTimeout(
      GRAPHQL_URL,
      { method: "POST", headers: POST_HEADERS, body: body, credentials: "omit" },
      timeoutMs,
    );
  }

  // =========================================================================
  // Normalizadores de campos
  // =========================================================================

  /** era: Oi — deducir la moneda del símbolo del precio formateado. */
  function currencyFromSymbol(text) {
    if (!text) return "";
    if (text.indexOf("CA$") >= 0) return "CAD";
    if (text.indexOf("A$") >= 0) return "AUD";
    if (text.indexOf("US$") >= 0 || text.indexOf("$") >= 0) return "USD";
    if (text.indexOf("£") >= 0) return "GBP";
    if (text.indexOf("€") >= 0) return "EUR";
    return "";
  }

  /** era: tf — precio, en tres variantes de esquema. La existencia de las tres
   * es cicatriz: el esquema de Facebook ya cambió antes. La última está en
   * centavos y por eso divide entre 100. */
  function parsePrice(node) {
    if (!node) return { amount: 0, currency: "" };
    var amountStr = typeof node.amount === "string" ? node.amount : "";
    var formatted =
      typeof node.formatted_amount_zeros_stripped === "string"
        ? node.formatted_amount_zeros_stripped
        : typeof node.formatted_amount === "string"
          ? node.formatted_amount
          : "";
    var offsetStr =
      typeof node.amount_with_offset_in_currency === "string"
        ? node.amount_with_offset_in_currency
        : "";
    var currency = typeof node.currency === "string" ? node.currency : "";

    var amount = amountStr ? Number.parseFloat(amountStr) : NaN;
    if (Number.isFinite(amount) && amount >= 0)
      return { amount: amount, currency: currency || currencyFromSymbol(formatted) };

    var match = formatted.match(/([\d,]+(?:\.\d{1,2})?)/);
    if (match && match[1]) {
      var parsed = Number.parseFloat(match[1].replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed >= 0)
        return { amount: parsed, currency: currency || currencyFromSymbol(formatted) };
    }

    var offset = Number.parseInt(offsetStr, 10);
    return Number.isFinite(offset) && offset >= 0 && currency
      ? { amount: offset / 100, currency: currency || currencyFromSymbol(formatted) }
      : { amount: 0, currency: currency || currencyFromSymbol(formatted) };
  }

  /** era: of — fecha "de alta" -> "YYYY-MM-DD". Acepta segundos, milisegundos
   * (`> 1e10` es el umbral) o texto con año ("Joined 2019", "Marzo 2019"). */
  function parseJoinDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      var ms = value > 1e10 ? value : value * 1e3;
      var date = new Date(ms);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
    }
    if (typeof value !== "string") return undefined;
    var text = value.trim();
    if (!text) return undefined;
    var year = text.match(/\b(19|20)\d{2}\b/);
    if (!year) return undefined;
    var parsed = Date.parse(text);
    return Number.isNaN(parsed) ? year[0] : new Date(parsed).toISOString().slice(0, 10);
  }

  /** era: cb — recorre el objeto en anchura (máx. 80 nodos) buscando una clave
   * que suene a fecha de alta. En la práctica no encuentra nada: ver AVISO 2. */
  function findJoinDate(obj) {
    if (!obj) return undefined;
    var seen = new Set();
    var queue = [obj];
    var maxNodes = 80;
    var visited = 0;
    while (queue.length > 0 && visited < maxNodes) {
      var node = queue.shift();
      visited += 1;
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      var entries = Object.entries(node);
      for (var i = 0; i < entries.length; i += 1) {
        var key = entries[i][0].toLowerCase();
        var value = entries[i][1];
        if (
          key.indexOf("join") >= 0 ||
          key.indexOf("member_since") >= 0 ||
          key.indexOf("membersince") >= 0 ||
          key.indexOf("account_creation") >= 0 ||
          key.indexOf("registration") >= 0 ||
          key.indexOf("created") >= 0
        ) {
          var found = parseJoinDate(value);
          if (found) return found;
        }
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return undefined;
  }

  /** era: ub — el fallback real: leer "Joined ... <año>" del texto visible.
   * `doc` es inyectable para poder probarlo sin navegador. */
  function joinDateFromPage(doc) {
    var d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.body) return undefined;
    var text = d.body.innerText || "";
    if (!text) return undefined;
    var match = text.match(
      /\bJoined(?:\s+Facebook)?(?:\s+in)?\s+([A-Za-z]{3,12}\s+\d{4}|\d{4})\b/i,
    );
    return match && match[1] ? parseJoinDate(match[1]) : undefined;
  }

  // =========================================================================
  // attribute_data -> condición / detalles de producto
  // -------------------------------------------------------------------------
  // Este bloque es el verdadero conocimiento del esquema: qué campos de
  // Facebook son metadatos internos, cómo se etiquetan los de vehículo, y cómo
  // aplanar los anidados. `af` era el whitelist; W0/I0/P0 los mapas de
  // etiquetas.
  // =========================================================================

  /** era: af — campos del anuncio que NO son atributos de producto. */
  var FIELD_WHITELIST = new Set([
    "__typename",
    "attribute_data",
    "condition",
    "condition_text",
    "creation_time",
    "delivery_types",
    "id",
    "is_hidden",
    "is_live",
    "is_pending",
    "is_sold",
    "item_location",
    "listing_photos",
    "listing_price",
    "location",
    "location_text",
    "marketplaceListingRenderableIfLoggedOut",
    "marketplace_listing_category_id",
    "marketplace_listing_seller",
    "marketplace_listing_title",
    "redacted_description",
    "share_uri",
    "strikethrough_price",
  ]);

  /** era: W0 — nombres legibles de los atributos de vehículo. */
  var VEHICLE_LABELS = {
    dealership_name: "Dealership",
    unit_area_info: "Area",
    unit_room_info: "Rooms",
    vehicle_exterior_color: "Exterior Color",
    vehicle_fuel_type: "Fuel Type",
    vehicle_identification_number: "VIN",
    vehicle_interior_color: "Interior Color",
    vehicle_is_paid_off: "Paid Off",
    vehicle_make_display_name: "Make",
    vehicle_model_display_name: "Model",
    vehicle_number_of_owners: "Owners",
    vehicle_odometer_data: "Mileage",
    vehicle_seller_type: "Seller Type",
    vehicle_title_status: "Title Status",
    vehicle_transmission_type: "Transmission",
    vehicle_trim_display_name: "Trim",
  };

  /** era: I0 — etiquetas que empiezan por estos prefijos son ruido interno. */
  var HIDDEN_LABEL_PREFIXES = [
    "Can Buyer ",
    "Can Seller ",
    "Is Viewer ",
    "Is Checkout ",
    "Is Draft",
    "Is On Marketplace",
    "Is Shipping Offered",
    "Is Seller Business ",
    "Is Purchase Protected",
    "Is Cart Enabled",
    "Is Buy Now Enabled",
    "Is Email Communication ",
    "Is Lead Gen ",
    "Should ",
    "Listing Is ",
    "Listing Inventory ",
    "Reportable ",
    "Sweepstake ",
    "Origin ",
    "Marketplace Listing Category ",
    "Nearby Transits ",
    "Nearby Schools ",
    "Shipping Offered",
    "If Viewer ",
  ];

  /** era: P0 — etiquetas internas exactas. */
  var HIDDEN_LABELS = new Set([
    "Can Share",
    "Has Children",
    "Has Free Shipping Discounts",
    "Is Map Eligible",
    "Legal Disclosure",
    "Seller Cms",
    "Seller Message Thread",
    "Seller Phone Number",
  ]);

  /** era: yt */
  function collapseSpaces(text) {
    return text.trim().replace(/\s+/g, " ");
  }

  /** era: nf — "make_display_name" -> "makeDisplayName" (clave canónica). */
  function camelKey(text) {
    var parts = text
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean);
    if (parts.length === 0) return "";
    return parts
      .map(function (part, index) {
        var lower = part.toLowerCase();
        return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");
  }

  /** era: Lr — "vehicle_make_display_name" -> "Vehicle Make Display Name". */
  function humanLabel(text) {
    return text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .split(" ")
      .map(function (word) {
        var clean = collapseSpaces(word);
        return clean ? clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase() : "";
      })
      .filter(Boolean)
      .join(" ");
  }

  /** era: eb — ¿merece la pena humanizar? No, si trae puntuación, si mezcla
   * mayúsculas y minúsculas con espacios (frase ya escrita), o si es un código
   * largo en mayúsculas con dígitos. */
  function shouldHumanize(text) {
    if (
      /[.,/]/.test(text) ||
      (/\s/.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text)) ||
      (/^[A-Z0-9]{8,}$/.test(text) && /\d/.test(text))
    )
      return false;
    return /^[A-Za-z0-9_ -]+$/.test(text);
  }

  /** era: _a */
  function formatValue(value) {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "number")
      return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
    var text = collapseSpaces(value);
    if (!text) return "";
    return shouldHumanize(text) ? humanLabel(text) : text;
  }

  /** era: kr — normalizar recursivamente las claves de un objeto anidado. */
  function canonicalizeKeys(value) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (Array.isArray(value)) return value.map(canonicalizeKeys);
    if (!value || typeof value !== "object") return value;
    var out = {};
    var entries = Object.entries(value);
    for (var i = 0; i < entries.length; i += 1) {
      var key = camelKey(entries[i][0]);
      out[key || entries[i][0]] = canonicalizeKeys(entries[i][1]);
    }
    return out;
  }

  /** era: tb */
  function setPath(target, path, value) {
    if (path.length === 0) return;
    var node = target;
    for (var i = 0; i < path.length - 1; i += 1) {
      var existing = node[path[i]];
      if (!existing || typeof existing !== "object" || Array.isArray(existing))
        node[path[i]] = {};
      node = node[path[i]];
    }
    node[path[path.length - 1]] = value;
  }

  /** era: ab — qué grupos de atributos (vehicle, nearby, ...) existen. Un
   * prefijo cuenta si aparece en 2+ campos; vehicle/nearby van siempre. */
  function attributePrefixes(node) {
    var counts = new Map();
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (FIELD_WHITELIST.has(key)) continue;
      var match = key.match(/^([a-z0-9]+)_(.+)$/i);
      if (!match) continue;
      var prefix = match[1];
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
    var prefixes = new Set(["nearby", "vehicle"]);
    counts.forEach(function (count, prefix) {
      if (count >= 2) prefixes.add(prefix);
    });
    return prefixes;
  }

  /** era: jr — etiqueta final de un atributo. */
  function labelFor(prefix, path, attributeKey) {
    if (VEHICLE_LABELS[attributeKey]) return VEHICLE_LABELS[attributeKey];
    var pathLabels = path.map(function (part) {
      return humanLabel(part);
    });
    return prefix === "vehicle"
      ? pathLabels.join(" ")
      : [humanLabel(prefix)].concat(pathLabels).join(" ");
  }

  /** era: nb — objetos {value, unit} / {min, max, unit} -> "120.000 km". */
  function formatMeasurement(node) {
    if (typeof node.value === "number" && typeof node.unit === "string")
      return node.value.toLocaleString("en-US") + " " + formatValue(node.unit).toLowerCase();
    if (typeof node.value === "string" && typeof node.unit === "string")
      return formatValue(node.value) + " " + formatValue(node.unit).toLowerCase();
    if (
      typeof node.min === "number" &&
      typeof node.max === "number" &&
      typeof node.unit === "string"
    )
      return (
        node.min.toLocaleString("en-US") +
        "-" +
        node.max.toLocaleString("en-US") +
        " " +
        formatValue(node.unit).toLowerCase()
      );
    return undefined;
  }

  /** era: lb — un transporte cercano -> "Metro • 300 m • Sol • L1, L2". */
  function formatTransit(transit) {
    var icon = typeof transit.fbIconFilledName === "string" ? formatValue(transit.fbIconFilledName) : "";
    var distance = typeof transit.distanceFbt === "string" ? collapseSpaces(transit.distanceFbt) : "";
    var stop = typeof transit.stopName === "string" ? collapseSpaces(transit.stopName) : "";
    var routes = Array.isArray(transit.routeNames)
      ? transit.routeNames
          .filter(function (name) {
            return typeof name === "string";
          })
          .map(collapseSpaces)
          .filter(Boolean)
      : [];
    var parts = [icon, distance, stop, routes.join(", ")].filter(Boolean);
    return parts.length > 0 ? parts.join(" • ") : undefined;
  }

  /** era: ib — atributos con formato propio (área, habitaciones, transportes). */
  function specialDetailsFor(attributeKey, value) {
    if (attributeKey === "unit_area_info" && typeof value === "string" && collapseSpaces(value))
      return [{ label: "Area", value: collapseSpaces(value) }];
    if (attributeKey === "unit_room_info" && typeof value === "string" && collapseSpaces(value))
      return [{ label: "Rooms", value: collapseSpaces(value) }];
    if (attributeKey === "nearby_transits" && Array.isArray(value))
      return value.slice(0, 3).flatMap(function (transit, index) {
        if (!transit || typeof transit !== "object" || Array.isArray(transit)) return [];
        var formatted = formatTransit(transit);
        return formatted
          ? [{ label: "Nearby Transit " + (index + 1), value: formatted }]
          : [];
      });
    return [];
  }

  /** era: ob */
  function isHiddenLabel(label) {
    if (HIDDEN_LABELS.has(label)) return true;
    return HIDDEN_LABEL_PREFIXES.some(function (prefix) {
      return label.indexOf(prefix) === 0;
    });
  }

  /** era: lf — orden de la lista final: condición primero, luego vehículo, etc. */
  function labelRank(label) {
    if (label === "Condition") return 0;
    var vehicleOrRoom = [
      "Make",
      "Model",
      "Trim",
      "Mileage",
      "Transmission",
      "Fuel Type",
      "Exterior Color",
      "Interior Color",
      "Owners",
      "Title Status",
      "Seller Type",
      "VIN",
      "Paid Off",
      "Dealership",
      "Area",
      "Rooms",
    ];
    if (vehicleOrRoom.indexOf(label) >= 0) return 1;
    if (label.indexOf("Nearby Transit ") === 0) return 2;
    if (label.indexOf("Specifications ") === 0) return 3;
    return 4;
  }

  /** era: Ur — aplanar un valor de atributo a [{label, value}]. */
  function flattenAttributeValue(prefix, attributeKey, value, path) {
    var trailing = path || [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      var formatted = formatValue(value);
      return formatted
        ? [{ label: labelFor(prefix, trailing, attributeKey), value: formatted }]
        : [];
    }
    if (Array.isArray(value)) {
      var scalars = value.filter(function (item) {
        return (
          typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        );
      });
      if (scalars.length === value.length && scalars.length > 0)
        return [
          {
            label: labelFor(prefix, trailing, attributeKey),
            value: scalars
              .map(function (item) {
                return formatValue(item);
              })
              .join(", "),
          },
        ];
      return value.flatMap(function (item, index) {
        return flattenAttributeValue(prefix, attributeKey, item, trailing.concat(String(index + 1)));
      });
    }
    if (!value || typeof value !== "object") return [];
    var measurement = formatMeasurement(value);
    if (measurement) return [{ label: labelFor(prefix, trailing, attributeKey), value: measurement }];
    return Object.entries(value).flatMap(function (entry) {
      return flattenAttributeValue(prefix, attributeKey, entry[1], trailing.concat(entry[0]));
    });
  }

  /** era: rb — quitar duplicados por etiqueta+valor y recortar espacios. */
  function dedupeEntries(entries) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < entries.length; i += 1) {
      var label = collapseSpaces(entries[i].label);
      var value = collapseSpaces(entries[i].value);
      if (!label || !value) continue;
      var key = label.toLowerCase() + "::" + value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: label, value: value });
    }
    return out;
  }

  /** era: sb — el nodo del anuncio -> {condition, productDetails, extraMetadata}. */
  function attributesToDetails(listing) {
    var entries = [];
    var condition;
    var attributeData = listing.attribute_data;
    if (Array.isArray(attributeData)) {
      for (var i = 0; i < attributeData.length; i += 1) {
        var attr = attributeData[i];
        var name = collapseSpaces(attr.attribute_name || "");
        var value = collapseSpaces(attr.label || attr.value || "");
        if (!name || !value) continue;
        if (name === "Condition") condition = value;
        entries.push({ label: name, value: value });
      }
    }
    if (!condition && typeof listing.condition === "string") condition = formatValue(listing.condition);
    if (condition) entries.push({ label: "Condition", value: condition });

    var prefixes = attributePrefixes(listing);
    var extraMetadata = {};
    var keys = Object.keys(listing);
    for (var j = 0; j < keys.length; j += 1) {
      var key = keys[j];
      if (FIELD_WHITELIST.has(key)) continue;
      var match = key.match(/^([a-z0-9]+)_(.+)$/i);
      if (!match) continue;
      var prefix = match[1];
      var rest = match[2];
      if (!prefixes.has(prefix)) continue;
      var camel = camelKey(rest);
      if (!camel) continue;
      var canonical = canonicalizeKeys(listing[key]);
      setPath(extraMetadata, [prefix, camel], canonical);
      var special = specialDetailsFor(key, canonical);
      if (special.length > 0) {
        entries.push.apply(entries, special);
        continue;
      }
      entries.push.apply(entries, flattenAttributeValue(prefix, key, listing[key], [camel]));
    }

    var details = dedupeEntries(entries).filter(function (entry) {
      return !isHiddenLabel(entry.label);
    });
    details.sort(function (a, b) {
      var rankA = labelRank(a.label);
      var rankB = labelRank(b.label);
      return rankA !== rankB ? rankA - rankB : a.label.localeCompare(b.label);
    });

    return {
      condition: condition,
      productDetails: details.length > 0 ? details : undefined,
      extraMetadata: Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
    };
  }

  // =========================================================================
  // Anuncio (PDP)
  // =========================================================================

  /** era: vb — la query del anuncio.
   *
   * Prueba 6 formas distintas de nombrar la variable (`targetId`, `targetID`,
   * `id`, `listingId`, `itemId`). Eso no es defensa elegante: es que nadie sabía
   * cuál esperaba el servidor, así que se prueban todas. Sólo se reintenta si el
   * error es "missing_required_variable_value" (o si la respuesta no es ok).
   */
  async function fetchListing(listingId) {
    var candidates = [
      { targetId: listingId, scale: 1 },
      { targetID: listingId, scale: 1 },
      { id: listingId, scale: 1 },
      { listingId: listingId, scale: 1 },
      { itemId: listingId, scale: 1 },
      { targetId: listingId },
    ];
    try {
      for (var attempt = 0; attempt < candidates.length; attempt += 1) {
        var body = new URLSearchParams({
          doc_id: DOC_ID_LISTING,
          variables: JSON.stringify(candidates[attempt]),
        });
        var response = await postForm(body.toString(), REQUEST_TIMEOUT_MS);
        if (!response.ok) continue;

        var parsed = parseGraphQLResponse(await response.text(), "fetchListing");
        if (!parsed) continue;

        var page =
          parsed.data && parsed.data.viewer
            ? parsed.data.viewer.marketplace_product_details_page
            : undefined;
        var target = page ? page.target : undefined;
        var renderable = page ? page.marketplace_listing_renderable_target : undefined;
        if (!target) {
          // Las variables no eran las correctas y quedan intentos: prueba otra.
          if (hasMissingRequiredVariable(parsed.errors) && attempt < candidates.length - 1)
            continue;
          return null;
        }

        var asString = function (value) {
          return typeof value === "string" ? value : undefined;
        };
        var asNumber = function (value) {
          return typeof value === "number" ? value : undefined;
        };
        var asBoolean = function (value) {
          return typeof value === "boolean" ? value : undefined;
        };

        var seller = target.marketplace_listing_seller;
        var locationText = target.location_text;
        var location = target.location;
        var description = target.redacted_description;
        var details = attributesToDetails(target);
        var price = parsePrice(target.listing_price);
        var title =
          asString(renderable && renderable.marketplace_listing_title) ||
          asString(target.marketplace_listing_title) ||
          "";

        return {
          id: asString(target.id) || listingId,
          title: title,
          description: asString(description && description.text) || "",
          price: price.amount,
          currency: price.currency,
          location: asString(locationText && locationText.text) || "",
          condition: details.condition || "",
          productDetails: details.productDetails,
          extraMetadata: details.extraMetadata,
          latitude: asNumber(location && location.latitude),
          longitude: asNumber(location && location.longitude),
          createdTime: asNumber(target.creation_time),
          sellerAccountCreatedDate: findJoinDate(seller) || joinDateFromPage(),
          isLive: asBoolean(target.is_live),
          isSold: asBoolean(target.is_sold),
          sellerName: asString(seller && seller.name),
          sellerId: asString(seller && seller.id),
        };
      }
      return null;
    } catch (error) {
      console.warn("[facebook-data] fetchListing exception", error);
      return null;
    }
  }

  /** era: xb — las fotos van en otra query, con otro doc_id. */
  async function fetchPhotos(listingId) {
    var body = new URLSearchParams({
      doc_id: DOC_ID_PHOTOS,
      variables: JSON.stringify({ targetId: listingId }),
    });
    try {
      var response = await postForm(body.toString(), REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      var parsed = parseGraphQLResponse(await response.text(), "fetchPhotos");
      if (!parsed) return [];
      var page =
        parsed.data && parsed.data.viewer
          ? parsed.data.viewer.marketplace_product_details_page
          : undefined;
      var target = page ? page.target : undefined;
      var photos = (target && target.listing_photos) || [];
      return photos
        .map(function (photo) {
          return photo.image ? photo.image.uri : undefined;
        })
        .filter(function (uri) {
          return !!uri;
        });
    } catch (error) {
      console.warn("[facebook-data] fetchPhotos exception", error);
      return [];
    }
  }

  /** era: qr — anuncio + fotos en paralelo. Devuelve null si no hay título:
   * sin título se considera que la lectura falló, y quien llama avisa. */
  async function fetchListingData(listingId, options) {
    var listingPromise = fetchListing(listingId);
    var photosPromise = fetchPhotos(listingId);
    var listing = await listingPromise;

    if (listing && listing.title && options && options.onPdpResolved) {
      try {
        options.onPdpResolved({
          id: listing.id || listingId,
          title: listing.title,
          latitude: listing.latitude,
          longitude: listing.longitude,
        });
      } catch (error) {
        console.warn("[facebook-data] onPdpResolved hook failed", error);
      }
    }

    var photos = await photosPromise;
    if (!listing || !listing.title) return null;
    // Mismo orden de claves que el original: si algo serializa el resultado
    // (JSON.stringify), un orden distinto da una cadena distinta.
    return {
      id: listing.id,
      title: listing.title,
      description: listing.description,
      price: listing.price,
      currency: listing.currency,
      location: listing.location,
      condition: listing.condition,
      productDetails: listing.productDetails,
      extraMetadata: listing.extraMetadata,
      imageUrls: photos,
      sellerName: listing.sellerName,
      sellerId: listing.sellerId,
      latitude: listing.latitude,
      longitude: listing.longitude,
      createdTime: listing.createdTime,
      sellerAccountCreatedDate: listing.sellerAccountCreatedDate,
      isLive: listing.isLive,
      isSold: listing.isSold,
    };
  }

  // =========================================================================
  // Comparables de mercado (búsqueda por texto alrededor del anuncio)
  // =========================================================================

  /** era: hb — la query de búsqueda sale del título, primeras 8 palabras. */
  function searchQueryFromTitle(title) {
    var cleaned = title
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned ? cleaned.split(" ").slice(0, 8).join(" ") : "";
  }

  /** era: bb */
  function clampRadius(km) {
    if (!Number.isFinite(km)) return COMPARABLES_RADIUS_DEFAULT_KM;
    return Math.min(
      COMPARABLES_RADIUS_MAX_KM,
      Math.max(COMPARABLES_RADIUS_MIN_KM, Math.round(km)),
    );
  }

  /** era: yb */
  function clampWait(ms) {
    if (!Number.isFinite(ms)) return COMPARABLES_WAIT_DEFAULT_MS;
    return Math.min(REQUEST_TIMEOUT_MS, Math.max(COMPARABLES_WAIT_MIN_MS, Math.round(ms)));
  }

  /** era: db — el payload de variables de la búsqueda. */
  function comparablesVariables(options) {
    var variables = {
      count: COMPARABLES_COUNT,
      params: {
        bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query: options.query },
        browse_request_params: {
          commerce_enable_local_pickup: true,
          commerce_enable_shipping: true,
          commerce_search_and_rp_available: true,
          filter_location_latitude: Math.round(options.latitude * 1e6) / 1e6,
          filter_location_longitude: Math.round(options.longitude * 1e6) / 1e6,
          filter_price_lower_bound: 0,
          filter_price_upper_bound: 214748364700,
          filter_radius_km: options.radiusKm,
          sort_by: "DATE_DESCENDING",
        },
        custom_request_params: { surface: "SEARCH" },
      },
    };
    if (options.cursor) variables.cursor = options.cursor;
    return JSON.stringify(variables);
  }

  /** era: pb — un resultado -> comparable, o null si no sirve. */
  function toComparable(node) {
    var id = typeof node.id === "string" ? node.id : "";
    if (!/^\d+$/.test(id)) return null;
    var title = (
      (typeof node.marketplace_listing_title === "string" && node.marketplace_listing_title) ||
      (typeof node.title === "string" && node.title) ||
      ""
    ).trim();
    if (!title) return null;
    var priceNode =
      (node.listing_price && typeof node.listing_price === "object" && node.listing_price) ||
      (node.current_price && typeof node.current_price === "object" && node.current_price) ||
      null;
    var price = parsePrice(priceNode);
    if (!Number.isFinite(price.amount) || price.amount <= 0) return null;
    return {
      listingId: id,
      title: title,
      price: price.amount,
      currency: price.currency || undefined,
    };
  }

  /** era: mb — recorre la respuesta buscando cualquier nodo que sea un
   * comparable válido. No se conoce el esquema, así que se buscan todos. */
  function collectComparables(payload, excludeListingId) {
    var results = [];
    var seenIds = new Set();
    var seenNodes = new Set();
    var queue = [payload];
    while (queue.length > 0 && results.length < COMPARABLES_MAX_RESULTS) {
      var node = queue.shift();
      if (!node || typeof node !== "object" || seenNodes.has(node)) continue;
      seenNodes.add(node);
      var comparable = toComparable(node);
      if (
        comparable &&
        comparable.listingId !== excludeListingId &&
        !seenIds.has(comparable.listingId)
      ) {
        seenIds.add(comparable.listingId);
        results.push(comparable);
      }
      var values = Object.values(node);
      for (var i = 0; i < values.length; i += 1) {
        if (values[i] && typeof values[i] === "object") queue.push(values[i]);
      }
    }
    return results;
  }

  /** era: gb */
  function readPageInfo(payload) {
    var seen = new Set();
    var queue = [payload];
    while (queue.length > 0) {
      var node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (typeof node.has_next_page === "boolean")
        return {
          hasNextPage: node.has_next_page,
          endCursor: typeof node.end_cursor === "string" ? node.end_cursor : undefined,
        };
      var values = Object.values(node);
      for (var i = 0; i < values.length; i += 1) {
        if (values[i] && typeof values[i] === "object") queue.push(values[i]);
      }
    }
    return { hasNextPage: false };
  }

  /** era: rf — comparables. OJO: alimentaba el panel de benchmarks, que ya no
   * existe. Hoy nadie la llama; se conserva porque es la única pieza que usa
   * DOC_ID_SEARCH y por si quieres benchmarks en la extensión nueva. */
  async function fetchComparables(options) {
    var query = searchQueryFromTitle(options.title);
    if (!query) return [];
    if (!Number.isFinite(options.latitude) || !Number.isFinite(options.longitude)) return [];
    var radiusKm = clampRadius(options.radiusKm);
    var budget = clampWait(options.maxWaitMs);
    var deadline = Date.now() + budget;
    var results = [];
    var seenIds = new Set();
    var cursor;
    var pagesFetched = 0;
    var hitBudgetLimit = false;

    for (var page = 0; page < COMPARABLES_MAX_PAGES; page += 1) {
      var remaining = deadline - Date.now();
      if (remaining <= 0) {
        hitBudgetLimit = true;
        break;
      }
      var timeoutForPage = Math.min(
        REQUEST_TIMEOUT_MS,
        Math.max(COMPARABLES_PAGE_FLOOR_MS, remaining),
      );
      var body = new URLSearchParams({
        doc_id: DOC_ID_SEARCH,
        variables: comparablesVariables({
          query: query,
          latitude: options.latitude,
          longitude: options.longitude,
          radiusKm: radiusKm,
          cursor: cursor,
        }),
      });
      try {
        var response = await postForm(body.toString(), timeoutForPage);
        if (!response.ok) break;
        var parsed = parseGraphQLResponse(await response.text(), "fetchComparables");
        if (!parsed || (parsed.errors && parsed.errors.length)) break;
        pagesFetched += 1;

        var pageResults = collectComparables(parsed, options.listingId);
        for (var i = 0; i < pageResults.length; i += 1) {
          var comparable = pageResults[i];
          if (seenIds.has(comparable.listingId)) continue;
          seenIds.add(comparable.listingId);
          results.push(comparable);
          if (results.length >= COMPARABLES_MAX_RESULTS) return results;
        }

        var pageInfo = readPageInfo(parsed);
        if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") hitBudgetLimit = true;
        else console.warn("[facebook-data] fetchComparables failed on page", page + 1, error);
        break;
      }
    }
    return results;
  }

  // =========================================================================
  // DOM — de dónde salen las entradas
  // =========================================================================

  /** era: H0 — el listingId del href de una tarjeta. */
  function listingIdFromHref(href) {
    if (!href) return null;
    var match = href.match(/\/marketplace\/item\/(\d+)/);
    return match ? match[1] : null;
  }

  /** era: B0 — subir desde la imagen hasta el contenedor cuadrado de la tarjeta.
   * Efecto lateral heredado del original: fija `position: relative` en el
   * contenedor, porque el overlay de la insignia lo necesita. */
  function findCardContainer(image, card) {
    var ancestors = [];
    var node = image.parentElement;
    for (var i = 0; i < 8 && node && node !== card; i += 1) {
      ancestors.push(node);
      node = node.parentElement;
    }
    var isCardSized = function (element) {
      return (
        element.offsetWidth > 80 && Math.abs(element.offsetWidth - element.offsetHeight) < 40
      );
    };
    for (var j = 0; j < ancestors.length; j += 1) {
      if (
        isCardSized(ancestors[j]) &&
        window.getComputedStyle(ancestors[j]).position === "relative"
      )
        return ancestors[j];
    }
    for (var k = 0; k < ancestors.length; k += 1) {
      if (isCardSized(ancestors[k])) {
        ancestors[k].style.position = "relative";
        return ancestors[k];
      }
    }
    var firstChild = card.firstElementChild;
    if (firstChild) {
      var children = firstChild.children;
      for (var m = 0; m < children.length; m += 1) {
        var child = children[m];
        if (child instanceof HTMLElement && child.contains(image) && child.offsetWidth > 80) {
          child.style.position = "relative";
          return child;
        }
      }
    }
    return image.parentElement && image.parentElement !== card
      ? ((image.parentElement.style.position = "relative"), image.parentElement)
      : null;
  }

  /** era: q0 — el contenedor de la tarjeta a partir de su ancla. */
  function cardContainer(anchor) {
    var image = anchor.querySelector("img");
    if (image instanceof HTMLImageElement) {
      var byImage = findCardContainer(image, anchor);
      if (byImage) return byImage;
    }
    var firstChild = anchor.firstElementChild;
    if (firstChild) {
      var children = firstChild.children;
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (
          child instanceof HTMLElement &&
          child.offsetWidth > 80 &&
          Math.abs(child.offsetWidth - child.offsetHeight) < 40
        ) {
          child.style.position = "relative";
          return child;
        }
      }
    }
    return null;
  }

  /** era: la parte de datos del escaneo de cuadrícula (función Nb). Devuelve
   * {listingId, link, container} de cada anuncio visible.
   *
   * Diferencia a propósito con el original: aquél guardaba los contenedores en
   * un Map y devolvía además una lista sin deduplicar (una entrada por ancla,
   * y varias anclas pueden apuntar al mismo anuncio). Aquí se deduplica por
   * listingId y se conserva el último contenedor, que es lo que hacía el Map.
   * Lo de colocar insignias y leer storage que hacía alrededor no es datos. */
  function scanGrid(scope) {
    var container = scope || (typeof document !== "undefined" ? document : null);
    if (!container) return [];
    var anchors = container.querySelectorAll('a[href*="/marketplace/item/"]');
    var byListingId = new Map();
    for (var i = 0; i < anchors.length; i += 1) {
      var anchor = anchors[i];
      var listingId = listingIdFromHref(anchor.getAttribute("href"));
      if (!listingId) continue;
      var card = cardContainer(anchor);
      if (!card) continue;
      byListingId.set(listingId, { listingId: listingId, link: anchor, container: card });
    }
    return Array.from(byListingId.values());
  }

  root.FacebookData = {
    // Constantes que caducan
    GRAPHQL_URL: GRAPHQL_URL,
    DOC_ID_LISTING: DOC_ID_LISTING,
    DOC_ID_PHOTOS: DOC_ID_PHOTOS,
    DOC_ID_SEARCH: DOC_ID_SEARCH,
    // Transporte
    fetchWithTimeout: fetchWithTimeout,
    parseGraphQLResponse: parseGraphQLResponse,
    hasMissingRequiredVariable: hasMissingRequiredVariable,
    // Anuncio
    fetchListing: fetchListing,
    fetchPhotos: fetchPhotos,
    fetchListingData: fetchListingData,
    // Normalizadores
    currencyFromSymbol: currencyFromSymbol,
    parsePrice: parsePrice,
    parseJoinDate: parseJoinDate,
    findJoinDate: findJoinDate,
    joinDateFromPage: joinDateFromPage,
    attributesToDetails: attributesToDetails,
    // Comparables
    fetchComparables: fetchComparables,
    searchQueryFromTitle: searchQueryFromTitle,
    clampRadius: clampRadius,
    clampWait: clampWait,
    comparablesVariables: comparablesVariables,
    collectComparables: collectComparables,
    readPageInfo: readPageInfo,
    // DOM
    listingIdFromHref: listingIdFromHref,
    cardContainer: cardContainer,
    findCardContainer: findCardContainer,
    scanGrid: scanGrid,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

// ===========================================================================
// Autochequeo: `node facebook-data.js`
// Sin navegador y sin red: `fetch` va falseado con una respuesta de la forma
// real del esquema. Si Facebook cambia el esquema, esto no lo detecta — sólo
// detecta que el código sigue leyendo lo que lee.
// ===========================================================================
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  var assert = require("node:assert");
  var F = globalThis.FacebookData;

  // Prefijo anti-secuestro de JSON
  assert.deepStrictEqual(
    F.parseGraphQLResponse('for (;;);{"data":{"ok":1}}', "test"),
    { data: { ok: 1 } },
  );
  assert.strictEqual(F.parseGraphQLResponse("no soy json", "test"), null);

  // Precio: las tres variantes del esquema
  assert.deepStrictEqual(F.parsePrice({ amount: "1200", currency: "USD" }), {
    amount: 1200,
    currency: "USD",
  });
  assert.deepStrictEqual(F.parsePrice({ formatted_amount: "MX$1,200" }).amount, 1200);
  assert.deepStrictEqual(F.parsePrice({ amount_with_offset_in_currency: "120000", currency: "EUR" }), {
    amount: 1200,
    currency: "EUR",
  });
  assert.strictEqual(F.currencyFromSymbol("£300"), "GBP");

  // Fecha de alta: segundos, milisegundos y texto con año
  assert.strictEqual(F.parseJoinDate(1600000000), "2020-09-13");
  assert.strictEqual(F.parseJoinDate("2019"), "2019-01-01");
  assert.strictEqual(F.parseJoinDate("sin fecha"), undefined);
  assert.strictEqual(F.findJoinDate({ a: { b: { member_since: "2018" } } }), "2018-01-01");
  // El nodo del vendedor real es {id, name}: no hay fecha que encontrar
  assert.strictEqual(F.findJoinDate({ id: "99", name: "Ana" }), undefined);
  assert.strictEqual(
    F.joinDateFromPage({ body: { innerText: "Ana · Joined Facebook in 2017" } }),
    "2017-01-01",
  );

  // listingId desde el href, con y sin query
  assert.strictEqual(
    F.listingIdFromHref("https://www.facebook.com/marketplace/item/123456/?ref=x"),
    "123456",
  );
  assert.strictEqual(F.listingIdFromHref("/marketplace/profile/1/"), null);

  // attribute_data -> condition + detalles
  var details = F.attributesToDetails({
    attribute_data: [{ attribute_name: "Condition", label: "Used - Good" }],
    vehicle_make_display_name: "Toyota",
    vehicle_model_display_name: "Corolla",
    vehicle_odometer_data: { value: 120000, unit: "km" },
    marketplace_listing_title: "no es atributo",
    is_live: true,
  });
  assert.strictEqual(details.condition, "Used - Good");
  var labels = details.productDetails.map(function (d) {
    return d.label;
  });
  assert.deepStrictEqual(labels, ["Condition", "Make", "Mileage", "Model"]);
  assert.strictEqual(details.productDetails[0].value, "Used - Good");
  assert.strictEqual(details.productDetails[2].value, "120,000 km");
  assert.deepStrictEqual(details.extraMetadata, {
    vehicle: { makeDisplayName: "Toyota", modelDisplayName: "Corolla", odometerData: { value: 120000, unit: "km" } },
  });

  // query de búsqueda desde el título
  assert.strictEqual(
    F.searchQueryFromTitle("iPhone 13 Pro Max 256GB - como nuevo!!!"),
    "iPhone 13 Pro Max 256GB como nuevo",
  );

  // --- Camino completo con fetch falseado -------------------------------
  var PDP = {
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            id: "123456",
            marketplace_listing_title: "iPhone 13",
            listing_price: { amount: "600", currency: "EUR" },
            location_text: { text: "Madrid" },
            location: { latitude: 40.4, longitude: -3.7 },
            redacted_description: { text: "Como nuevo, con caja" },
            creation_time: 1700000000,
            is_live: true,
            is_sold: false,
            marketplace_listing_seller: { id: "99", name: "Ana" },
            attribute_data: [{ attribute_name: "Condition", label: "Used - Good" }],
            vehicle_make_display_name: "Toyota",
            vehicle_model_display_name: "Corolla",
          },
          marketplace_listing_renderable_target: { marketplace_listing_title: "iPhone 13" },
        },
      },
    },
  };
  var PHOTOS = {
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            listing_photos: [
              { image: { uri: "https://scontent/1.jpg" } },
              { image: { uri: "https://scontent/2.jpg" } },
              { image: {} },
            ],
          },
        },
      },
    },
  };

  var requests = [];
  globalThis.fetch = async function (url, options) {
    var params = new URLSearchParams(options.body);
    var docId = params.get("doc_id");
    requests.push({ docId: docId, variables: JSON.parse(params.get("variables")) });
    return {
      ok: true,
      status: 200,
      text: async function () {
        return "for (;;);" + JSON.stringify(docId === F.DOC_ID_LISTING ? PDP : PHOTOS);
      },
    };
  };

  (async function () {
    var listing = await F.fetchListingData("123456");
    assert.deepStrictEqual(listing, {
      id: "123456",
      title: "iPhone 13",
      description: "Como nuevo, con caja",
      price: 600,
      currency: "EUR",
      location: "Madrid",
      condition: "Used - Good",
      productDetails: [
        { label: "Condition", value: "Used - Good" },
        { label: "Make", value: "Toyota" },
        { label: "Model", value: "Corolla" },
      ],
      extraMetadata: { vehicle: { makeDisplayName: "Toyota", modelDisplayName: "Corolla" } },
      latitude: 40.4,
      longitude: -3.7,
      createdTime: 1700000000,
      sellerAccountCreatedDate: undefined,
      isLive: true,
      isSold: false,
      sellerName: "Ana",
      sellerId: "99",
      imageUrls: ["https://scontent/1.jpg", "https://scontent/2.jpg"],
    });
    // Una petición por doc_id, la variable que funciona a la primera
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(
      requests.map(function (r) {
        return r.docId;
      }),
      [F.DOC_ID_LISTING, F.DOC_ID_PHOTOS],
    );
    assert.deepStrictEqual(requests[0].variables, { targetId: "123456", scale: 1 });

    // Reintento: la primera respuesta no trae target y el error invita a probar otra variable
    var attempts = 0;
    globalThis.fetch = async function (url, options) {
      attempts += 1;
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify(
            attempts === 1
              ? { data: {}, errors: [{ message: "missing_required_variable_value" }] }
              : PDP,
          );
        },
      };
    };
    var retried = await F.fetchListing("123456");
    assert.strictEqual(attempts, 2, "debe reintentar con otra variable");
    assert.strictEqual(retried.title, "iPhone 13");

    console.log("facebook-data: autochequeo OK");
    console.log("  doc_id que caducan:", F.DOC_ID_LISTING, F.DOC_ID_PHOTOS, F.DOC_ID_SEARCH);
    console.log("  autochequeo sin navegador: sellerAccountCreatedDate =", listing.sellerAccountCreatedDate);
  })().catch(function (error) {
    console.error(error);
    process.exitCode = 1;
  });
}
