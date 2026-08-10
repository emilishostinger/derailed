import type { Project, Service } from '@derailed/shared';
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Box,
  Copy,
  Database,
  ExternalLink,
  GitBranch,
  LayoutGrid,
  Maximize,
  PanelRight,
  Play,
  Rocket,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endpoints } from '../../api/endpoints.ts';
import { useProjects } from '../../stores/projects.ts';
import { ContextMenu, type MenuItem, useContextMenu } from '../ContextMenu.tsx';
import { cx, ErrorNote, Modal, Spinner } from '../ui.tsx';
import { FloatingEdge } from './FloatingEdge.tsx';
import { autoLayout, clearPositions, loadPositions, savePositions } from './layout.ts';
import { nodeTypes, type ServiceNodeData } from './nodes.tsx';

const INTERNET_ID = '__internet__';

const edgeTypes = { floating: FloatingEdge };

export function TopologyCanvas(props: {
  project: Project;
  selectedId: string | null;
  onSelect: (serviceId: string | null, tab?: string) => void;
  onAdd?: (mode?: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  project,
  selectedId,
  onSelect,
  onAdd,
}: {
  project: Project;
  selectedId: string | null;
  onSelect: (serviceId: string | null, tab?: string) => void;
  onAdd?: (mode?: string) => void;
}) {
  const services = useMemo(() => project.services ?? [], [project.services]);
  const links = useMemo(() => project.links ?? [], [project.links]);
  const { fitView } = useReactFlow();
  const [pendingLink, setPendingLink] = useState<Connection | null>(null);
  const [menuFor, setMenuFor] = useState<Service | null>(null);
  const menu = useContextMenu();
  const reload = useProjects((s) => s.load);

  // React Flow owns node state. Deriving a fresh nodes array on every render throws
  // away the dimensions it measures, and unmeasured nodes stay invisible.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const nodesInitialized = useNodesInitialized();
  const didFit = useRef(false);
  // Hidden until it has been framed, so nobody sees the unpositioned first paint.
  const [ready, setReady] = useState(false);

  const anyPublic = services.some((service) => (service.domains ?? []).length > 0);

  /** Merge live data into the existing nodes, keeping position and measurements. */
  useEffect(() => {
    const saved = loadPositions(project.id);

    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      const next: Node[] = [];

      if (anyPublic) {
        const existing = byId.get(INTERNET_ID);
        next.push(
          existing ?? {
            id: INTERNET_ID,
            type: 'internet',
            position: saved[INTERNET_ID] ?? { x: 0, y: 0 },
            data: {},
          },
        );
      }

      for (const service of services) {
        const existing = byId.get(service.id);
        next.push({
          ...(existing ?? {
            id: service.id,
            position: saved[service.id] ?? { x: 0, y: 0 },
          }),
          type: service.kind === 'database' ? 'database' : 'app',
          data: { service } satisfies ServiceNodeData,
        });
      }

      // Nothing has a saved position yet, lay the whole graph out.
      const needsLayout = next.length > 0 && next.every((node) => !saved[node.id]);
      return needsLayout ? autoLayout(next, buildEdges(services, links)) : next;
    });
  }, [services, links, anyPublic, project.id, setNodes]);

  // Only frame the graph once React Flow has measured the nodes, fitting before
  // that zooms to a bounding box built from zero-sized nodes.
  useEffect(() => {
    if (!nodesInitialized || didFit.current || nodes.length === 0) return;
    didFit.current = true;
    // No duration: animating means the graph is briefly visible in the corner before
    // sliding to the middle, which reads as a glitch every time the page opens.
    void fitView({ padding: 0.25, maxZoom: 1 });
    setReady(true);
  }, [nodesInitialized, nodes.length, fitView]);

  useEffect(() => {
    setEdges(buildEdges(services, links));
  }, [services, links, setEdges]);

  // Selection is driven by the URL, not by React Flow's internal selection.
  useEffect(() => {
    setNodes((previous) =>
      previous.map((node) =>
        node.selected === (node.id === selectedId)
          ? node
          : { ...node, selected: node.id === selectedId },
      ),
    );
  }, [selectedId, setNodes]);

  const onDragStop = useCallback(() => savePositions(project.id, nodes), [nodes, project.id]);

  const tidyUp = useCallback(() => {
    setNodes((previous) => autoLayout(previous, edges));
    clearPositions(project.id);
    setTimeout(() => void fitView({ padding: 0.25, maxZoom: 1, duration: 400 }), 60);
  }, [edges, project.id, setNodes, fitView]);

  return (
    <div
      className={cx(
        'relative h-full w-full transition-opacity duration-150',
        ready ? 'opacity-100' : 'opacity-0',
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onDragStop}
        onNodeClick={(_, node) => node.id !== INTERNET_ID && onSelect(node.id)}
        onNodeContextMenu={(event, node) => {
          if (node.id === INTERNET_ID) return;
          const service = services.find((entry) => entry.id === node.id);
          if (!service) return;
          setMenuFor(service);
          menu.onContextMenu(event as unknown as React.MouseEvent);
        }}
        // The library's failures are silent in production builds; a dropped
        // edge with no words was a whole afternoon once.
        onError={(code, message) => console.warn('[canvas]', code, message)}
        onPaneClick={() => onSelect(null)}
        onPaneContextMenu={(event) => {
          // Right-clicking the empty canvas offers what the canvas is for:
          // putting more things on it. Node menus take precedence above.
          event.preventDefault();
          setMenuFor(null);
          menu.onContextMenu(event as unknown as React.MouseEvent);
        }}
        onConnect={(connection) => setPendingLink(connection)}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesConnectable
        className="bg-sunken"
      >
        {/* Barely there: enough to read as a surface and to see movement against, not
            enough to compete with the nodes. */}
        <Background
          variant={BackgroundVariant.Lines}
          gap={40}
          lineWidth={1}
          color="var(--d-canvas-grid)"
        />
        <Controls
          showInteractive={false}
          className="!border !border-line !bg-surface [&>button]:!border-line [&>button]:!bg-surface [&>button]:!fill-[var(--color-ink-muted)] hover:[&>button]:!bg-surface-2"
        />
      </ReactFlow>

      <button
        type="button"
        onClick={tidyUp}
        title="Rearrange the canvas"
        className="btn-secondary absolute top-3 right-3 z-10"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Tidy up
      </button>

      <ContextMenu
        at={menu.at}
        onClose={menu.close}
        items={
          menuFor
            ? serviceMenu(menuFor, onSelect, reload)
            : paneMenu(onAdd, tidyUp, () => fitView({ padding: 0.2, duration: 300 }))
        }
      />

      {pendingLink && (
        <ConfirmLink
          connection={pendingLink}
          services={services}
          onClose={() => setPendingLink(null)}
        />
      )}
    </div>
  );
}

