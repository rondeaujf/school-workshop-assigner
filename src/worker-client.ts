// Main-thread client for the Web Worker entrypoint (`./worker.ts`).
//
// Keeps a request/response correlation table over `postMessage`, and revives a
// `CoherenceError` thrown inside the Worker as a real `CoherenceError` on this
// side (structured-clone drops the prototype), so callers can keep using the
// same `try/catch` + `error.code` they use with the direct API.

import { CoherenceError, type AssignmentInput, type AssignmentResult, type SolverOptions } from './types.js';
import type { AssignResponse, SerializedError } from './worker.js';

/** The subset of the DOM `Worker` interface this client needs — declared
 * structurally so the library needs no DOM lib in its tsconfig. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate?(): void;
}

export interface Assigner {
  assign(input: AssignmentInput, options?: SolverOptions): Promise<AssignmentResult>;
  /** Terminates the underlying Worker and rejects any in-flight requests. */
  terminate(): void;
}

function reviveError(error: SerializedError): Error {
  if (error.name === 'CoherenceError') {
    return new CoherenceError(
      (error.code as CoherenceError['code']) ?? 'INVALID_CAPACITY',
      error.message,
      error.details ?? {},
    );
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}

export function createAssigner(worker: WorkerLike): Assigner {
  let nextId = 0;
  const pending = new Map<number, { resolve: (r: AssignmentResult) => void; reject: (e: Error) => void }>();

  const onMessage = (event: { data: unknown }) => {
    const message = event.data as ({ id?: unknown } & AssignResponse) | null;
    if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(reviveError(message.error));
  };
  worker.addEventListener('message', onMessage);

  return {
    assign(input, options) {
      const id = nextId++;
      return new Promise<AssignmentResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, payload: { input, options } });
      });
    },
    terminate() {
      worker.removeEventListener?.('message', onMessage);
      worker.terminate?.();
      for (const entry of pending.values()) {
        entry.reject(new Error('Worker terminated before the assignment completed.'));
      }
      pending.clear();
    },
  };
}
