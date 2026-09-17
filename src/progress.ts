const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface ProgressReporter {
  /** Rewrite the current status line in place (animated while stderr is a TTY). */
  update(text: string): void;
  /** Print a persistent line, independent of the animated status line. */
  log(text: string): void;
  /** Stop animating, clear the status line, and optionally print a final line. */
  stop(finalText?: string): void;
}

/**
 * A dependency-free, single-line status reporter (braille spinner + elapsed
 * time), rewritten in place via `\r`/ANSI clear-to-end-of-line. Writes to
 * `stderr` by default so it never pollutes a command's piped/CI-consumed
 * stdout. Falls back to plain, non-animated lines when the stream isn't a
 * TTY (CI, redirected output) so logs stay readable there.
 */
export function createProgressReporter(stream: NodeJS.WriteStream = process.stderr): ProgressReporter {
  const isTTY = stream.isTTY === true;
  const start = Date.now();
  let frame = 0;
  let lineIsOpen = false;
  let currentText = "";
  let timer: NodeJS.Timeout | undefined;

  const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

  function render(): void {
    const line = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${currentText} (${elapsed()})`;
    // A line longer than the terminal wraps onto a second row, and `\r\x1b[K`
    // only rewinds/clears the current row - the wrapped remainder of the
    // previous frame would then be left behind on the row above. Truncating
    // to the terminal width keeps every frame a single row, so redraws always
    // cleanly overwrite the last one.
    const width = stream.columns;
    const truncated = width && line.length > width ? `${line.slice(0, width - 1)}…` : line;
    stream.write(`\r\x1b[K${truncated}`);
    frame++;
    lineIsOpen = true;
  }

  return {
    update(text: string) {
      if (!isTTY) {
        stream.write(`${text}\n`);
        return;
      }
      currentText = text;
      render();
      if (!timer) {
        timer = setInterval(render, SPINNER_INTERVAL_MS);
        timer.unref();
      }
    },
    log(text: string) {
      if (isTTY && lineIsOpen) {
        stream.write(`\r\x1b[K${text}\n`);
      } else {
        stream.write(`${text}\n`);
      }
    },
    stop(finalText?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (isTTY && lineIsOpen) {
        stream.write(`\r\x1b[K`);
      }
      lineIsOpen = false;
      if (finalText) {
        stream.write(`${finalText}\n`);
      }
    },
  };
}
