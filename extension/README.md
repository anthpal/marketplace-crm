# Marketplace CRM — extensión desempaquetada

Carga los dos módulos portados (`facebook-data.js`, `local-scoring.js`) en
Facebook Marketplace y muestra un panel local: **cero red, cero backend**.

## Cargarla en Chrome

1. Abre `chrome://extensions/`.
2. Activa **Modo de desarrollador**.
3. Arrastra el contenido de este directorio (los 3 archivos) a la ventana.

## Qué hace

- Detecta el ID del anuncio (`a[href*="/marketplace/item/"]`).
- Llama a la query GraphQL del anuncio + fotos (los `doc_id` de `facebook-data.js`
  **caducan**: si da `null`, cámbialos por los de DevTools).
- Ejecuta `SpottableLocal.classify()` localmente y pinta el semáforo en la página.

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
