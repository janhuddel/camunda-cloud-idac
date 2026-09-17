/**
 * Minimal ANSI color helpers for CLI output. Disabled automatically when the
 * target stream isn't a TTY (piped/redirected output, CI logs) or when
 * `NO_COLOR` is set, per https://no-color.org - checked per call (not cached)
 * so it always reflects the current stream.
 */
export interface Colors {
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true && !process.env.NO_COLOR;
}

/** Bind color helpers to a specific stream - `format.ts` renders for stdout,
 * while `progress.ts` output goes to stderr, and each must judge TTY-ness
 * against the stream it's actually written to. */
export function createColors(stream: NodeJS.WriteStream): Colors {
  const wrap = (code: string, text: string) => (colorEnabled(stream) ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    red: (text) => wrap("31", text),
    green: (text) => wrap("32", text),
    yellow: (text) => wrap("33", text),
    cyan: (text) => wrap("36", text),
    dim: (text) => wrap("2", text),
    bold: (text) => wrap("1", text),
  };
}

const stdoutColors = createColors(process.stdout);
export const { red, green, yellow, cyan, dim, bold } = stdoutColors;
