# extraccion/

Lógica portable de la extensión, en legible, para arrancar la extensión nueva.

Dos archivos, cero dependencias, cero `chrome`, cero React:

| Archivo | Qué es | Autochequeo |
| --- | --- | --- |
| `facebook-data.js` | Capa de datos de Marketplace: cliente GraphQL, parser del anuncio, normalizadores, atributos, comparables y los localizadores de DOM que producen las entradas | `node facebook-data.js` |
| `local-scoring.js` | Clasificador local (semáforo). **Copia** del de la raíz, para que la carpeta sea autocontenida | `node local-scoring.js` |

```js
// En un content script: basta con cargarlos antes.
// En Node: globalThis.FacebookData / globalThis.SpottableLocal
FacebookData.fetchListingData(listingId)
  .then(x => SpottableLocal.classify(x));
```

`local-scoring.js` está duplicado: si afinas la heurística en el de la raíz, copia
otra vez (`cp local-scoring.js extraccion/`) o el de aquí se queda atrás.

## Mapa con el bundle

Todo lo portado conserva un `// era: xx` con su nombre minificado, para poder
diffear contra `content-scripts/content.js`.

| Bundle | Aquí | Bundle | Aquí |
| --- | --- | --- | --- |
| `Rr`, `Pu`, `G0`, `Y0` | `GRAPHQL_URL`, `DOC_ID_*` | `Ur` | `flattenAttributeValue` |
| `Br` | `fetchWithTimeout` | `rb` | `dedupeEntries` |
| `Hr` | `parseGraphQLResponse` | `sb` | `attributesToDetails` |
| `fb` | `hasMissingRequiredVariable` | `of` | `parseJoinDate` |
| `tf`, `Oi` | `parsePrice`, `currencyFromSymbol` | `cb`, `ub` | `findJoinDate`, `joinDateFromPage` |
| `af`, `W0`, `I0`, `P0` | `FIELD_WHITELIST`, `VEHICLE_LABELS`, `HIDDEN_LABEL_PREFIXES`, `HIDDEN_LABELS` | `rf`, `db`, `pb`, `mb`, `gb`, `hb`, `bb`, `yb` | `fetchComparables`, `comparablesVariables`, `toComparable`, `collectComparables`, `readPageInfo`, `searchQueryFromTitle`, `clampRadius`, `clampWait` |
| `vb`, `xb`, `qr` | `fetchListing`, `fetchPhotos`, `fetchListingData` | `H0`, `B0`, `q0`, parte de `Nb` | `listingIdFromHref`, `findCardContainer`, `cardContainer`, `scanGrid` |

**Verificado en Node.** El port se comparó con el original ejecutando las funciones
reales del bundle (`sed -n '16288,17224p'` sobre una copia formateada con Prettier)
contra los mismos datos: 52 comparaciones, todas idénticas, incluidos el camino
completo `vb`/`xb`/`qr` y las dos páginas de `rf` con `fetch` falseado.

**Verificado en navegador.** Cargado como extensión desempaquetada en Chrome 151 y
ejecutado contra Facebook real (headless, `Extensions.loadUnpacked` por CDP):

| Comprobación | Resultado |
| --- | --- |
| Port vs original sobre 3 anuncios reales | Byte-idéntico, mismas claves y **mismo orden** |
| `fetchListingData` contra el GraphQL real | 1,5 s; los `doc_id` siguen vivos |
| `scanGrid` sobre la rejilla real | 18/18 contenedores (182×182), no sólo en teoría |
| `classify()` sobre datos reales | verde / ámbar / rojo, con `__light` y sin nota numérica |

Los tres ayudantes de DOM ya no están "sin ejecutar": se probaron contra el DOM real
de Marketplace. Siguen dependiendo del layout, pero se comportan como el original.

## Lo que NO está aquí, y por qué

- **React, JSX, CSS, insignias, modal, dock, toasts.** Front. Reescribir el
  semáforo son ~40 líneas de DOM plano; el resto del peso del bundle es React.
- **La cola de trabajos, `START_ANALYSIS_JOB`, el polling y la purga por
  `ENGINE_VERSION`.** Existían sólo porque el análisis era remoto. Con
  `classify()` en local es un mensaje y una respuesta síncrona.
- **Auth, chat, compartidos, MOTD, endpoints `/v1/`.** Muertos.
- **Los restos del modal que sólo tenían sentido con el backend:** las tarjetas
  "SUGGESTED" y "TYPICAL RANGE" (comparables; hoy salen vacías, con un guion) y el
  enlace "Get Full App" a `spottableapp.com`. En la extensión nueva no los pintes.

## Tres avisos que importan

1. **Los `doc_id` caducan.** Son identificadores de *persisted query* que asigna
   Facebook y rota al desplegar. No hay API para descubrirlos: se copian del
   tráfico en DevTools. Si `fetchListing` devuelve `null`, es esto.
2. **El vendedor necesita la sesión iniciada.** Sin sesión, Facebook no devuelve el
   nodo del vendedor en ningún anuncio (verificado en 4 reales): `sellerName` y
   `sellerAccountCreatedDate` llegan vacíos y el clasificador aplica su
   "sin dato +10", que es un respaldo para ese caso, no un suelo. Con la sesión
   abierta el nodo llega y el nombre se usa.

   Aviso aparte: la **fecha de alta no sale nunca del nodo del vendedor**. La query
   sólo expone `{id, name}`, así que `findJoinDate` no encuentra nada; el valor sale
   del texto de la página (`joinDateFromPage`), que necesita leer literalmente
   "Joined … <Mes Año>". Si ese texto no está, es "sin dato" (+10).
3. **Las señales que de verdad mueven el color también están en el DOM.** Fotos,
   descripción, precio, condición y nombre se ven en la página del anuncio sin
   tocar GraphQL. Leerlas del DOM te quita la dependencia de los `doc_id` que
   caducan — es el primer experimento que probaría en la extensión nueva. (Hoy la
   query responde sin sesión: 4 anuncios reales, 1,5 s cada uno.)
