# AGENTS.md — semilla de la extensión nueva

Este directorio no es una extensión: es la **capa que sí vale la pena reusar**,
sacada en legible del bundle. Sirve para arrancar una extensión distinta sin
arrastrar React, la cola de trabajos ni los endpoints privados.

Lee `README.md` para el mapa con el bundle, lo verificado y los avisos. Esto de
aquí es el contrato y las reglas de diseño.

## Prioridad

**Los datos primero, el front al mínimo.** Lo útil es lo que se recaba del vendedor
y del anuncio; la UI es secundaria. Antes de añadir una pantalla, pregúntate si el
dato se puede leer y guardar sin ella.

## Contrato

```js
FacebookData.fetchListingData(listingId)  // -> objeto del anuncio, o null
SpottableLocal.classify(listingData)      // -> { analysis: { ... } }
```

`fetchListingData` devuelve, además de título/precio/descripción: `condition`,
`productDetails`, `extraMetadata`, `imageUrls` (su `.length` es el nº de fotos),
`latitude`/`longitude`, `createdTime`, `isLive`, `isSold`, `sellerName`,
`sellerId`, `sellerAccountCreatedDate`. Es el 100 % de la señal que existe; guarda
el objeto entero, no una selección.

`classify` devuelve el semáforo ya calculado:

| Campo | Uso |
| --- | --- |
| `shortVerdict` | texto de la insignia: "Sin señales de riesgo" / "Precaución" / "Posible riesgo" |
| `dealScore` | **sólo portador de banda**: 8–9 verde, 5–6 ámbar, 1–2 rojo |
| `verdict` | vocabulario del renderer antiguo (`good_deal` / `fair_price` / `avoid`) |
| `summary` | frase del modal |
| `redFlags[]` | señales de riesgo, para "cosas que revisar" |
| `itemDetails.conditionNotes[]` | señales **limpias** con su valor leído, para que el usuario valide qué se leyó |

## Reglas que no se negocian

1. **Cero red.** Nada a `spottableapp.com` ni a ningún backend propio. Toda la
   clasificación es local.
2. **Semáforo, nunca un número.** No pintes `dealScore` como nota; es la banda.
3. **El copy dice "posible riesgo", no "no fiable".** La heurística da falsos
   positivos con vendedores nuevos legítimos; habla de riesgo, no de personas.
4. **Un dato ausente pesa por sí mismo, nunca pone un suelo.** Si falta algo, suma
   su "sin dato" y sigue; no fuerces un color por lo que no se pudo observar.
5. **Enseña lo leído.** Las señales limpias van a la lista visible: es la forma de
   que el usuario compruebe que la extensión leyó lo que cree.

## Al tocar la heurística

- Pesos y umbrales viven en `local-scoring.js` (`THRESHOLDS`, `PATTERNS`,
  `ACCOUNT_AGE`, `ACCOUNT_UNKNOWN`). Es un archivo autocontenido: cámbialo ahí.
- Este `local-scoring.js` es una **copia** de la raíz del bundle. Si afinas en un
  sitio, copia al otro (`cp local-scoring.js extraccion/`) o divergen.
- **Si guardas análisis en caché, sube una versión de motor al cambiar la
  heurística.** En el bundle esto se nos fue una vez: se seguían sirviendo análisis
  viejos y parecía que el cambio no surtía efecto.

## Al tocar el scraping

- **Los `doc_id` caducan** (los rota Facebook). Si `fetchListing` devuelve `null`,
  es eso: se copian del tráfico real en DevTools. Los actuales están junto a
  `GRAPHQL_URL`.
- `scanGrid` **deduplica por `listingId` quedándose con el último contenedor**. Es
  la única diferencia deliberada con el bundle (que devolvía una entrada por
  ancla). Si necesitas todas las anclas, no es este ayudante.
- El vendedor necesita **sesión iniciada**, y la fecha de alta **no** viene del nodo
  del vendedor (la query sólo expone `{id, name}`): sale del texto de la página.
  Ver el aviso 2 del README.

## Autochequeo

```bash
node facebook-data.js     # el port y sus parsers, sin navegador
node local-scoring.js     # casos verde / ámbar / rojo y bordes
```

Los dos pasan hoy. Si tocas algo y dejan de pasar, has roto algo real.
