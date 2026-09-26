/**
 * What a run has done so far, as the runner prints it while it works: one
 * progress line, printed again whenever a figure on it moves, so the desktop's
 * loop page counts along with the run (docs/15).
 *
 * Every figure is Perbo's own count or a provider's number, and none is ever
 * read from what an agent said (ADR-0023). Each covers the whole run so far,
 * never one turn of it, so the latest line alone says everything and a relay
 * that keeps only the end of the output loses nothing by it.
 *
 * This module imports nothing, so a browser bundle can carry it.
 */
export interface Tally {
  /** The commands the run's attempts asked for, as their records count them. */
  commands: number;
  /** The paths the run changed that no earlier attempt on the ticket's record had. */
  files: number;
  /** Input tokens, as each provider reports them. */
  input_tokens: number;
  /** Output tokens, as each provider reports them. */
  output_tokens: number;
  /** Micro-dollars from the components that carry a figure. */
  micros: number;
  /** Components that carry no dollar figure: counted, never summed as zero (D-070). */
  unpriced: number;
  /** Priced components that are a charge up to a stop rather than a total. */
  partial: number;
}

const TALLY =
  /^tally: (\d+) commands, (\d+) files, (\d+) input tokens, (\d+) output tokens, (\d+) micro-dollars priced, (\d+) unpriced, (\d+) partial$/;

/** The progress line that carries `tally`. */
export function tallyLine(tally: Tally): string {
  return (
    `tally: ${tally.commands} commands, ${tally.files} files, ${tally.input_tokens} input tokens, ` +
    `${tally.output_tokens} output tokens, ${tally.micros} micro-dollars priced, ${tally.unpriced} unpriced, ` +
    `${tally.partial} partial`
  );
}

/** The figures one progress line carries, or null for a line that is not a tally. */
export function readTally(line: string): Tally | null {
  const match = TALLY.exec(line);
  if (match === null) return null;
  const [commands, files, input_tokens, output_tokens, micros, unpriced, partial] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { commands, files, input_tokens, output_tokens, micros, unpriced, partial };
}
