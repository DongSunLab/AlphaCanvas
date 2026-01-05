/**
 * Safe function registry builder with cycle detection
 */

import { evaluateWithRegistry } from '../geometry/mathEval';

export interface FunctionNode {
  symbol?: string;
  kind: 'function-explicit' | 'function-implicit';
  expr: string;
}

export interface RegistryEntry {
  arity: number;
  fn: (...args: number[]) => number;
  expr: string;
}

/**
 * Detect cycles in function dependencies before building registry
 * Returns list of symbols involved in cycles
 */
function detectCycles(functions: FunctionNode[]): Set<string> {
  const deps = new Map<string, Set<string>>();
  
  // Build dependency graph
  for (const fn of functions) {
    if (!fn.symbol) continue;
    const fnDeps = new Set<string>();
    const callPattern = /\b([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
    let match;
    while ((match = callPattern.exec(fn.expr)) !== null) {
      const calledSym = match[1];
      if (functions.some(f => f.symbol === calledSym)) {
        fnDeps.add(calledSym);
      }
    }
    deps.set(fn.symbol, fnDeps);
  }
  
  // DFS cycle detection
  const cyclic = new Set<string>();
  const visited = new Set<string>();
  const recStack = new Set<string>();
  
  function dfs(sym: string): boolean {
    if (recStack.has(sym)) {
      // Cycle detected
      cyclic.add(sym);
      return true;
    }
    if (visited.has(sym)) return false;
    
    visited.add(sym);
    recStack.add(sym);
    
    const neighbors = deps.get(sym) || new Set();
    for (const neighbor of neighbors) {
      if (dfs(neighbor)) {
        cyclic.add(sym);
      }
    }
    
    recStack.delete(sym);
    return cyclic.has(sym);
  }
  
  for (const sym of deps.keys()) {
    if (!visited.has(sym)) {
      dfs(sym);
    }
  }
  
  return cyclic;
}

/**
 * Build function registry with safety checks:
 * - Detect and exclude cyclic dependencies
 * - Prevent self-reference
 * - Only include complete, valid functions
 */
export function buildSafeFunctionRegistry(
  functions: FunctionNode[]
): Record<string, RegistryEntry> {
  const registry: Record<string, RegistryEntry> = {};
  
  // Detect cycles first
  const cyclicSymbols = detectCycles(functions);
  if (cyclicSymbols.size > 0) {
    console.warn('Cyclic function dependencies detected, excluding:', Array.from(cyclicSymbols));
  }
  
  // Build registry, excluding cyclic symbols
  for (const fn of functions) {
    if (!fn.symbol) continue;
    if (cyclicSymbols.has(fn.symbol)) {
      console.warn(`Skipping cyclic function: ${fn.symbol}`);
      continue;
    }
    
    // Check for self-reference
    const selfRefPattern = new RegExp(`\\b${fn.symbol}\\s*\\(`, 'g');
    if (selfRefPattern.test(fn.expr)) {
      console.warn(`Skipping self-referential function: ${fn.symbol}`);
      continue;
    }
    
    if (fn.kind === 'function-explicit') {
      registry[fn.symbol] = {
        arity: 1,
        fn: (x: number) => {
          // Note: registry is captured by closure, so later additions are visible
          // But we've already excluded cycles, so this is safe
          return evaluateWithRegistry(fn.expr, { x }, registry);
        },
        expr: fn.expr
      };
    } else if (fn.kind === 'function-implicit') {
      registry[fn.symbol] = {
        arity: 2,
        fn: (x: number, y: number) => {
          return evaluateWithRegistry(fn.expr, { x, y }, registry);
        },
        expr: fn.expr
      };
    }
  }
  
  return registry;
}

