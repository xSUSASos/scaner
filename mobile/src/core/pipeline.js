/**
 * Страница = рецепт обработки. Порт core/page.py.
 *
 * recipe = { corners, filter, rotation }
 *   corners  — нормированные TL,TR,BR,BL;
 *   filter   — см. defaultFilter();
 *   rotation — четверти оборота по часовой стрелке.
 * Результат всегда строится заново из исходника: превью — из уменьшенной копии,
 * экспорт — из полного снимка; правки не накапливают потерь.
 */
import { applyFilter, defaultFilter, rotate90 } from './filters.js';
import { fullFrameCorners, warpDocument } from './geometry.js';
import { withMats } from './mats.js';

export function defaultRecipe(corners = fullFrameCorners()) {
  return { corners, filter: defaultFilter(), rotation: 0 };
}

/** Конвейер: перспектива -> фильтр (+яркость/контраст) -> поворот. Новый Mat. */
export function render(cv, image, recipe) {
  return withMats((t) => {
    const warped = t.add(warpDocument(cv, image, recipe.corners));
    const filtered = t.add(applyFilter(cv, warped, recipe.filter));
    return rotate90(cv, filtered, recipe.rotation);
  });
}
