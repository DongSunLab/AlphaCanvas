/**
 * Web Worker for preview evaluation
 * Runs all heavy computation off the main thread
 */

import { evaluateWithRegistry } from '../geometry/mathEval';
import { buildSafeFunctionRegistry } from '../shared/registryBuilder';
import type { FunctionNode } from '../shared/registryBuilder';

export interface WorkerRequest {
  id: string;
  type: 'evaluate' | 'parse-point' | 'parse-translation';
  latex: string;
  expr: string;
  functions: FunctionNode[];
  // For specific request types
  evaluatorExpr?: string;
  pointCoords?: { sx: string; sy: string };
}

export interface WorkerResponse {
  id: string;
  success: boolean;
  type: 'evaluate' | 'parse-point' | 'parse-translation';
  result?: any;
  error?: string;
}

// Listen for messages from main thread
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const request = e.data;
  const startTime = performance.now();
  
  try {
    // Build registry in worker
    const registry = buildSafeFunctionRegistry(request.functions);
    
    let result: any;
    
    switch (request.type) {
      case 'evaluate': {
        // Simple evaluation with registry
        if (request.evaluatorExpr) {
          result = evaluateWithRegistry(request.evaluatorExpr, {}, registry);
        }
        break;
      }
      
      case 'parse-point': {
        // Parse point coordinates
        if (request.pointCoords) {
          const { sx, sy } = request.pointCoords;
          const dx = evaluateWithRegistry(sx, {}, registry);
          const dy = evaluateWithRegistry(sy, {}, registry);
          if (Number.isFinite(dx) && Number.isFinite(dy)) {
            result = { x: dx, y: dy };
          }
        }
        break;
      }
      
      case 'parse-translation': {
        // Would handle translation pattern parsing
        // For now, return null to indicate not implemented in worker yet
        result = null;
        break;
      }
    }
    
    const elapsed = performance.now() - startTime;
    
    // Send success response
    const response: WorkerResponse = {
      id: request.id,
      success: true,
      type: request.type,
      result
    };
    
    self.postMessage(response);
    
    // Log if took too long (debugging)
    if (elapsed > 50) {
      console.warn(`Worker task ${request.id} took ${elapsed.toFixed(1)}ms`);
    }
    
  } catch (error) {
    // Send error response
    const response: WorkerResponse = {
      id: request.id,
      success: false,
      type: request.type,
      error: error instanceof Error ? error.message : String(error)
    };
    
    self.postMessage(response);
  }
};

