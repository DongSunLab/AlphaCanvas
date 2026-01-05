import { describe, it, expect, beforeEach } from 'vitest';
import { useSceneStore } from '../store';

function resetStore() {
  // reset by replacing entire state to initial
  const s = useSceneStore.getState();
  useSceneStore.setState({
    scene: { ...s.scene, nodes: Object.fromEntries(Object.entries(s.scene.nodes).filter(([_, n]: any) => (n as any).kind === 'axis' || (n as any).kind === 'anchor')), zIndex: {} },
    selectedIds: [],
    hoveredId: null,
    hoveredIntersection: null,
    isInteracting: false,
    nextSymbolIndex: 0,
    twoPointFirstClick: null,
    intersections: [],
    undoStack: [],
    redoStack: [],
    suppressHistory: false,
    pendingInteractionSnapshot: null,
    hasPendingInteractionChange: false,
  } as any);
}

describe('undo/redo', () => {
  beforeEach(() => {
    resetStore();
  });

  it('undoes a point add', () => {
    const { addPoint, scene, undo } = useSceneStore.getState() as any;
    const beforeCount = Object.keys(scene.nodes).length;
    addPoint({ x: 1, y: 2 }, 1.35, '#000');
    const afterAddCount = Object.keys(useSceneStore.getState().scene.nodes).length;
    expect(afterAddCount).toBe(beforeCount + 1);
    undo();
    const afterUndoCount = Object.keys(useSceneStore.getState().scene.nodes).length;
    expect(afterUndoCount).toBe(beforeCount);
  });

  it('redo re-applies after undo', () => {
    const api = useSceneStore.getState() as any;
    const beforeCount = Object.keys(api.scene.nodes).length;
    api.addPoint({ x: 1, y: 2 }, 1.35, '#000');
    api.undo();
    expect(Object.keys(useSceneStore.getState().scene.nodes).length).toBe(beforeCount);
    api.redo();
    expect(Object.keys(useSceneStore.getState().scene.nodes).length).toBe(beforeCount + 1);
  });

  it('batches drag interaction into single history entry', () => {
    const api = useSceneStore.getState() as any;
    // create anchor and drag it
    const a = api.createAnchor({ x: 0, y: 0 });
    const beforeDragUndoLen = useSceneStore.getState().undoStack.length;
    // start interaction
    api.setInteracting(true);
    for (let i = 1; i <= 5; i++) {
      const node = useSceneStore.getState().scene.nodes[a] as any;
      api.upsertNode({ ...node, position: { x: i, y: i } });
    }
    // end interaction -> one snapshot
    api.setInteracting(false);
    const undoLen = useSceneStore.getState().undoStack.length;
    expect(undoLen).toBe(beforeDragUndoLen + 1);
    api.undo();
    const anchorAfterUndo = useSceneStore.getState().scene.nodes[a] as any;
    expect(anchorAfterUndo.position.x).toBe(0);
  });
});


