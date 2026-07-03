/**
 * Детерминированный ГПСЧ полигона Бориса-Директа.
 *
 * ЖЕЛЕЗНОЕ ПРАВИЛО: вся случайность мира — ТОЛЬКО отсюда. Math.random()
 * и Date.now() в движке запрещены: один seed = байт-в-байт одинаковый прогон.
 *
 * Базовый генератор — mulberry32 (32-битный, быстрый, с хорошим распределением
 * для симуляций такого масштаба). Поверх него — хелперы распределений.
 */

/** Тип генератора: каждый вызов — равномерное число в [0, 1). */
export type Rng = () => number

/**
 * mulberry32 — классический seeded-ГПСЧ.
 * Возвращает функцию-генератор равномерных чисел [0, 1).
 * Одинаковый seed → одинаковая последовательность на любой платформе
 * (только целочисленные 32-битные операции + одно деление).
 */
export function mulberry32(seed: number): () => number {
  // Приводим seed к беззнаковому 32-битному (в т.ч. отрицательные/дробные)
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Целое из [min, max] ВКЛЮЧИТЕЛЬНО. При max < min возвращает min. */
export function randInt(rng: Rng, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return Math.floor(min)
  return Math.floor(rng() * (max - min + 1)) + Math.floor(min)
}

/** Вещественное из [min, max). При max < min возвращает min. */
export function randFloat(rng: Rng, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return min
  return min + rng() * (max - min)
}

/** Равновероятный выбор элемента массива. Пустой массив → undefined. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

/**
 * Приближённая нормальная величина N(0, 1) — сумма 12 равномерных минус 6
 * (распределение Ирвина–Холла). Без логарифмов/тригонометрии — детерминизм
 * не зависит от платформенных особенностей Math.log/cos.
 */
function normalApprox(rng: Rng): number {
  let s = 0
  for (let i = 0; i < 12; i++) s += rng()
  return s - 6
}

/**
 * Пуассон(lambda), приближённо:
 * - lambda < 30 — точный алгоритм Кнута (произведение равномерных);
 * - иначе — нормальная аппроксимация round(lambda + sqrt(lambda)·z), z~N(0,1).
 * Защита: lambda ≤ 0 или не число → 0.
 */
export function poissonApprox(rng: Rng, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0
  if (lambda < 30) {
    const limit = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k += 1
      p *= rng()
    } while (p > limit)
    return k - 1
  }
  const z = normalApprox(rng)
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z))
}

/**
 * Биномиальное(n, p), приближённо:
 * - n ≤ 64 — честная симуляция n испытаний (точное распределение);
 * - иначе — нормальная аппроксимация с клампом в [0, n].
 * Защита: n ≤ 0 → 0; p клампится в [0, 1]; NaN → 0.
 */
export function binomialApprox(rng: Rng, n: number, p: number): number {
  const trials = Math.floor(n)
  if (!Number.isFinite(trials) || trials <= 0) return 0
  const prob = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0
  if (prob === 0) return 0
  if (prob === 1) return trials
  if (trials <= 64) {
    let k = 0
    for (let i = 0; i < trials; i++) if (rng() < prob) k += 1
    return k
  }
  const mean = trials * prob
  const sd = Math.sqrt(trials * prob * (1 - prob))
  const value = Math.round(mean + sd * normalApprox(rng))
  return Math.min(trials, Math.max(0, value))
}
