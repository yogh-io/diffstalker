/**
 * The worker thread the symbol engine runs in.
 *
 * Its whole reason to exist is that wasm failures here cannot be contained
 * in-process: a cancelled parse poisons the parser so the NEXT file gets
 * the previous file's symbols, and a pathological query blocks the thread
 * for seconds. Both are survivable only by throwing the thread away, which
 * is what the host does.
 *
 * **There is deliberately no try/catch around the engine.** An escaped
 * throw fires the worker's `error` event, which is the host's signal that
 * this wasm instance is dead and must be discarded. Catching it here would
 * turn a corrupt module into one that keeps answering — the exact
 * wrong-symbols failure this design exists to prevent.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createSymbolEngine } from '@diffstalker/core/symbols/extract';
import type { SymbolEngineOptions } from '@diffstalker/core/symbols/extract';
import type { SymbolOutcome } from '@diffstalker/core/symbols/types';

export interface SymbolRequest {
  seq: number;
  relPath: string;
  content: string;
}

export interface SymbolReply {
  seq: number;
  outcome: SymbolOutcome;
}

if (parentPort === null) throw new Error('symbolWorker must be run as a worker thread');
const port = parentPort;

// Top-level await: grammar loading finishes before any listener attaches.
// No ready handshake is needed — a MessagePort queues messages until a
// 'message' listener is added, so a request that arrives during loading is
// delivered the moment the engine is up.
const engine = await createSymbolEngine(workerData as SymbolEngineOptions);

port.on('message', (request: SymbolRequest) => {
  // Not awaited into a try/catch: a rejection here becomes an unhandled
  // rejection, which the worker surfaces as an 'error' to the host. That
  // is the intended path.
  void engine.extract(request.relPath, request.content).then((outcome) => {
    const reply: SymbolReply = { seq: request.seq, outcome };
    port.postMessage(reply);
  });
});
