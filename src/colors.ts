/**
 * Minimal ANSI color helpers for CLI output. Disabled automatically when the
 * stream the text is written to isn't a TTY (piped/redirected output, CI logs)
 * or when `NO_COLOR` is set, per https://no-color.org - checked per call (not
 * cached at import) so it always reflects the current stream. Each stream gets
 * its own palette, since e.g. `2>err.log` redirects only stderr: text bound for
 * stderr must use `stderrColors`, not the default (stdout) exports.
 */
function palette(stream: NodeJS.WriteStream) {
  const wrap = (code: string, text: string): string =>
    stream.isTTY === true && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    red: (text: string): string => wrap("31", text),
    green: (text: string): string => wrap("32", text),
    yellow: (text: string): string => wrap("33", text),
    cyan: (text: string): string => wrap("36", text),
    dim: (text: string): string => wrap("2", text),
    bold: (text: string): string => wrap("1", text),
  };
}

/** For text written to stdout (console.log). */
export const { red, green, yellow, cyan, dim, bold } = palette(process.stdout);

/** For text written to stderr (console.error). */
export const stderrColors = palette(process.stderr);
