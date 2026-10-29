# Marketplace CRM — extensión desempaquetada

Carga los dos módulos portados (`facebook-data.js`, `local-scoring.js`) en
Facebook Marketplace y muestra un panel local: **cero red, cero backend**.

## Cargarla en Chrome

1. Abre `chrome://extensions/`.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige este directorio.

## Qué hace

- Detecta el ID del anuncio (URL `/marketplace/item/<id>/`, con respaldo en
  `a[href*="/marketplace/item/"]`).
- Llama a la query GraphQL del anuncio + fotos (los `doc_id` de `facebook-data.js`
  **caducan**: si da `null`, cámbialos por los de DevTools).
- Ejecuta `SpottableLocal.classify()` localmente y pinta el semáforo en la página.
- **Al pulsar el icono de la extensión** abre un popup con el informe campo a campo.

## El popup (verde / rojo)

`popup.html` + `popup.js` no leen Facebook: le piden el informe al content script
de la pestaña activa (`MCRM_GET_REPORT`) y lo pintan.

| Color | Significado |
| --- | --- |
| 🟢 verde | el dato se leyó y tiene valor |
| 🔴 rojo | error de lectura o dato ausente (se muestra el motivo) |

Filas del informe en un anuncio: ID, título, precio, descripción, condición,
ubicación, coordenadas, nº de fotos, detalles de producto, metadatos, vendedor,
ID del vendedor, alta de la cuenta, fecha de publicación, activo, vendido y el
semáforo local (veredicto, resumen, señales).

En `/messages/t/<id>/`: ID del vendedor, nombre de la conversación y todos los
anuncios de Marketplace compartidos en el chat.

Si el anuncio aún se está leyendo, el popup se refresca solo cada 700 ms. El
botón **Re-analizar** repite la consulta y **Copiar JSON** copia el informe
completo (útil para depurar `doc_id` caducados).

Cuando GraphQL falla, el popup sigue mostrando lo que se pudo leer del DOM
(título y precio) marcado con origen `DOM`, y en rojo el resto con el motivo.

## Antes de usarla por primera vez

Abre una pestaña con Facebook y el panel de red de DevTools: busca la petición
`https://www.facebook.com/api/graphql/` con `doc_id=33071634612482224` y copia
el ID. Si la extensión no lee anuncios, actualiza `DOC_ID_LISTING`,
`DOC_ID_PHOTOS` y `DOC_ID_SEARCH` en `facebook-data.js`.

Requiere **sesión iniciada** para leer el nombre del vendedor.

## Autochequeo (sin navegador)

```bash
node facebook-data.js     # pasa hoy
node ../local-scoring.js  # pasa hoy
```
