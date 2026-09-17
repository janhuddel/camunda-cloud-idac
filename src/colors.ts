/**
 * Minimal ANSI color helpers for CLI output. Disabled automatically when
 * stdout isn't a TTY (piped/redirected output, CI logs) or when `NO_COLOR`
 * is set, per https://no-color.org - checked per call (not cached at import)
 * so it always reflects the current stream.
 */
function colorEnabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function wrap(code: string, text: string): string {
  return colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const red = (text: string): string => wrap("31", text);
export const green = (text: string): string => wrap("32", text);
export const yellow = (text: string): string => wrap("33", text);
export const cyan = (text: string): string => wrap("36", text);
export const dim = (text: string): string => wrap("2", text);
export const bold = (text: string): string => wrap("1", text);
