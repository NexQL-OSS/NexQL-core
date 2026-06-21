import { JoinGraph, JoinEdge } from './types';

export interface PathStep {
  table: string;
  edges: JoinEdge[];
}

/**
 * Finds the shortest join path between two tables using the undirected join graph.
 * Caps path length to 3 steps. Returns a list of edges to traverse, or null if no path exists.
 */
export function findShortestJoinPath(
  fromTable: string,
  toTable: string,
  graph: JoinGraph
): JoinEdge[] | null {
  if (fromTable === toTable) {
    return [];
  }

  // Build adjacency list map: table -> list of edges connected to it
  const adj = new Map<string, JoinEdge[]>();
  for (const edge of graph.edges) {
    let listFrom = adj.get(edge.from);
    if (!listFrom) {
      listFrom = [];
      adj.set(edge.from, listFrom);
    }
    listFrom.push(edge);

    let listTo = adj.get(edge.to);
    if (!listTo) {
      listTo = [];
      adj.set(edge.to, listTo);
    }
    listTo.push(edge);
  }

  // BFS Queue: [currentTable, pathOfEdges]
  const queue: [string, JoinEdge[]][] = [[fromTable, []]];
  const visited = new Set<string>([fromTable]);

  while (queue.length > 0) {
    const [curr, path] = queue.shift()!;

    if (path.length >= 3) {
      continue;
    }

    const edges = adj.get(curr) || [];
    for (const edge of edges) {
      const neighbor = edge.from === curr ? edge.to : edge.from;

      if (visited.has(neighbor)) {
        continue;
      }

      const newPath = [...path, edge];

      if (neighbor === toTable) {
        return newPath;
      }

      visited.add(neighbor);
      queue.push([neighbor, newPath]);
    }
  }

  return null;
}
