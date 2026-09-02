import { describe, expect, it } from 'vitest';
import { handleAssignRequest } from '../src/worker.js';
import { createAssigner, type WorkerLike } from '../src/worker-client.js';
import { CoherenceError } from '../src/types.js';

const workshops = [
  { name: 'Theater', maxCapacity: 2 },
  { name: 'Robotics', maxCapacity: 2 },
];
const students = [
  { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A', choice1: 'Theater' },
  { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A', choice1: 'Robotics' },
];

describe('handleAssignRequest', () => {
  it('returns a success envelope for a solvable request', async () => {
    const response = await handleAssignRequest({ input: { workshops, students } });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.status).toBe('OPTIMAL');
      expect(response.result.statistics.totalStudents).toBe(2);
    }
  });

  it('catches a CoherenceError into a serializable envelope with its code', async () => {
    const response = await handleAssignRequest({
      input: { workshops: [{ name: 'A', maxCapacity: 1 }], students },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatchObject({
        name: 'CoherenceError',
        code: 'INSUFFICIENT_CAPACITY',
        details: { shortfall: 1 },
      });
    }
  });
});

/** In-process stand-in for a real Worker: routes postMessage through
 * handleAssignRequest and echoes the response back on the 'message' channel. */
function fakeWorker(): WorkerLike & { terminated: boolean } {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    terminated: false,
    postMessage(message: unknown) {
      const { id, payload } = message as { id: number; payload: Parameters<typeof handleAssignRequest>[0] };
      void handleAssignRequest(payload).then((response) => {
        for (const listener of listeners) listener({ data: { id, ...response } });
      });
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    terminate() {
      this.terminated = true;
      listeners.clear();
    },
  };
}

describe('createAssigner', () => {
  it('resolves assign() with the worker result', async () => {
    const assigner = createAssigner(fakeWorker());
    const result = await assigner.assign({ workshops, students });
    expect(result.status).toBe('OPTIMAL');
  });

  it('rejects assign() with a revived CoherenceError (prototype and code intact)', async () => {
    const assigner = createAssigner(fakeWorker());
    let caught: unknown;
    try {
      await assigner.assign({ workshops: [{ name: 'A', maxCapacity: 1 }], students });
      expect.unreachable('assign() should have rejected');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoherenceError);
    expect((caught as CoherenceError).code).toBe('INSUFFICIENT_CAPACITY');
  });

  it('rejects in-flight requests when terminated', async () => {
    const worker = fakeWorker();
    const assigner = createAssigner(worker);
    const pending = assigner.assign({ workshops, students });
    assigner.terminate();
    await expect(pending).rejects.toThrow(/terminated/);
    expect(worker.terminated).toBe(true);
  });
});
