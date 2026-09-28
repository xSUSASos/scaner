"""Автоматический поиск документа на фото.

Идея: несколько стратегий предлагают КАНДИДАТОВ-четырёхугольников, а потом
каждый кандидат получает оценку, и побеждает лучший (а не просто самый большой):

  Стратегии (все — на уменьшенной копии, grayscale -> blur):
    1. Canny -> закрытие разрывов -> контуры -> approxPolyDP (классика; хороша,
       когда контур листа замкнут).
    2. Порог Оцу -> контуры (светлый лист на тёмном фоне с размытыми краями).
    3. Прямые Хафа по карте краёв -> пары «верх/низ» × «лево/право» -> углы как
       пересечения. Работает, даже если контур листа разорван (угол листа закрыт
       посторонним предметом, лист уходит за край кадра).

  Оценка кандидата = опора × контраст × площадь^0.25:
    - опора — доля периметра, лежащая на краях Canny (стороны должны быть реальными краями);
    - контраст — насколько различается цвет по разные стороны каждой стороны
      (у края листа: бумага | фон; у строки текста внутри листа: бумага | бумага);
    - площадь — при прочих равных предпочитаем весь лист, а не таблицу на нём.

Если ни один кандидат не набрал min_score — рамка по краям изображения.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import full_frame_corners, order_points, to_normalized


@dataclass(frozen=True)
class DetectParams:
    # Детекция на копии с длинной стороной work_side: быстро и параметры ниже
    # не зависят от разрешения исходника (5 Мп и 50 Мп ведут себя одинаково).
    work_side: int = 800
    # Размытие гасит текст, клетку и шум бумаги, чтобы Canny видел только крупные края.
    blur_ksize: int = 5
    # Пороги Canny считаются от медианы яркости: low=(1-sigma)*m, high=(1+sigma)*m.
    # Больше sigma — шире диапазон, больше краёв (и мусора).
    canny_sigma: float = 0.33
    # Морфологическое закрытие склеивает разрывы в контуре листа (стратегия 1).
    close_ksize: int = 5
    # Точность аппроксимации в долях периметра; перебираем, пока не получим 4 вершины.
    approx_eps: tuple[float, ...] = (0.02, 0.03, 0.04, 0.05)
    # Документ должен занимать хотя бы такую долю кадра, иначе это не лист, а мусор.
    min_area_ratio: float = 0.15
    # Сколько самых крупных контуров проверять.
    max_candidates: int = 10
    # Хаф: сколько сильнейших прямых брать в каждой группе (горизонтальные/вертикальные).
    hough_lines_per_group: int = 8
    # Сколько лучших по «опоре» кандидатов проверять на контраст (контраст дороже).
    max_scored: int = 25
    # Минимальная оценка, ниже которой считаем, что документа нет.
    min_score: float = 0.35


@dataclass(frozen=True)
class DetectResult:
    corners: np.ndarray  # (4, 2) нормированные, порядок TL, TR, BR, BL
    found: bool          # False — вернули рамку по краям


def detect_document(img: np.ndarray, params: DetectParams = DetectParams(),
                    debug: dict | None = None) -> DetectResult:
    """debug — если передан словарь, в него кладутся промежуточные картинки и оценки (для CLI)."""
    small = _downscale(img, params.work_side)
    color = small if small.ndim == 3 else cv2.cvtColor(small, cv2.COLOR_GRAY2BGR)
    gray = cv2.GaussianBlur(cv2.cvtColor(color, cv2.COLOR_BGR2GRAY),
                            (params.blur_ksize, params.blur_ksize), 0)
    raw_edges = _canny(gray, params.canny_sigma)
    scorer = _Scorer(raw_edges, color)

    closed = _close(raw_edges, params.close_ksize)
    otsu = _otsu_mask(gray, params)
    candidates = ([("canny", q) for q in _contour_quads(closed, params)]
                  + [("otsu", q) for q in _contour_quads(otsu, params)]
                  + [("hough", q) for q in _hough_quads(raw_edges, params)])

    # Оценка в два прохода: дешёвая «опора» — для всех кандидатов (у Хафа их сотни),
    # дорогой контраст — только для лучших.
    h, w = gray.shape
    rated = []
    for name, quad in candidates:
        quad = order_points(quad)
        area = cv2.contourArea(quad.astype(np.float32)) / (h * w)
        if area >= params.min_area_ratio:
            rated.append((scorer.support(quad) * area ** 0.25, name, quad))
    rated.sort(key=lambda r: r[0], reverse=True)

    best_name, best_quad, best_score = None, None, 0.0
    for prelim, name, quad in rated[:params.max_scored]:
        score = prelim * scorer.contrast(quad)
        if score > best_score:
            best_name, best_quad, best_score = name, quad, score

    if debug is not None:
        debug["edges_canny"] = closed
        debug["edges_otsu"] = otsu
        debug["candidates"] = len(candidates)
        debug["strategy"] = best_name
        debug["score"] = round(best_score, 3)

    if best_quad is None or best_score < params.min_score:
        return DetectResult(full_frame_corners(), False)
    corners = np.clip(to_normalized(best_quad, gray.shape), 0.0, 1.0)
    return DetectResult(order_points(corners), True)


# ----------------------------- подготовка -----------------------------

def _downscale(img: np.ndarray, side: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = side / max(h, w)
    if scale >= 1.0:
        return img
    return cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def _canny(gray: np.ndarray, sigma: float) -> np.ndarray:
    median = float(np.median(gray))
    low = int(max(0, (1.0 - sigma) * median))
    high = int(min(255, (1.0 + sigma) * median))
    return cv2.Canny(gray, low, high)


def _close(edges: np.ndarray, ksize: int) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (ksize, ksize))
    return cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)


def _otsu_mask(gray: np.ndarray, p: DetectParams) -> np.ndarray:
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (p.close_ksize * 3, p.close_ksize * 3))
    # Открытие убирает мелкие светлые пятна фона, закрытие — тёмный текст внутри листа.
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)


# ----------------------------- кандидаты -----------------------------

def _contour_quads(binary: np.ndarray, p: DetectParams) -> list[np.ndarray]:
    """4-угольники из крупных контуров (стратегии 1 и 2)."""
    h, w = binary.shape[:2]
    min_area = p.min_area_ratio * h * w
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:p.max_candidates]
    quads = []
    for contour in contours:
        # Выпуклая оболочка сглаживает «вмятины» (палец на листе, загнутый угол).
        hull = cv2.convexHull(contour)
        if cv2.contourArea(hull) < min_area:
            continue
        perimeter = cv2.arcLength(hull, True)
        for eps in p.approx_eps:
            approx = cv2.approxPolyDP(hull, eps * perimeter, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                quads.append(approx.reshape(4, 2).astype(np.float64))
                break
        else:
            # approxPolyDP не свёл к 4 вершинам (скруглённые углы, лист за краем кадра):
            # упрощаем оболочку сами.
            quads.append(_reduce_to_quad(hull.reshape(-1, 2).astype(np.float64)))
    return quads


def _reduce_to_quad(pts: np.ndarray) -> np.ndarray:
    """Упростить выпуклый многоугольник до 4 вершин (алгоритм Висвалингам):
    каждый раз убираем вершину, образующую с соседями треугольник наименьшей площади."""
    pts = list(pts)
    while len(pts) > 4:
        areas = []
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            u, v = b - a, c - a
            areas.append(abs(u[0] * v[1] - u[1] * v[0]))
        pts.pop(int(np.argmin(areas)))
    return np.array(pts)


def _hough_quads(edges: np.ndarray, p: DetectParams) -> list[np.ndarray]:
    """Стратегия 3: четырёхугольники из пересечений сильнейших прямых."""
    h, w = edges.shape[:2]
    lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=int(0.15 * min(h, w)))
    if lines is None:
        return []

    # Нормализуем (rho, theta) так, чтобы rho >= 0: тогда почти вертикальные прямые
    # с theta ≈ 0 и theta ≈ π получают близкие параметры и правильно сравниваются.
    kept: list[tuple[float, float]] = []
    for rho, theta in lines[:400, 0]:
        if rho < 0:
            rho, theta = -rho, theta - np.pi
        # HoughLines отдаёт прямые по убыванию числа голосов — оставляем сильнейшую
        # из близких (подавление немаксимумов).
        if all(abs(rho - r) > 15 or abs(theta - t) > np.radians(8) for r, t in kept):
            kept.append((float(rho), float(theta)))

    k = p.hough_lines_per_group
    horizontal = [l for l in kept if abs(l[1] - np.pi / 2) < np.radians(35)][:k]
    vertical = [l for l in kept if abs(l[1]) < np.radians(35)][:k]

    # Пересечения считаем один раз на пару прямых (их k*k), а не на каждый 4-угольник.
    cross = {(i, j): _intersect(hl, vl)
             for i, hl in enumerate(horizontal) for j, vl in enumerate(vertical)}
    quads = []
    margin_x, margin_y = 0.05 * w, 0.05 * h
    for top, bottom in itertools.combinations(range(len(horizontal)), 2):
        for left, right in itertools.combinations(range(len(vertical)), 2):
            pts = [cross[top, left], cross[top, right], cross[bottom, right], cross[bottom, left]]
            if any(pt is None for pt in pts):
                continue
            quad = order_points(np.array(pts))
            # Углы — в кадре (с небольшим запасом: лист может чуть выходить за край).
            if ((quad[:, 0] < -margin_x) | (quad[:, 0] > w + margin_x)
                    | (quad[:, 1] < -margin_y) | (quad[:, 1] > h + margin_y)).any():
                continue
            if cv2.isContourConvex(quad.astype(np.float32).reshape(-1, 1, 2)):
                quads.append(quad)
    return quads


def _intersect(l1: tuple[float, float], l2: tuple[float, float]) -> np.ndarray | None:
    """Точка пересечения прямых x·cosθ + y·sinθ = ρ."""
    (r1, t1), (r2, t2) = l1, l2
    a = np.array([[np.cos(t1), np.sin(t1)], [np.cos(t2), np.sin(t2)]])
    if abs(np.linalg.det(a)) < 1e-6:
        return None
    return np.linalg.solve(a, [r1, r2])


# ----------------------------- оценка -----------------------------

class _Scorer:
    """Оценка кандидата: опора на края × контраст сторон (× площадь^0.25 — в detect_document)."""

    def __init__(self, edges: np.ndarray, color: np.ndarray):
        self.h, self.w = edges.shape[:2]
        # Расширяем края на пару пикселей: сторона кандидата может пройти рядом с краем.
        self.edge_map = cv2.dilate(edges, np.ones((5, 5), np.uint8)) > 0
        # Lab: евклидово расстояние в нём близко к воспринимаемой разнице цветов.
        self.lab = cv2.cvtColor(cv2.GaussianBlur(color, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
        # Полосы по обе стороны стороны: отступы от ~0.5% до ~5% размера кадра.
        # Широкая полоса захватывает несколько строк текста, а не одну.
        step = max(2.0, 0.008 * max(self.h, self.w))
        self.offsets = step * np.arange(1, 7)

    @staticmethod
    def _sides(quad: np.ndarray):
        """Точки вдоль каждой стороны (без 5% у углов — там края соседних сторон)."""
        for i in range(4):
            a, b = quad[i], quad[(i + 1) % 4]
            n = max(int(np.linalg.norm(b - a) / 2), 8)
            yield a, b, a + (b - a) * np.linspace(0.05, 0.95, n)[:, None]

    def support(self, quad: np.ndarray) -> float:
        """Средняя доля точек сторон, лежащих на краях Canny."""
        return float(np.mean([self._side_support(pts) for _, _, pts in self._sides(quad)]))

    def contrast(self, quad: np.ndarray) -> float:
        """Геометрическое среднее контраста сторон: одна «фальшивая» сторона
        (например, строка текста внутри листа) сильно роняет оценку."""
        center = quad.mean(axis=0)
        values = [self._side_contrast(pts, a, b, center) for a, b, pts in self._sides(quad)]
        return float(np.prod(np.maximum(values, 0.05)) ** 0.25)

    def _inside(self, pts: np.ndarray) -> np.ndarray:
        return ((pts[:, 0] >= 0) & (pts[:, 0] <= self.w - 1)
                & (pts[:, 1] >= 0) & (pts[:, 1] <= self.h - 1))

    def _clip(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        p = pts.round().astype(int)
        return p[:, 0].clip(0, self.w - 1), p[:, 1].clip(0, self.h - 1)

    def _side_support(self, pts: np.ndarray) -> float:
        """Сторона вдоль края кадра — «половинная» опора: лист мог уйти за кадр,
        но и рамка по краям не должна выигрывать даром."""
        x, y = self._clip(pts)
        on = self.edge_map[y, x].astype(np.float64)
        at_border = (x <= 2) | (x >= self.w - 3) | (y <= 2) | (y >= self.h - 3)
        on[at_border & (on == 0)] = 0.5
        on[~self._inside(pts)] = 0.0
        return float(on.mean())

    def _band_color(self, pts: np.ndarray) -> np.ndarray:
        """«Цвет фона» полосы: яркость — 80-й перцентиль (бумага без чернил текста),
        цветность — медиана."""
        x, y = self._clip(pts)
        lab = self.lab[y, x]
        return np.array([np.percentile(lab[:, 0], 80), np.median(lab[:, 1]), np.median(lab[:, 2])])

    def _side_contrast(self, pts, a, b, center) -> float:
        """Разница «цвета фона» (ΔE в Lab) в полосах внутри и снаружи стороны,
        нормированная к [0, 1]: ΔE ≈ 30 — уже явная граница бумага/фон."""
        direction = (b - a) / (np.linalg.norm(b - a) + 1e-9)
        normal = np.array([-direction[1], direction[0]])
        if np.dot(normal, center - (a + b) / 2) > 0:  # нормаль должна смотреть наружу
            normal = -normal
        outer = np.vstack([pts + normal * d for d in self.offsets])
        inner = np.vstack([pts - normal * d for d in self.offsets])
        visible = self._inside(outer)
        if visible.mean() < 0.3:
            return 0.5  # сторона у края кадра: снаружи почти ничего не видно — нейтрально
        delta = np.linalg.norm(self._band_color(inner[visible]) - self._band_color(outer[visible]))
        return float(min(1.0, delta / 30.0))
