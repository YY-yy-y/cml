// ============================================================================
//  collage.js — построение мозаики из 15 фотографий на заставке ТВ.
//
//  Композиция задаётся вручную через grid-area (никакого masonry-скрипта):
//  плотная сетка 6×4 без пустот, 1.webp — крупный центр.
//  Возвращает промис, который резолвится, когда ВСЕ фото загружены (для прелоадера).
// ============================================================================

import { CONFIG } from './config.js';

// Ручная раскладка на сетке 6 колонок × 4 строки (colStart, rowStart, colSpan, rowSpan).
// Индекс массива = номер фото (1..15). Hero (1) занимает 2×2 в композиционном центре.
// Проверено: покрывает все 24 ячейки без дыр и пересечений.
const LAYOUT = {
  1:  { c: 3, r: 2, cs: 2, rs: 2 }, // HERO — центр, 2×2
  2:  { c: 1, r: 1, cs: 2, rs: 1 },
  3:  { c: 3, r: 1, cs: 1, rs: 1 },
  4:  { c: 4, r: 1, cs: 1, rs: 1 },
  5:  { c: 5, r: 1, cs: 2, rs: 1 },
  6:  { c: 1, r: 2, cs: 1, rs: 1 },
  7:  { c: 2, r: 2, cs: 1, rs: 1 },
  8:  { c: 5, r: 2, cs: 1, rs: 1 },
  9:  { c: 6, r: 2, cs: 1, rs: 1 },
  10: { c: 1, r: 3, cs: 1, rs: 1 },
  11: { c: 2, r: 3, cs: 1, rs: 1 },
  12: { c: 5, r: 3, cs: 1, rs: 1 },
  13: { c: 6, r: 3, cs: 1, rs: 1 },
  14: { c: 1, r: 4, cs: 3, rs: 1 },
  15: { c: 4, r: 4, cs: 3, rs: 1 },
};

// Разные направления/задержки Ken Burns, чтобы плитки оживали по-разному.
const KEN_VARIANTS = ['kb-a', 'kb-b', 'kb-c', 'kb-d'];

export function buildCollage(container) {
  const { count, heroIndex, path, ext } = CONFIG.collage;
  container.innerHTML = '';
  const loaders = [];

  for (let i = 1; i <= count; i++) {
    const spec = LAYOUT[i];
    if (!spec) continue;

    const tile = document.createElement('div');
    tile.className = 'tile' + (i === heroIndex ? ' tile--hero' : '');
    tile.style.gridColumn = `${spec.c} / span ${spec.cs}`;
    tile.style.gridRow = `${spec.r} / span ${spec.rs}`;
    // Каскадное появление: своя задержка на плитку.
    tile.style.setProperty('--enter-delay', `${(i - 1) * 50}ms`);

    const img = document.createElement('img');
    img.className = 'tile__img ' + KEN_VARIANTS[i % KEN_VARIANTS.length];
    img.style.setProperty('--kb-delay', `${(i * 1.7) % 12}s`);
    img.style.setProperty('--kb-dur', `${20 + (i % 4) * 4}s`);
    // Смещение кадрирования, чтобы не резать лица на широких плитках.
    const op = CONFIG.collage.objectPosition && CONFIG.collage.objectPosition[i];
    img.style.objectPosition = op || 'center';
    img.decoding = 'async';
    img.loading = 'eager';
    img.alt = '';
    img.src = `${path}${i}${ext}`;

    // Промис загрузки: резолвим и на ошибке, чтобы прелоадер не завис.
    loaders.push(new Promise((resolve) => {
      if (img.complete && img.naturalWidth) return resolve();
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    }));

    tile.appendChild(img);
    container.appendChild(tile);
  }

  return Promise.all(loaders);
}

// Запустить каскадное появление плиток (добавляет класс, CSS делает остальное).
export function revealCollage(container) {
  requestAnimationFrame(() => {
    container.classList.add('is-revealed');
  });
}
