# el-coso-3000

Generador de **placeholders de imagen y video** que corre entero en el navegador.
Sin servidor, sin conexión, sin subir nada a ningún lado. El resultado es **un solo
archivo HTML** que se abre con doble click.

```
dist/index.html         ← esto es todo. Abrilo y usalo.
dist/placeholder.html   ← el mismo archivo, con nombre de archivo suelto.
```

[Abrir la demo online](https://maranimatias.github.io/el-coso-3000/). Se publica
automáticamente desde `main`; WebMCP funciona en esa versión si el navegador lo soporta.

## Qué genera

| Tipo | Formatos | Notas |
|---|---|---|
| Imagen | `PNG` · `JPEG` · `WebP` · `SVG` | PNG y WebP con transparencia. SVG lleva la fuente embebida, así que se ve igual en cualquier máquina. |
| GIF animado | `GIF` | Loop infinito. Paleta global de 256 colores compartida entre frames, así que no parpadea. |
| JPEG animado | `AVI` (Motion-JPEG) · `ZIP` de `.jpg` | Ningún navegador reproduce AVI: va a un editor o a Photoshop. |
| Video | `MP4` · `WebM` · `MOV` · `MKV` | Codifica con el motor del navegador, no hay que esperar en tiempo real. |

El texto del placeholder son **sólo las dimensiones**. En video, además, lleva una
barra de progreso y el reloj `0:03 / 0:10` al pie.

## El color no es al azar

Es lo que más se diferencia de otras herramientas. En vez de tirar dos colores
sueltos y rezar para que se lea, la paleta se **genera por fórmula** sobre la rueda
de tonos:

- El fondo es siempre pastel: luminosidad entre 88% y 94%.
- El texto es **del mismo tono**, con la saturación bajada y la luminosidad
  forzada al extremo contrario. Fondo clarito → texto oscuro; fondo oscuro → texto
  pastel claro.
- Después se mide el contraste con la fórmula de **WCAG 2.1** y, si queda bajo
  4.5:1, se empuja la luminosidad del texto hasta que llegue. La búsqueda es
  binaria, así que se converge al tono **más suave que todavía cumple**: un rojo
  clarito lleva un rojo más oscuro, no un negro duro.

El resultado siempre pasa AA, y la interfaz muestra el número:

```
Contraste   5.97:1   [AA]  cumple WCAG AA
```

Si tocás el color de fondo a mano, el texto se recalcula solo. El campo es
**readonly** a propósito: la legibilidad no es algo que se pueda arruinar por
accidente. Hay un botón de "aleatorio" que elige entre combinaciones ya
verificadas, nunca colores sueltos.

La página entera toma el tono del color elegido: al cambiar de paleta, la
interfaz se re-tiñe con ella, en claro y en oscuro. Arranca con una paleta al
azar, así que cada visita abre con un color distinto.

### La paleta

`rosa` · `coral` · `albaricoque` · `ámbar` · `lima` · `oliva` · `salvia` ·
`menta` · `verde azulado` · `turquesa` · `cielo` · `azul` · `acero` · `índigo` ·
`violeta` · `ciruela` · `orquídea` · `fucsia`

## Metadata dentro de los archivos

Cada archivo generado lleva metadatos diciendo de dónde salió:

```
Software : el-coso-3000
Comment  : Generado por el-coso-3000
Source   : <URL del repo>
Title    : Placeholder 1920x1080
```

Cómo se escriben depende del contenedor, porque cada formato tiene su forma:

| Formato | Mecanismo |
|---|---|
| PNG | chunks `tEXt` inyectados antes del `IEND` |
| JPEG | segmento `COM` inyectado después del `SOI` |
| WebP | chunk `XMP ` del contenedor RIFF, con un XMP válido |
| SVG | bloque `<metadata>` RDF |
| GIF | bloque Comment Extension `0x21 0xFE` |
| AVI | chunk `ISBJ` del RIFF `INFO` |
| ZIP | `metadata.json` adentro + comentario del EOCD |
| MP4 · MOV | `udta`/`meta` vía Mediabunny |
| MKV | elemento `Tags` de Matroska |
| **WebM** | recortado: Matroska sobre WebM sólo admite un subconjunto chico de tags |

Las dos últimas filas son límites del formato, no del código.

## El HTML también lleva metadata

`<meta name="generator">`, `description`, `author`, `canonical`, Open Graph y
Twitter card, apuntando al repo.

## WebMCP

La página se expone como herramienta para agentes de IA con
[WebMCP](https://github.com/webmachinelearning/webmcp), por las dos APIs:

- **Declarativa**: el formulario de controles lleva `toolname`,
  `tooldescription` y `toolparamdescription` en cada campo. El navegador lo
  convierte en una herramienta.
- **Imperativa**: `document.modelContext.registerTool` expone `generate_placeholder`
  con un JSON Schema que acepta `width`, `height`, `kind`, formatos, `palette`,
  `background`, `duration`, `fps`, y las opciones de la barra.

El color del texto **nunca** se pide al agente: se deriva del fondo, igual que para
una persona.

Es una mejora progresiva. WebMCP está en origin trial (Chrome 149+) y va detrás de
feature detection: si el navegador no lo soporta, no pasa nada y la app sigue
funcionando.

## Nombres de archivo

Las dimensiones van primero, que es lo primero que uno quiere saber:

```
1920x1080.png
1920x1080-15fps.gif
1920x1080-30fps-10s.mp4
1920x1080-30fps-10s.avi
```

Para GIF, si el FPS real difiere del pedido va el real, no el teórico.

## Publicar en GitHub Pages

`dist/` contiene `index.html` (la entrada del sitio) y `placeholder.html` (el
mismo archivo, con nombre para compartir o abrir local). El workflow
`.github/workflows/pages.yml` construye el HTML y publica `dist/` en GitHub Pages
cada vez que hay un push a `main`. Para habilitarlo, en **Settings → Pages → Build
and deployment → Source** elegí **GitHub Actions**. La demo queda en
`https://maranimatias.github.io/el-coso-3000/`.

Por eso `dist` **no** está en el `.gitignore`: contiene el HTML autocontenido que
se puede abrir directamente y que el workflow publica.

> Cuando se sirve por HTTP, la parte de WebMCP **sí se activa** si el navegador
> cumple los requisitos, porque hay aislamiento de origen. Con doble click
> (`file://`) no se activa, pero el resto de la app funciona igual en los dos casos.

## Desarmar y armar

Hace falta [Bun](https://bun.com). Node también anda para los tests, pero el
bundler es el de Bun.

```bash
bun install
bun run build              # arma dist/placeholder.html
bun test                   # tests unitarios (119)
bun run check:core         # paleta, auto-ajuste e imagen
bun run verify:browser     # el HTML real en un Chrome headless
bun run types              # tsc --noEmit
bun run fetch:font         # vuelve a bajar la tipografía
```

`bun run build` además **audita el resultado**: falla si el HTML generado
referencia cualquier recurso remoto. Si eso pasa, el archivo dejó de ser
autocontenido y es mejor que se rompa en el build y no en producción.

### Qué cubre cada capa de tests

Los tests de Bun no tienen DOM ni canvas, así que cubren la lógica de bytes con
entradas sintéticas: CRC32, LZW, estructura de GIF/ZIP/AVI, tabla de códecs,
cálculo de frames, integridad del bucle de encoding.

Eso **no** dice que el render funcione. Para eso está `verify:browser`, que abre
el HTML construido en un Chrome headless vía DevTools Protocol, mide el canvas
real, exercise la interfaz y **descarga los archivos de verdad** para verificar su
firma y su contenido. Los encoders de GIF y AVI también se validaron por fuera
con `ffmpeg`, `ffprobe` e ImageMagick.

Un detalle que costó encontrar: el decoder LZW del propio test tenía un bug
(resolvía entradas con `dict[code] !== undefined` en vez de `code < nextCode`), y
se cancelaba con un bug del encoder. El roundtrip pasaba con el encoder roto. Los
tests nuevos de `test/gif.test.ts` sirven justamente para que un error solo no
pueda pasar inadvertido.

### Layout

```
src/
  index.html        plantilla; lleva la metadata y los atributos de WebMCP
  styles.css        hoja de estilos, sin framework
  main.ts           entry point
  core/
    types.ts        contratos. Spec es lo que hablan todos los módulos
    color.ts        contraste WCAG, HSL y generación de la paleta
    fit-text.ts     auto-ajuste del tamaño de fuente por bisección
    draw-frame.ts   el render. Un solo camino para todo
    metadata.ts     los metadatos, en una forma agnóstica de contenedor
    filename.ts     convención de nombres y MIME
    download.ts     guardado, con streaming si el navegador lo permite
    font.ts         la tipografía embebida
  encoders/
    image.ts        PNG, JPEG, WebP, SVG
    gif.ts          GIF89a + LZW + median-cut
    mjpeg.ts        AVI con Motion-JPEG, y ZIP
    video.ts        MP4, WebM, MOV, MKV
  ui/
    app.ts          la interfaz
    webmcp.ts       la herramienta para agentes
test/                tests unitarios con bun test
scripts/            build, fetch-font, verify:browser y los checks
```

El punto de diseño importante es que **`drawFrame` es el único lugar que dibuja**.
El preview en vivo, el PNG, el GIF y el video pasan todos por la misma función, así
que lo que ves en pantalla es literalmente lo que va a quedar en el archivo. El SVG
reusa la misma matemática de layout y sus tests comparan renglón por renglón contra
el core, para que el vector y el ráster no divergan.

## Dependencias

Una sola, y es en tiempo de ejecución: **[mediabunny](https://mediabunny.dev)**
(MPL-2.0), que hace de muxer y le habla a WebCodecs. Sin framework de JS, sin
librería de CSS, sin runtime en la nube.

La tipografía es [Montserrat](https://fonts.google.com/specimen/Montserrat)
SemiBold, subset latino, embebida en base64 (SIL OFL 1.1).

> Se escribieron a mano la codificación de GIF y la de AVI/ZIP, unos 400 líneas en
> total. Se podría haber usado ffmpeg.wasm, pero son 31 MB de wasm contra los
> ~300 KB de Mediabunny, y además el core de ffmpeg necesita `SharedArrayBuffer`,
> que exige headers HTTP que un archivo local no puede tener. El GIF y el AVI
> salen además más rápido y ocupan cero.

### Por qué el video no se escribe a disco mientras se codifica

Mediabunny tiene `StreamTarget`, que suena ideal para no acumular el archivo en
memoria. **No se puede usar acá.** El muxer de MP4/MOV parchea la caja `mdat`
*hacia atrás* al finalizar, reescribiendo bytes que ya había escrito:

```
isobmff-muxer.js: patchBox(this.mdat)  ← con seek hacia atrás, al final
```

Matroska hace lo mismo con el tamaño del `Segment`. Un destino append-only
—que es lo que ofrece `StreamTarget`— aceptaría la escritura y produciría un MP4
**corrupto sin dar ningún error**. Por eso el video va con `BufferTarget` a
memoria. Con los topes de 4096 px y 3600 frames el buffer queda acotado y no hay
riesgo.

## Verificación

Lo que no se prueba, no está. `verify:browser` levanta el HTML **desde `file://`**
— el mismo contexto en que lo va a usar la gente, que no es el mismo que
`http://localhost`: `file://` tiene origen opaco y no está aislado.

Resultados ahí:

| Comprobación | |
|---|---|
| Contexto seguro, WebCodecs, `showSaveFilePicker` | disponibles desde `file://` |
| Consola | sin excepciones ni errores |
| Render | canvas 1920×1080, fondo pastel correcto, texto dibujado |
| Exportadores | 11 archivos descargados de verdad y verificados por fuera |
| **WebMCP** | **no funciona desde `file://`** |

Lo último es un límite real y conocido: WebMCP exige aislamiento de origen, y un
documento `file://` no lo tiene. La app degrada en silencio, pero si alguien
quiere usar la herramienta desde un agente, tiene que servirla por HTTP.

Los archivos que genera se verifican con herramientas externas, que es la única
forma de saber si de verdad sirven:

```
ffprobe   → h264 / vp9, 320x240, 6 fps, 1.0s, 6 frames
ffmpeg    → decodifica el GIF completo sin errores
ImageMagick → identify: formato, dimensiones, colores
unzip -t  → ZIP íntegro
```

### Bugs que sólo aparecen usándolo de verdad

Cinco de los ocho que se encontraron no los veía ningún test:

1. El canvas **negro**: `fillStyle` descarta en silencio un hex sin `#`.
2. El selector de formato **nunca cambiaba**: devuelve un `RadioNodeList`, no un input.
3. Las dos secciones de formato **visibles a la vez**: `display: flex` pisa a `[hidden]`.
4. El texto siempre a **10 px**: un `return` prematuro en la bisección.
5. El GIF salía con **1 frame** en vez de 24: los controles de duración y FPS
   estaban dentro del tab de Video, así que en el tab de Imagen no había forma
   de animar nada. Lo detectó `ffprobe` al contar los frames reales.

Ese último no se iba a ver nunca con tests unitarios: la app cumplía, el
formulario se entera, y el archivo salía mal.

## Límites conocidos

- **H.264 exige dimensiones pares.** En video se redondean hacia arriba y la
  interfaz avisa. El nombre del archivo lleva las dimensiones reales.
- **El delay del GIF va en centésimas.** El FPS efectivo se cuantiza: 30 fps
  salen como 33,3. La interfaz muestra el número real.
- **Tope de 3600 frames** por exportación. Está explicado en el error, no se corta
  en silencio.
- **WebCodecs no está en Firefox Android.** Ahí el tab de video queda
  deshabilitado con un mensaje que lo dice; imagen y GIF funcionan igual.
- **WebMCP no funciona desde `file://`.** Exige aislamiento de origen y un
  documento local no lo tiene. Sirviendo la página por HTTP sí anda.
- `JPEG`, `MJPEG` y `JPEG` en ZIP no tienen canal alfa. El fondo siempre es opaco,
  así que no se nota.
- **Firefox y Safari** no reproducen ni AVI ni MKV. Se generan igual, para abrirlos
  en un editor.

## Licencia

MPL-2.0. La dependencia de Mediabunny también es MPL-2.0 y va embebida sin
modificar, con su aviso de licencia.
