# El Coso 3000

Image and video placeholder generator that runs **entirely in the browser**.  
No server, no connection, nothing uploaded. The result is **a single HTML file** you can open with a double-click.


**Demo:** [https://maranimatias.github.io/el-coso-3000/](https://maranimatias.github.io/el-coso-3000/)

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

If you pick a custom background color, the text color is computed automatically to keep contrast. The text field is read-only on purpose.

A **Random** button only picks already verified combinations.

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
