import type { Edge, Node } from '@xyflow/react';
import dagre from 'dagre';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 92;
export const INTERNET_WIDTH = 132;
export const INTERNET_HEIGHT = 64;

/**
 * Left-to-right: the internet on the left, apps in the middle, databases on the
 * right. That ordering is the whole point of the view, traffic flows one way
 * across the screen, so you can read the shape of a server without reading words.
 */
export function autoLayout(nodes: Node[], edges: Edge[]): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 28, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    const isInternet = node.type === 'internet';
    graph.setNode(node.id, {
      width: isInternet ? INTERNET_WIDTH : NODE_WIDTH,
      height: isInternet ? INTERNET_HEIGHT : NODE_HEIGHT,
    });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    if (!positioned) return node;
    // dagre reports centres; React Flow positions by top-left corner.
    return {
      ...node,
      position: {
        x: positioned.x - positioned.width / 2,
        y: positioned.y - positioned.height / 2,
      },
    };
  });
}

const STORAGE_KEY = 'derailed.topology';

export type SavedPositions = Record<string, { x: number; y: number }>;

/**
 * Node positions are a per-person preference, not server state, someone dragging
 * their canvas around shouldn't rearrange it for anyone else.
 */
export function loadPositions(projectId: string): SavedPositions {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}.${projectId}`);
    return raw ? (JSON.parse(raw) as SavedPositions) : {};
  } catch {
    return {};
  }
}

export function savePositions(projectId: string, nodes: Node[]): void {
  try {
    const positions: SavedPositions = {};
    for (const node of nodes) positions[node.id] = node.position;
    localStorage.setItem(`${STORAGE_KEY}.${projectId}`, JSON.stringify(positions));
  } catch {
    // Private browsing. The layout just resets on reload.
  }
}

export function clearPositions(projectId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_KEY}.${projectId}`);
  } catch {
    // nothing to clean up
  }
}