/** Right-clicking empty canvas: the ways to put something on it, then the canvas itself. */
function paneMenu(
  onAdd: ((mode?: string) => void) | undefined,
  tidyUp: () => void,
  frame: () => void,
): MenuItem[] {
  const items: MenuItem[] = [];
  if (onAdd) {
    items.push(
      {
        label: 'Install a ready-made app',
        icon: <Sparkles className="h-3.5 w-3.5" />,
        onSelect: () => onAdd('apps'),
      },
      {
        label: 'Deploy from GitHub',
        icon: <GitBranch className="h-3.5 w-3.5" />,
        onSelect: () => onAdd('github'),
      },
      {
        label: 'Run a Docker image',
        icon: <Box className="h-3.5 w-3.5" />,
        onSelect: () => onAdd('image'),
      },
      {
        label: 'Upload a website',
        icon: <Upload className="h-3.5 w-3.5" />,
        onSelect: () => onAdd('upload'),
      },
      {
        label: 'Add a database',
        icon: <Database className="h-3.5 w-3.5" />,
        onSelect: () => onAdd('database'),
      },
    );
  }
  items.push(
    {
      label: 'Tidy up the canvas',
      icon: <LayoutGrid className="h-3.5 w-3.5" />,
      separated: items.length > 0,
      onSelect: tidyUp,
    },
    {
      label: 'Frame everything',
      icon: <Maximize className="h-3.5 w-3.5" />,
      onSelect: frame,
    },
  );
  return items;
}

