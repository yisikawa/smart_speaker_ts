/**
 * 音量列（20ms スライスの 0..1）から、その時点の口の開きを求める。
 * `previous` を渡すと前回値から `smoothing`（0..1）で追従する。
 */
export function mouthLevelAt(
  volumes: number[],
  sliceMs: number,
  elapsedMs: number,
  options: { previous?: number; smoothing?: number } = {}
): number {
  const target = sample(volumes, sliceMs, elapsedMs);
  const previous = clamp01(options.previous ?? target);
  const smoothing = clamp01(options.smoothing ?? 1);
  return clamp01(previous + (target - previous) * smoothing);
}

function sample(volumes: number[], sliceMs: number, elapsedMs: number): number {
  if (volumes.length === 0 || sliceMs <= 0 || elapsedMs < 0) {
    return 0;
  }
  const position = elapsedMs / sliceMs;
  const index = Math.floor(position);
  if (index >= volumes.length) {
    return 0;
  }
  const next = volumes[index + 1];
  if (next === undefined) {
    return clamp01(volumes[index]);
  }
  const fraction = position - index;
  return clamp01(volumes[index] * (1 - fraction) + next * fraction);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
