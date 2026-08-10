import {
  type EdgeProps,
  getBezierPath,
  type InternalNode,
  Position,
  useInternalNode,
} from '@xyflow/react';

/**
 * An edge that attaches wherever the nodes actually are.
 *
 * The stock edges anchor to fixed handles, right side out and left side in,
 * which reads fine in the freshly laid-out left-to-right graph and stops
 * making sense the moment somebody rearranges it: a database dragged to the
 * left of its app got a line leaving the app's right side and looping all the
 * way back. This edge ignores the handles and draws between the nearest faces
 * of the two nodes, so the lines follow the arrangement instead of fighting
 * it. Dragging a new connection still uses the handles; only the drawing is
 * floating.
 */

/** Where the line between the two centres crosses this node's rectangle. */
function intersection(node: InternalNode, other: InternalNode): { x: number; y: number } {
  const width = node.measured.width ?? 0;
  const height = node.measured.height ?? 0;
  const w = width / 2;
  const h = height / 2;

  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const x1 = other.internals.positionAbsolute.x + (other.measured.width ?? 0) / 2;
  const y1 = other.internals.positionAbsolute.y + (other.measured.height ?? 0) / 2;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

/** Which face of the node a point sits on, so the curve leaves it squarely. */
function sideOf(node: InternalNode, point: { x: number; y: number }): Position {
  const x = Math.round(node.internals.positionAbsolute.x);
  const y = Math.round(node.internals.positionAbsolute.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);

  if (px <= x + 1) return Position.Left;
  if (px >= x + (node.measured.width ?? 0) - 1) return Position.Right;
  if (py <= y + 1) return Position.Top;
  return Position.Bottom;
}

export function FloatingEdge({ id, source, target, markerEnd, style, ...props }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const from = intersection(sourceNode, targetNode);
  const to = intersection(targetNode, sourceNode);

  const [path] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: sideOf(sourceNode, from),
    targetX: to.x,
    targetY: to.y,
    targetPosition: sideOf(targetNode, to),
  });

  const animated = 'animated' in props && props.animated;
  return (
    <path
      id={id}
      d={path}
      fill="none"
      markerEnd={markerEnd}
      style={style}
      className={animated ? 'react-flow__edge-path animated' : 'react-flow__edge-path'}
    />
  );
}
