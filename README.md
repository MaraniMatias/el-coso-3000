# El Coso 3000

Generador de placeholders de imagen y video que corre **100% en el navegador**.  
Sin servidor, sin subir nada, sin conexión. El resultado es **un solo archivo HTML** que se abre con doble clic.

```
dist/index.html         ← este es todo. Abrilo y usalo.
dist/placeholder.html   ← el mismo archivo, con nombre más fácil de compartir.
```

**Demo online:** [https://maranimatias.github.io/el-coso-3000/](https://maranimatias.github.io/el-coso-3000/)

---

## Qué hace

Genera placeholders listos para usar en:

- Wireframes y mockups
- Prototipos de UI
- Videos y animaciones de prueba
- Assets temporales en diseño o desarrollo

Todo se genera localmente. No se sube nada a ningún lado.

### Formatos disponibles

| Tipo | Formatos | Notas |
|------|----------|-------|
| Imagen | PNG · JPEG · WebP · SVG | PNG y WebP con transparencia. SVG incluye la fuente. |
| GIF animado | GIF | Loop infinito, paleta de 256 colores. |
| JPEG animado | AVI (Motion-JPEG) · ZIP de .jpg | Pensado para editores (Photoshop, etc.). |
| Video | MP4 · WebM · MOV · MKV | Se encodea con el motor del navegador. |

El texto del placeholder es **solo las dimensiones**. Nunca ocupa más del 60% del lado más corto. En animaciones y video también muestra barra de progreso y reloj (`0:03 / 0:10`).

### Colores con contraste garantizado

No son colores al azar. Hay 9 pares pre-medidos con contraste **WCAG AA** (≥ 4.5:1):

| Nombre | Fondo | Texto | Contraste |
|--------|-------|-------|-----------|
| gray | `#E5E7EB` | `#374151` | 8.33:1 |
| red | `#FEE2E2` | `#991B1B` | 6.80:1 |
| orange | `#FFEDD5` | `#9A3412` | 6.38:1 |
| yellow | `#FEF9C3` | `#854D0E` | 6.38:1 |
| green | `#DCFCE7` | `#166534` | 6.49:1 |
| teal | `#CCFBF1` | `#115E59` | 6.73:1 |
| blue | `#DBEAFE` | `#1E40AF` | 7.15:1 |
| violet | `#EDE9FE` | `#5B21B6` | 7.57:1 |
| rose | `#FCE7F3` | `#9D174D` | 6.71:1 |

Si elegís un color de fondo a mano, el texto se calcula automáticamente para mantener el contraste. El campo de texto es de solo lectura a propósito: no se puede romper la legibilidad por accidente.

Hay un botón **Random** que solo elige combinaciones ya verificadas.

### Nombres de archivo claros

Siempre empiezan con las dimensiones:

```
1920x1080.png
1920x1080-15fps.gif
1920x1080-30fps-10s.mp4
```

### Metadatos

Cada archivo generado incluye información de origen (Software, Comment, Source, Title) según el formato lo permita.

---

## Para quién es

**Diseñadores**  
Placeholders legibles, con buen contraste y fuente embebida. Sirven para mockups, wireframes y assets temporales que no se vean rotos.

**Developers**  
Imágenes y videos de prueba listos para pegar en prototipos, tests visuales o demos. Todo corre en el navegador, sin dependencias de servidor.

**Cualquiera**  
Abrís el HTML, elegís tamaño y formato, descargás. Listo.

---

## Límites conocidos

- H.264 necesita dimensiones pares → se redondean hacia arriba.
- GIF quantiza el delay (30 fps termina siendo ~33.3).
- Máximo 3600 frames por export.
- WebCodecs no está en Firefox Android → pestaña Video deshabilitada ahí.
- AVI y MKV no se reproducen en Firefox/Safari (se generan igual, para editores).
- JPEG / MJPEG / ZIP no tienen canal alpha.

---

## License

MPL-2.0
