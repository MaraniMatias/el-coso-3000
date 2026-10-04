# El Coso 3000

Image and video placeholder generator that runs **entirely in the browser**.  
No server, no connection, nothing uploaded. The result is **a single HTML file** you can open with a double-click.


**Demo:** [https://el-coso-3000.maranimatias.workers.dev/](https://el-coso-3000.maranimatias.workers.dev/)

---

## What it does

Generates ready-to-use placeholders for wireframes, mockups, prototypes, and temporary assets.

| Kind | Formats | Notes |
|------|---------|-------|
| Image | PNG · JPEG · WebP · SVG | Optional transparent background in PNG, WebP and SVG. SVG embeds the font. |
| Animated GIF | GIF | Infinite loop, global 256-color palette, binary transparency. |
| Animated JPEG | AVI (Motion-JPEG) · ZIP of `.jpg` | Meant for editors (Photoshop, etc.). |
| Video | MP4 · WebM · MOV · MKV | Encoded with the browser engine; optional synthesized tango, beep, tone, or noise soundtrack. |

Placeholder text is **only the dimensions**: always on a single line, scaled as large as fits within 70% of the width and 60% of the height of the image. Animated and video outputs also include a progress bar and clock (`0:03 / 0:10`).

### Colors with guaranteed contrast

Not random. Nine pre-measured pairs with **WCAG AA** contrast (≥ 4.5:1):

| Name | Background | Text | Contrast |
|------|------------|------|----------|
| gray | `#E5E7EB` | `#374151` | 8.33:1 |
| red | `#FEE2E2` | `#991B1B` | 6.80:1 |
| orange | `#FFEDD5` | `#9A3412` | 6.38:1 |
| yellow | `#FEF9C3` | `#854D0E` | 6.38:1 |
| green | `#DCFCE7` | `#166534` | 6.49:1 |
| teal | `#CCFBF1` | `#115E59` | 6.73:1 |
| blue | `#DBEAFE` | `#1E40AF` | 7.15:1 |
| violet | `#EDE9FE` | `#5B21B6` | 7.57:1 |
| rose | `#FCE7F3` | `#9D174D` | 6.71:1 |

Pick one of the nine swatches, or the last one to bring up the color picker for a color of your own: the text color is then computed from it to keep the contrast, and it is never edited by hand.

### Textured backgrounds

The background can also be one of four animated textures, drawn with the two colors you picked:

| Texture | What it is |
|---------|------------|
| Bokeh + grain | Blurred spheres over soft blobs, with film grain. The default for video. |
| Fog | Huge very slow blobs, with heavier film grain. The default for images. |
| Center focus | A clean light center with a vignette in the text color. |
| Rise | Blurred spheres that come up from the bottom and fade out. |

They are painted on the canvas, so they are baked into the file: PNG, JPEG, WebP, GIF, the JPEG sequences and every video container all carry the animation. **SVG stays flat** — it is written as text, and it says so instead of pretending.

The last swatch of the color row opens the color picker and then shows whatever color came out of it, so a color of your own is one click from the palette. Until you pick one it offers a measured pair with the palette icon on it.

On a video you can pick how fast they move: **1× to 3×**, 2× by default, as a multiple of the timing in the [`docs/`](docs/) demo they come from. Unchecking **Texture movement** holds the first frame for the whole clip — a texture that is painted and never moves, which is a speed of 0. The control only appears when there is something to move: an animated texture, on a format with more than one frame. A still image is the same picture at any speed.

Two consequences worth knowing: the loop of a video is not seamless, and the grain is expensive for a still compressor, so a textured PNG is much larger than a flat one.

### File names

Always start with the dimensions:

```
1920x1080.png
1920x1080-15fps.gif
1920x1080-30fps-10s.mp4
```

Every generated file records where it came from. What each format can carry differs, because the containers differ:

| Format | Metadata |
| --- | --- |
| PNG | Standard keywords (`Software`, `Title`, `Author`, `Copyright`, `Source`, `Creation Time`), the app's own data behind an `ElCoso3000:` prefix (dimensions, palette, colors, WCAG contrast, drawn text), and an XMP packet. |
| JPEG | A readable comment block plus an XMP packet in `APP1`. |
| WebP | An XMP packet. |
| SVG | An escaped `<metadata>` block. |
| GIF | The block in the comment extension. |
| Motion JPEG AVI | Standard `INFO` tags, plus the full block in `ICMT`. |
| JPEG sequence ZIP | The block in the ZIP comment and a `metadata.json` inside. |
| MP4, WebM, MOV, MKV | The block in the container comment field, plus `Software` and `Source` where the container has room for them. |

The app's own keywords are prefixed so tools group them instead of listing them as unknown tags, and the XMP packet uses a private namespace for them. `exiftool` reads both layers of a PNG and reports no warnings.

---

## Who it's for

**Designers**  
Readable placeholders with solid contrast and an embedded font. Good for mockups, wireframes, and temporary assets that shouldn't look broken.

**Developers**  
Test images and videos ready for prototypes, visual tests, or demos. Everything runs in the browser, no server required.

**Anyone**  
Open the HTML, pick size and format, download.

---

## How to use

1. Download `dist/placeholder.html` (or open the [online demo](https://maranimatias.github.io/el-coso-3000/)).
2. Open it in a browser (double-click is enough).
3. Choose size, format, and color.
4. Download the generated file.

> [!NOTE]
> Everything is generated locally. Nothing is uploaded anywhere.

---

## Known limits

- H.264 requires even dimensions → they are rounded up.
- GIF delay is quantized (30 fps ends up as ~33.3).
- Maximum 3600 frames per export.
- WebCodecs is missing in Firefox Android → Video tab is disabled there.
- AVI and MKV do not play in Firefox/Safari (they are still generated for editors).
- JPEG / MJPEG / ZIP and the video containers have no alpha channel. Transparency is available in PNG, WebP, SVG and GIF (binary transparency); with transparent backgrounds, visible text contrast depends on the background beneath the file.
- Sound is optional and only available in MP4, WebM, MOV and MKV. Audio encoding support depends on the browser.
