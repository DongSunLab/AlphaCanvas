import type { SceneNode } from './types';

export function formatFunctionLabel(node: any): string {
  if (!node) return '';
  const label = node.label || '';
  const sym = node.symbol || (node.kind === 'function-implicit' ? 'g' : 'f');
  if (node.kind === 'function-explicit') {
    return `${sym}(x) = ${label || '…'}`;
  }
  if (node.kind === 'function-implicit') {
    // Avoid double equals if label already contains '='
    // Use ':' to denote definition by equation
    return `${sym}(x,y): ${label || '…'}`;
  }
  return label;
}


