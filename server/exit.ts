// On Linux a pipe takes writes asynchronously, so `process.exit` right after `console.error` can drop that line; a write
// callback fires only once its data is out.
//
// Node 24 on Windows aborts with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` when
// `process.exit` runs while fetch's keep-alive sockets are still closing. So the command closes fetch's connections and
// ends by draining its event loop; `process.exit` comes only if something still holds the loop after a grace period.
const EXIT_GRACE_MS = 3_000;

/** Node's built-in fetch keeps its connection pool here (undici's global dispatcher). */
const FETCH_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

async function closeFetchConnections(): Promise<void> {
  const dispatcher = (globalThis as Record<symbol, { close?: () => Promise<void> } | undefined>)[FETCH_DISPATCHER];
  if (typeof dispatcher?.close !== "function") return;
  await Promise.race([dispatcher.close().catch(() => undefined), new Promise((done) => setTimeout(done, 1_000).unref())]);
}

export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((done) => stream.write("", () => done()));
  void Promise.all([flushed(process.stdout), flushed(process.stderr)])
    .then(closeFetchConnections)
    .then(() => { setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref(); });
}

/** `openmausbot status | head` closes the pipe early: that ends the output, it is not a crash. */
export function endQuietlyOnClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
      process.exit(process.exitCode ?? 0);
    });
  }
}