/** The things people actually want from a node without opening it first. */
function serviceMenu(
  service: Service,
  onSelect: (id: string, tab?: string) => void,
  reload: () => Promise<void>,
): MenuItem[] {
  const running = service.status === 'running';
  const domains = service.domains ?? [];
  // The one worth opening: a domain they chose, else a secured one, else anything.
  const address =
    domains.find((domain) => domain.kind === 'custom' && domain.tlsStatus === 'active') ??
    domains.find((domain) => domain.tlsStatus === 'active') ??
    domains[0];
  const act = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
    await reload();
  };

  // Opening the site comes first, because it is what people reach for most.
  const items: MenuItem[] = [];

  if (address) {
    items.push({
      label: 'Open the site',
      icon: <ExternalLink className="h-3.5 w-3.5" />,
      onSelect: () =>
        window.open(
          `${address.tlsStatus === 'active' ? 'https' : 'http'}://${address.hostname}`,
          '_blank',
          'noreferrer',
        ),
    });
    items.push({
      label: 'Copy the address',
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () =>
        void navigator.clipboard
          .writeText(`${address.tlsStatus === 'active' ? 'https' : 'http'}://${address.hostname}`)
          .catch(() => undefined),
    });
  }

  items.push({
    label: 'Open in Derailed',
    icon: <PanelRight className="h-3.5 w-3.5" />,
    separated: address !== undefined,
    onSelect: () => onSelect(service.id),
  });

  if (service.kind === 'app') {
    items.push({
      label: 'Deploy',
      icon: <Rocket className="h-3.5 w-3.5" />,
      separated: true,
      onSelect: () => void act(() => endpoints.deploy(service.id)),
    });
  }

  items.push(
    running
      ? {
          label: 'Stop',
          icon: <Square className="h-3.5 w-3.5" />,
          separated: service.kind !== 'app',
          onSelect: () => void act(() => endpoints.stopService(service.id)),
        }
      : {
          label: 'Start',
          icon: <Play className="h-3.5 w-3.5" />,
          separated: service.kind !== 'app',
          onSelect: () => void act(() => endpoints.startService(service.id)),
        },
    {
      label: 'Restart',
      icon: <RotateCw className="h-3.5 w-3.5" />,
      disabled: !running,
      onSelect: () => void act(() => endpoints.restartService(service.id)),
    },
    {
      label: 'Open a terminal',
      icon: <TerminalIcon className="h-3.5 w-3.5" />,
      disabled: !running,
      separated: true,
      onSelect: () => onSelect(service.id, 'terminal'),
    },
    {
      label: 'Settings',
      icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
      // Deleting is deliberately absent. It needs the typed confirmation in the
      // drawer, and something destructive should not sit one slip away in a menu.
      onSelect: () => onSelect(service.id, 'settings'),
    },
  );

  return items;
}

function buildEdges(services: Service[], links: Project['links'] = []): Edge[] {
  const built: Edge[] = [];

  for (const service of services) {
    if ((service.domains ?? []).length === 0) continue;
    built.push({
      id: `internet-${service.id}`,
      type: 'floating',
      source: INTERNET_ID,
      target: service.id,
      animated: service.status === 'running',
      style: { stroke: 'var(--color-line-strong)', strokeWidth: 1.5 },
    });
  }

  for (const link of links ?? []) {
    const from = services.find((service) => service.id === link.fromServiceId);
    built.push({
      id: link.id,
      type: 'floating',
      source: link.fromServiceId,
      target: link.toServiceId,
      animated: from?.status === 'running',
      style: { stroke: 'var(--color-accent)', strokeWidth: 1.5 },
    });
  }

  return built;
}

/**
 * Dragging an edge is a shortcut for "give this app access to that database", which
 * writes an environment variable. Spell that out before doing it.
 */
function ConfirmLink({
  connection,
  services,
  onClose,
}: {
  connection: Connection;
  services: Service[];
  onClose: () => void;
}) {
  const load = useProjects((s) => s.load);
  const from = services.find((service) => service.id === connection.source);
  const to = services.find((service) => service.id === connection.target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const invalid =
    !from || !to || from.kind !== 'app' || to.kind !== 'database'
      ? 'Connections go from an app to a database.'
      : null;

  async function connect() {
    if (!from || !to) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.createLink(from.id, to.id);
      await load();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title="Connect these?" onClose={onClose}>
      {invalid ? (
        <div className="space-y-4">
          <p className="hint">{invalid}</p>
          <div className="flex justify-end">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-ink">
            Give <span className="font-medium">{from?.name}</span> access to{' '}
            <span className="font-medium">{to?.name}</span>?
          </p>
          <p className="hint">
            Derailed adds the connection details to {from?.name} as an environment variable. You'll
            need to redeploy for it to pick them up.
          </p>

          <ErrorNote error={error} />

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void connect()}
              disabled={busy}
            >
              {busy && <Spinner />}
              Connect
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
