/**
 * Worker manager with abort/cancel support
 * Ensures only latest task runs, cancels previous
 */

import type { WorkerRequest, WorkerResponse } from './previewEvaluator.worker';

export class PreviewWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    abortController: AbortController;
  }>();
  private requestIdCounter = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    try {
      // Vite/modern bundler will handle this
      this.worker = new Worker(
        new URL('./previewEvaluator.worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const response = e.data;
        const pending = this.pendingRequests.get(response.id);
        
        if (pending) {
          this.pendingRequests.delete(response.id);
          
          if (response.success) {
            pending.resolve(response.result);
          } else {
            pending.reject(new Error(response.error || 'Worker error'));
          }
        }
      };

      this.worker.onerror = (error) => {
        console.error('Worker error:', error);
        // Reject all pending
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Worker crashed'));
          this.pendingRequests.delete(id);
        }
      };
    } catch (err) {
      console.error('Failed to create worker:', err);
    }
  }

  /**
   * Cancel all pending requests (called on new input)
   */
  cancelAll() {
    for (const [id, pending] of this.pendingRequests) {
      pending.abortController.abort();
      pending.reject(new Error('Cancelled'));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Evaluate expression in worker (non-blocking)
   */
  async evaluate(request: Omit<WorkerRequest, 'id'>): Promise<any> {
    if (!this.worker) {
      throw new Error('Worker not available');
    }

    // Cancel previous requests
    this.cancelAll();

    const id = `req_${++this.requestIdCounter}`;
    const abortController = new AbortController();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, abortController });

      // Listen for abort
      abortController.signal.addEventListener('abort', () => {
        this.pendingRequests.delete(id);
        reject(new Error('Aborted'));
      });

      // Send to worker
      this.worker!.postMessage({ ...request, id } as WorkerRequest);

      // Timeout safety net (if worker hangs)
      setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          pending.reject(new Error('Worker timeout'));
          this.pendingRequests.delete(id);
        }
      }, 1000); // 1 second max
    });
  }

  destroy() {
    this.cancelAll();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

// Singleton instance
let workerManagerInstance: PreviewWorkerManager | null = null;

export function getWorkerManager(): PreviewWorkerManager {
  if (!workerManagerInstance) {
    workerManagerInstance = new PreviewWorkerManager();
  }
  return workerManagerInstance;
}

