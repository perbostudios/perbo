/**
 * How long something took, in the words the quantity is read in.
 *
 * Two quantities, two formats, on purpose: machine time — a process, an
 * attempt, a wait, a ceiling, a baseline timing — rounds to whole seconds,
 * while a person's own time is measured to a tenth of a unit, because the
 * person being measured can see the difference.
 */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/**
 * The units {@link formatHumanElapsed} prints, smallest first, each with the
 * rounded value at which it overflows into the next one. Hours are the last,
 * so nothing overflows out.
 */
const HUMAN_SCALES = [
  { unit: "second", ms: 1_000, overflowsAt: 60 },
  { unit: "minute", ms: 60_000, overflowsAt: 60 },
  { unit: "hour", ms: 3_600_000, overflowsAt: Infinity },
] as const;

/**
 * Human time in the unit a person reads it in: seconds, minutes or hours.
 *
 * `human_elapsed_ms` measures somebody reading a contract and deciding, which
 * usually lands in seconds or minutes; `27308ms` is arithmetic homework, not a
 * reading.
 * Distinct from `formatDuration`, which rounds machine time to whole seconds —
 * a tenth of a second is visible to the person being measured here.
 *
 * The unit follows the rounded value, not the raw one: 59_999 ms rounds to
 * `60.0` seconds, which is a minute a person would never write that way, so it
 * reads `1.0 minute` — and 3_599_999 ms reads `1.0 hour` for the same reason.
 */
export function formatHumanElapsed(ms: number): string {
  const scale =
    HUMAN_SCALES.find((candidate) => Number((ms / candidate.ms).toFixed(1)) < candidate.overflowsAt) ??
    HUMAN_SCALES[HUMAN_SCALES.length - 1]!;
  const rendered = (ms / scale.ms).toFixed(1);
  return `${rendered} ${rendered === "1.0" ? scale.unit : `${scale.unit}s`}`;
}
