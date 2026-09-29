/**
 * Cuantización de color por corte de la mediana (median cut).
 *
 * Existe una sola paleta para todo el GIF, y esa es la decisión de diseño que
 * más se nota al mirar el resultado: si cada frame se cuantiza por separado la
 * paleta parpadea de un frame al otro aunque el dibujo apenas cambie, y eso se
 * ve mucho peor que cualquier banding de color. Con una paleta global el
 * índice de un píxel significa lo mismo en todos los frames, así que el
 * movimiento es puro.
 *
 * El otro motivo es de costo: indexar contra una paleta fija es una tabla de
 * búsqueda, mientras que cuantizar por frame es un árbol de decisión o una
 * búsqueda lineal por píxel, multiplicado por todos los frames.
 */

export interface Palette {
  /** Tripletas RGB pegadas, 3 bytes por color, en el orden en que las usa la GCT. */
  rgb: Uint8Array;
  /** Colores reales. Puede ser menor que el tamaño de la tabla que los contiene. */
  size: number;
}

/** Un color único de la entrada y cuántas veces aparece. */
interface Bucket {
  packed: number;
  count: number;
}

/** Un grupo de colores que la paleta va a representar con un único promedio. */
interface Box {
  items: Bucket[];
  /** Píxeles que representa la caja: define su peso al elegir cuál partir. */
  pixels: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

/** El canal 0 es el canal de la mediana, 1 el de la media, 2 el de la moda. */
function channelOf(packed: number, channel: 0 | 1 | 2): number {
  if (channel === 0) return (packed >> 16) & 0xff;
  if (channel === 1) return (packed >> 8) & 0xff;
  return packed & 0xff;
}

function makeBox(items: Bucket[]): Box {
  const box: Box = { items, pixels: 0, rMin: 255, rMax: 0, gMin: 255, gMax: 0, bMin: 255, bMax: 0 };
  for (const item of items) {
    const r = channelOf(item.packed, 0);
    const g = channelOf(item.packed, 1);
    const b = channelOf(item.packed, 2);
    box.pixels += item.count;
    if (r < box.rMin) box.rMin = r;
    if (r > box.rMax) box.rMax = r;
    if (g < box.gMin) box.gMin = g;
    if (g > box.gMax) box.gMax = g;
    if (b < box.bMin) box.bMin = b;
    if (b > box.bMax) box.bMax = b;
  }
  return box;
}

/** Largo del lado más largo de la caja. Si es 0, todos sus colores son iguales. */
function longestSide(box: Box): number {
  return Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
}

/**
 * Parte la caja en dos por el canal más largo, cortando en la mediana ponderada
 * por cantidad de píxeles. Pesar importa: partir el canal más largo a la mitad
 * geométrica deja una caja con el 90% de los píxeles de la original y la
 * cuantización queda igual de mala.
 */
function splitBox(box: Box): [Box, Box] {
  const rSide = box.rMax - box.rMin;
  const gSide = box.gMax - box.gMin;
  const bSide = box.bMax - box.bMin;
  const channel: 0 | 1 | 2 = rSide >= gSide && rSide >= bSide ? 0 : gSide >= bSide ? 1 : 2;

  // El desempate por `packed` es lo que hace la paleta determinista: dos
  // colores con el mismo valor de canal podrían ordenarse de cualquier manera.
  const sorted = box.items;
  sorted.sort((a, b) => channelOf(a.packed, channel) - channelOf(b.packed, channel) || a.packed - b.packed);

  const half = box.pixels / 2;
  let acc = 0;
  // `cut` queda siempre en [1, length-1]: las dos mitades tienen que tener al
  // menos un color o el corte no avanzaría nunca.
  let cut = 1;
  while (cut < sorted.length - 1 && acc + sorted[cut]!.count < half) {
    acc += sorted[cut]!.count;
    cut++;
  }

  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

/** El color de la paleta es el promedio de los que representa, pesado por píxeles. */
function averageColor(items: Bucket[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const item of items) {
    r += channelOf(item.packed, 0) * item.count;
    g += channelOf(item.packed, 1) * item.count;
    b += channelOf(item.packed, 2) * item.count;
    total += item.count;
  }
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

/**
 * Construye una paleta de a lo sumo `maxColors` colores a partir de muestras RGB
 * empaquetadas de a 3 bytes (`RRGGBB` por tripleta).
 *
 * El corte es determinista: la misma entrada devuelve siempre la misma paleta.
 */
export function buildPalette(samples: Uint8Array, maxColors = 256): Palette {
  const limit = Math.max(1, Math.min(256, Math.floor(maxColors)));

  // Histograma de colores únicos. Recorrer la entrada píxel a píxel y partir
  // cajas de píxeles sueltos daría el mismo resultado, pero lentísimo: con
  // 65536 muestras y unos pocos colores, recortar de antemano a colores únicos
  // y trabajar con su peso es la diferencia entre milisegundos y segundos.
  const hist = new Map<number, number>();
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const packed = (samples[i]! << 16) | (samples[i + 1]! << 8) | samples[i + 2]!;
    hist.set(packed, (hist.get(packed) ?? 0) + 1);
  }
  if (hist.size === 0) return { rgb: new Uint8Array([0, 0, 0]), size: 1 };

  const items: Bucket[] = [];
  for (const [packed, count] of hist) items.push({ packed, count });

  const boxes: Box[] = [makeBox(items)];
  while (boxes.length < limit) {
    let pick = -1;
    let heaviest = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.items.length < 2) continue;
      // Partir siempre la caja más pesada es lo que reparte bien el error: una
      // caja de dos colores casi idénticos pesa menos que una de dos colores
      // muy distintos, y es justo la primera la que no necesita partirse.
      const weight = box.pixels * longestSide(box);
      if (weight > heaviest) {
        heaviest = weight;
        pick = i;
      }
    }
    if (pick < 0) break; // no queda ninguna caja que se pueda partir más
    const [left, right] = splitBox(boxes[pick]!);
    boxes.splice(pick, 1, left, right);
  }

  const rgb = new Uint8Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const [r, g, b] = averageColor(boxes[i]!.items);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { rgb, size: boxes.length };
}

/**
 * Devuelve una función que mapea un color empaquetado (`RRGGBB` en un entero de
 * 24 bits) al índice más cercano de la paleta.
 *
 * Los resultados se cachean por color: el placeholder tiene tres o cuatro
 * colores así que la búsqueda lineal corre una vez por color y el resto de los
 * millones de píxeles es una consulta a un mapa. El antialiasing del texto
 * mete algunos colores intermedios más, pero siguen siendo pocos y se
 * repiten frame a frame.
 */
export function createPaletteMapper(palette: Palette): (rgb: number) => number {
  const { rgb, size } = palette;
  const cache = new Map<number, number>();

  return (packed: number): number => {
    const hit = cache.get(packed);
    if (hit !== undefined) return hit;

    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const dr = channelOf(packed, 0) - rgb[i * 3]!;
      const dg = channelOf(packed, 1) - rgb[i * 3 + 1]!;
      const db = channelOf(packed, 2) - rgb[i * 3 + 2]!;
      // Distancia al cuadrado: la raíz no cambia el orden y multiplicar por
      // tres es lo que más cara sale en un bucle que corre por píxel.
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
        if (dist === 0) break; // no puede acercarse más que el color exacto
      }
    }

    cache.set(packed, bestIndex);
    return bestIndex;
  };
}
