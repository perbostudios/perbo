/**
 * The three writes every command is given.
 *
 * One definition, in a module that imports nothing: every command takes these,
 * so nothing has to reach into a command's own module for the interface.
 */
export interface Streams {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  isTTY: boolean;
}

/**
 * The three writes a narrated command's context holds, as one object.
 *
 * Everything below a command reads {@link Streams}; a narrated command is
 * handed its diagnostics and its stdout separately, because a caller in this
 * process collects the two apart.
 */
export const narratedStreams = (context: {
  stdout(chunk: string): void;
  isTTY: boolean;
  diagnostics: { stderr(chunk: string): void };
}): Streams => ({
  stdout: context.stdout,
  stderr: (chunk) => context.diagnostics.stderr(chunk),
  isTTY: context.isTTY,
});
