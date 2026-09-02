// Web Worker entrypoint.
//
// `assignStudentsToWorkshops` runs several synchronous HiGHS solves back to
// back; on the main thread that freezes the UI for the whole run. Load this
// module in a Worker so the solve happens off the main thread:
//
//   // main thread
//   import { createAssigner } from 'school-workshop-assigner/worker-client';
//   const worker = new Worker(
//     new URL('school-workshop-assigner/worker', import.meta.url),
//     { type: 'module' },
//   );
//   const assigner = createAssigner(worker);
//   const result = await assigner.assign(input, { locateFile });
//
// The bundler resolves the `school-workshop-assigner/worker` specifier; in a
// no-bundler setup, point the `new URL(...)` at the built `dist/worker.js` and
// pass `locateFile` so the Worker can find the HiGHS `.wasm` from its own
// context.

import { assignStudentsToWorkshops } from './index.js';
import { CoherenceError, type AssignmentInput, type SolverOptions } from './types.js';

export interface AssignRequest {
  input: AssignmentInput;
  options?: SolverOptions;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export type AssignResponse =
  | { ok: true; result: Awaited<ReturnType<typeof assignStudentsToWorkshops>> }
  | { ok: false; error: SerializedError };

function serializeError(error: unknown): SerializedError {
  if (error instanceof CoherenceError) {
    return { name: error.name, message: error.message, code: error.code, details: error.details };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

/** Runs one assignment request, catching every failure into a serializable
 * shape. Exported directly so it can be unit-tested without a real Worker. */
export async function handleAssignRequest(request: AssignRequest): Promise<AssignResponse> {
  try {
    const result = await assignStudentsToWorkshops(request.input, request.options);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

// Wire to the Worker message loop when actually running inside a Worker.
declare const self: {
  addEventListener?: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  postMessage?: (message: unknown) => void;
};

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof self.postMessage === 'function') {
  self.addEventListener('message', async (event) => {
    const message = event.data as { id?: unknown; payload?: AssignRequest };
    if (!message || typeof message !== 'object' || !('id' in message) || !message.payload) return;
    const response = await handleAssignRequest(message.payload);
    self.postMessage!({ id: message.id, ...response });
  });
}
