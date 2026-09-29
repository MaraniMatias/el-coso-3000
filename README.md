# El Coso 3000

**Image and video placeholder** generator that runs entirely in the browser.
No server, no connection, nothing uploaded anywhere. The result is **a single
HTML file** that opens with a double click.

```
dist/index.html         ← this is everything. Open it and use it.
dist/placeholder.html   ← the same file, with a file name you can share.
```

[Open the online demo](https://maranimatias.github.io/el-coso-3000/). It is
published automatically from `main`; WebMCP works on that version if the browser
supports it.

## What it generates

| Kind | Formats | Notes |
|---|---|---|
| Image | `PNG` · `JPEG` · `WebP` · `SVG` | PNG and WebP with transparency. SVG embeds the font, so it looks the same on any machine. |
| Animated GIF | `GIF` | Infinite loop. Global palette of 256 colors shared across frames, so it does not flicker. |
| Animated JPEG | `AVI` (Motion-JPEG) · `ZIP` of `.jpg` | No browser plays AVI: it goes to an editor or to Photoshop. |
| Video | `MP4` · `WebM` · `MOV` · `MKV` | Encodes with the browser engine, no real-time waiting. |

Everything with a timeline lives in the **Video** tab: the four containers plus
the GIF, the AVI and the ZIP, because the duration and the frames per second
apply to all of them.

The text of the placeholder is **only the dimensions**, never more than 60% of
the shortest side, so the block always reads as a placeholder instead of filling
the image. On a timeline output it also carries a progress bar and the
`0:03 / 0:10` clock at the bottom.

## The color is not random

It is what most differentiates this from other tools. Instead of throwing two
loose colors and praying that it reads, the palette is a **fixed set of pairs,
each one measured before it shipped**. `bun run check:palette` runs the
**WCAG 2.1** formula on every swatch and fails if one lands below 4.5:1.

If you type a background color by hand, the text is computed instead of taken
from the table: same hue, saturation lowered, and lightness moved by binary
search until it reaches 4.5:1. The search converges on the **softest tone that
still complies**: a light red carries a darker red, not a hard black.

The result always passes AA, and the interface shows the number:

```
Contrast   5.97:1   [AA]  meets WCAG AA
```

If you touch the background color by hand, the text is recomputed. The field is
**readonly** on purpose: legibility is not something that can be ruined by
accident. There is a "Random" button that picks among already verified
combinations, never loose colors.

The whole page takes the hue of the chosen color: when the palette changes, the
interface re-tints with it, in light and in dark. It starts on a random palette,
so every visit opens with a different color.

### The palette

Six swatches: a soft background and a dark text of the same family. The name is
what ends up in the file name and in the metadata of the image.

| Swatch | Name | Background | Text |
| --- | --- | --- | --- |
| Gray | `gray` | `#E5E7EB` | `#374151` |
| Blue | `blue` | `#DBEAFE` | `#1E40AF` |
| Green | `green` | `#D1FAE5` | `#065F46` |
| Yellow | `yellow` | `#FEF3C7` | `#92400E` |
| Rose | `rose` | `#FCE7F3` | `#9D174D` |
| Violet | `violet` | `#EDE9FE` | `#5B21B6` |

## Metadata inside the files

Every generated file carries metadata saying where it came from:

```
Software : El Coso 3000
Comment  : El Coso 3000
Source   : <repo URL>
Title    : Placeholder 1920x1080
```

How it is written depends on the container, because every format has its own
shape:

| Format | Mechanism |
|---|---|
| PNG | `tEXt` chunks injected before the `IEND` |
| JPEG | `COM` segment injected after the `SOI` |
| WebP | `XMP ` chunk of the RIFF container, with a valid XMP |
| SVG | RDF `<metadata>` block |
| GIF | `0x21 0xFE` Comment Extension block |
| AVI | `ISBJ` chunk of the RIFF `INFO` |
| ZIP | `metadata.json` inside + EOCD comment |
| MP4 · MOV | `udta`/`meta` through Mediabunny |
| MKV | Matroska `Tags` element |
| **WebM** | trimmed: Matroska over WebM only supports a small subset of tags |

The last two rows are limits of the format, not of the code.

## The HTML also carries metadata

`<meta name="generator">`, `description`, `author`, `canonical`, Open Graph and
Twitter card, pointing at the repo.

## WebMCP

The page exposes itself as a tool for AI agents with
[WebMCP](https://github.com/webmachinelearning/webmcp), through both APIs:

- **Declarative**: the controls form carries `toolname`, `tooldescription` and
  `toolparamdescription` on every field. The browser turns it into a tool.
- **Imperative**: `document.modelContext.registerTool` exposes
  `generate_placeholder` with a JSON Schema that accepts `width`, `height`,
  `kind`, the formats, `palette`, `background`, `duration`, `fps` and the bar
  options.

The text color is **never** asked of the agent: it is derived from the
background, exactly as it is for a person.

It is progressive enhancement. WebMCP is in origin trial (Chrome 149+) and sits
behind feature detection: if the browser does not support it, nothing happens
and the app keeps working.

## File names

The dimensions go first, which is the first thing anyone wants to know:

```
1920x1080.png
1920x1080-15fps.gif
1920x1080-30fps-10s.mp4
1920x1080-30fps-10s.avi
```

For the GIF, if the real FPS differs from the requested one, the real one goes
in, not the theoretical one.

## Publishing on GitHub Pages

`dist/` holds `index.html` (the site entry point) and `placeholder.html` (the
same file, with a name to share or open locally). The
`.github/workflows/pages.yml` workflow builds the HTML and publishes `dist/` to
GitHub Pages on every push to `main`. To enable it, in **Settings → Pages →
Build and deployment → Source** choose **GitHub Actions**. The demo lives at
`https://maranimatias.github.io/el-coso-3000/`.

That is why `dist` is **not** in the `.gitignore`: it holds the self-contained
HTML that can be opened directly and that the workflow publishes.

> When it is served over HTTP, the WebMCP part **does** activate if the browser
> meets the requirements, because there is origin isolation. With a double
> click (`file://`) it does not, but the rest of the app works the same in both
> cases.

## Taking it apart and putting it back together

You need [Bun](https://bun.com). Node also works for the tests, but the bundler
is Bun's.

```bash
bun install
bun run build              # builds dist/placeholder.html
bun test                   # unit tests (119)
bun run check:core         # palette, auto-fit and image
bun run verify:browser     # the real HTML in a headless Chrome
bun run types              # tsc --noEmit
bun run fetch:font         # downloads the typeface again
```

`bun run build` also **audits the result**: it fails if the generated HTML
references any remote resource. If that happens, the file stopped being
self-contained and it is better that it breaks in the build than in production.

### What each test layer covers

Bun's tests have no DOM and no canvas, so they cover the byte-level logic with
synthetic inputs: CRC32, LZW, GIF/ZIP/AVI structure, the codec table, the frame
computation, the integrity of the encoding loop.

That does **not** say that the render works. That is what `verify:browser` is
for: it opens the built HTML in a headless Chrome through the DevTools Protocol,
measures the real canvas, exercises the interface and **downloads the real
files** to check their signature and their content. The GIF and AVI encoders
were also validated from the outside with `ffmpeg`, `ffprobe` and ImageMagick.

One detail that was hard to find: the LZW decoder of the test itself had a bug
(it resolved entries with `dict[code] !== undefined` instead of `code < nextCode`),
and it was being cancelled by a bug in the encoder. The roundtrip passed with a
broken encoder. The new tests in `test/gif.test.ts` exist precisely so that a
single error cannot go unnoticed.

### Layout

```
src/
  index.html        template; it holds the metadata and the WebMCP attributes
  styles.css        stylesheet, no framework
  main.ts           entry point
  core/
    types.ts        contracts. Spec is what every module talks
    color.ts        WCAG contrast, HSL and the palette
    fit-text.ts     font size auto-fit by bisection
    draw-frame.ts   the render. A single path for everything
    metadata.ts     the metadata, in a container-agnostic shape
    filename.ts     naming convention and MIME
    download.ts     saving, with streaming if the browser allows it
    font.ts         the embedded typeface
  encoders/
    image.ts        PNG, JPEG, WebP, SVG
    gif.ts          GIF89a + LZW + median-cut
    mjpeg.ts        AVI with Motion-JPEG, and ZIP
    video.ts        MP4, WebM, MOV, MKV
  ui/
    app.ts          the interface
    webmcp.ts       the tool for agents
test/                unit tests with bun test
scripts/            build, fetch-font, verify:browser and the checks
```

The important design point is that **`drawFrame` is the only place that draws**.
The live preview, the PNG, the GIF and the video all go through the same
function, so what you see on screen is literally what ends up in the file. The
SVG reuses the same layout math and its tests compare line by line against the
core, so the vector and the raster cannot diverge.

## Dependencies

One, and it is a runtime one: **[mediabunny](https://mediabunny.dev)**
(MPL-2.0), which acts as the muxer and talks to WebCodecs. No JS framework, no
CSS library, no cloud runtime.

The typeface is [Montserrat](https://fonts.google.com/specimen/Montserrat)
SemiBold, latin subset, embedded in base64 (SIL OFL 1.1).

> The GIF encoding and the AVI/ZIP one were written by hand, about 400 lines in
> total. ffmpeg.wasm could have been used, but it is 31 MB of wasm against
> Mediabunny's ~300 KB, and the ffmpeg core also needs `SharedArrayBuffer`,
> which requires HTTP headers that a local file cannot have. The GIF and the
> AVI also come out faster and take zero space.

### Why the video is not written to disk while it encodes

Mediabunny has `StreamTarget`, which sounds ideal to avoid keeping the file in
memory. **It cannot be used here.** The MP4/MOV muxer patches the `mdat` box
*backwards* at the end, rewriting bytes it had already written:

```
isobmff-muxer.js: patchBox(this.mdat)  ← with a seek backwards, at the end
```

Matroska does the same with the size of the `Segment`. An append-only target
—which is what `StreamTarget` offers— would accept the write and produce a
**corrupt MP4 without reporting any error**. That is why the video goes to
memory with `BufferTarget`. With the 4096 px and 3600 frame caps the buffer is
bounded and there is no risk.

## Verification

What is not tested does not exist. `verify:browser` opens the HTML **from
`file://`** — the same context people will use it in, which is not the same as
`http://localhost`: `file://` has an opaque origin and is not isolated.

Results there:

| Check | |
|---|---|
| Secure context, WebCodecs, `showSaveFilePicker` | available from `file://` |
| Console | no exceptions and no errors |
| Render | 1920×1080 canvas, correct pastel background, text drawn |
| Exporters | 11 really downloaded files, verified from the outside |
| **WebMCP** | **does not work from `file://`** |

The last one is a real and known limit: WebMCP requires origin isolation, and a
`file://` document does not have it. The app degrades silently, but if someone
wants to use the tool from an agent, they have to serve it over HTTP.

The files it generates are verified with external tools, which is the only way
to know whether they really work:

```
ffprobe   → h264 / vp9, 320x240, 6 fps, 1.0s, 6 frames
ffmpeg    → decodes the whole GIF without errors
ImageMagick → identify: format, dimensions, colors
unzip -t  → intact ZIP
```

### Bugs that only show up when you actually use it

Five of the eight that were found were not caught by any test:

1. The **black** canvas: `fillStyle` silently drops a hex without `#`.
2. The format selector **never changed**: it returns a `RadioNodeList`, not an
   input.
3. The two format sections **visible at the same time**: `display: flex`
   overrides `[hidden]`.
4. The text always at **10 px**: a premature `return` in the bisection.
5. The GIF came out with **1 frame** instead of 24: the duration and FPS
   controls were inside the Video tab, so in the Image tab there was no way to
   animate anything. `ffprobe` caught it by counting the real frames.

That last one would never have been caught by unit tests: the app was
complying, the form did not know, and the file came out wrong.

## Known limits

- **H.264 requires even dimensions.** On video they are rounded up and the
  interface says so. The file name carries the real dimensions.
- **The GIF delay goes in hundredths.** The effective FPS is quantized: 30 fps
  come out as 33.3. The interface shows the real number.
- **Cap of 3600 frames** per export. It is explained in the error, it is not cut
  silently.
- **WebCodecs is not in Firefox for Android.** There the video tab is disabled
  with a message that says so; image and GIF work the same.
- **WebMCP does not work from `file://`.** It requires origin isolation and a
  local document does not have it. Serving the page over HTTP does work.
- `JPEG`, `MJPEG` and `JPEG` in a ZIP have no alpha channel. The background is
  always opaque, so it does not show.
- **Firefox and Safari** play neither AVI nor MKV. They are generated anyway, to
  open them in an editor.

## License

MPL-2.0. The Mediabunny dependency is also MPL-2.0 and is embedded unmodified,
with its license notice.
