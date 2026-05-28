import type { Selection } from 'd3';
import * as graphlib from 'dagre-d3-es/src/graphlib/index.js';
import type { LayoutData, NonClusterNode } from './types.js';
import { getConfig } from '../diagram-api/diagramAPI.js';
import { insertNode } from './rendering-elements/nodes.js';
import { DDLT_SIZE_CAPTURE_VERSION } from './layout-algorithms/ddlt/captureContract.js';

// Update type:
type D3Selection<T extends SVGElement = SVGElement> = Selection<
  T,
  unknown,
  Element | null,
  unknown
>;

// ─────────────────────────────────────────────────────────────────────────────
// DDLT size capture
//
// When `window.mermaidCaptureSizes` is truthy, this module records the
// bounding-box dimensions of every leaf node and edge-label dummy node
// measured during createGraphWithElements() and records data matching the
// `.sizes.json` fixture format used by DOM-Decoupled Layout
// Testing (see cypress/platform/dev-diagrams/layout-tests/*.sizes.json).
//
// Toggle from the browser devtools:
//
//   window.mermaidCaptureSizes = true;   // enable
//   window.mermaidCaptureSizes = false;  // disable
//
// Each diagram rendered while enabled updates `window.mermaidLastCapturedSizes`
// and is also appended to `window.mermaidCapturedSizes` (an array) for
// programmatic access from dev-explorer or test tooling.
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedNodeSize {
  id: string;
  width: number;
  height: number;
}

interface CapturedSizesMetadata {
  captureVersion: number;
  capturedAt: string;
  capturedFrom: string;
}

interface CapturedSizes {
  nodes: CapturedNodeSize[];
  metadata: CapturedSizesMetadata;
}

interface CapturedEntry {
  svgId: string;
  sizes: CapturedSizes;
}

interface CaptureGlobal {
  mermaidCaptureSizes?: boolean;
  mermaidCapturedSizes?: CapturedEntry[];
  mermaidLastCapturedSizes?: CapturedEntry;
}

function getCaptureGlobal(): CaptureGlobal | undefined {
  if (typeof globalThis === 'undefined') {
    return undefined;
  }
  return globalThis as unknown as CaptureGlobal;
}

function shouldCaptureSizes(): boolean {
  return Boolean(getCaptureGlobal()?.mermaidCaptureSizes);
}

function capturedFromLocation(): string {
  if (typeof location === 'undefined') {
    return 'browser-dev';
  }
  return `${location.pathname}${location.search}`;
}

function emitCapturedSizes(captured: CapturedSizes, element: D3Selection): void {
  const g = getCaptureGlobal();
  if (!g) {
    return;
  }

  // Identify the owning SVG so captures can be told apart when a page
  // renders many diagrams (e.g. knsv3.html).
  const domNode = element.node();
  const ownerSvg =
    (domNode && 'ownerSVGElement' in domNode ? domNode.ownerSVGElement : null) ?? domNode;
  const svgId = ownerSvg?.id ?? '(unknown)';

  g.mermaidCapturedSizes ??= [];
  const entry = { svgId, sizes: captured };
  g.mermaidCapturedSizes.push(entry);
  g.mermaidLastCapturedSizes = entry;
}

/**
 * Creates a graph by merging the graph construction and DOM element insertion.
 *
 * This function creates the graph, inserts the SVG groups (clusters, edgePaths, edgeLabels, nodes)
 * into the provided element, and uses `insertNode` to add nodes to the diagram. Node dimensions
 * are computed using each node's bounding box.
 *
 * @param element - The D3 selection in which the SVG groups are inserted.
 * @param data4Layout - The layout data containing nodes and edges.
 * @returns A promise resolving to an object containing the graph and the inserted groups.
 */
export async function createGraphWithElements(
  element: D3Selection,
  data4Layout: LayoutData
): Promise<{
  graph: graphlib.Graph;
  groups: {
    clusters: D3Selection<SVGGElement>;
    edgePaths: D3Selection<SVGGElement>;
    edgeLabels: D3Selection<SVGGElement>;
    nodes: D3Selection<SVGGElement>;
    rootGroups: D3Selection<SVGGElement>;
  };
  nodeElements: Map<string, D3Selection<SVGElement | SVGGElement>>;
}> {
  // Create a directed, multi graph.
  const graph = new graphlib.Graph({
    multigraph: true,
    compound: true,
  });
  const edgesToProcess = [...data4Layout.edges];
  const config = getConfig();
  // Create groups for clusters, edge paths, edge labels, and nodes.
  const rootGroups = element.insert('g').attr('class', 'root');
  const clusters = rootGroups.insert('g').attr('class', 'clusters');
  const edgePaths = rootGroups.insert('g').attr('class', 'edges edgePath');
  const edgeLabels = rootGroups.insert('g').attr('class', 'edgeLabels');
  const nodesGroup = rootGroups.insert('g').attr('class', 'nodes');

  const nodeElements = new Map<string, D3Selection<SVGElement | SVGGElement>>();

  // Collector for DDLT size capture (only allocated when the flag is on).
  const capturedSizes: CapturedNodeSize[] | null = shouldCaptureSizes() ? [] : null;

  // Insert nodes into the DOM and add them to the graph.
  await Promise.all(
    data4Layout.nodes.map(async (node) => {
      if (node.isGroup) {
        graph.setNode(node.id, { ...node });
      } else {
        const childNodeEl = await insertNode(nodesGroup, node, { config, dir: node.dir });
        const boundingBox = childNodeEl.node()?.getBBox() ?? { width: 0, height: 0 };
        nodeElements.set(node.id, childNodeEl as D3Selection<SVGElement | SVGGElement>);
        node.width = boundingBox.width;
        node.height = boundingBox.height;
        if (capturedSizes) {
          capturedSizes.push({
            id: node.id,
            width: boundingBox.width,
            height: boundingBox.height,
          });
        }
        graph.setNode(node.id, { ...node });
        if (node.parentId) {
          // Optionally store the parent relationship
          // e.g., you could update the node attributes or handle it as needed.
        }
      }
    })
  );
  // Add edges to the graph.

  const value = data4Layout.config.isLabelNode;

  if (value) {
    for (const edge of edgesToProcess) {
      if (edge.label && edge.label?.length > 0) {
        // Create a label node for the edge
        const startNode = data4Layout.nodes.find((n) => n.id == edge.start);
        const labelNodeId = `edge-label-${edge.start}-${edge.end}-${edge.id}`;
        const labelNode: NonClusterNode = {
          id: labelNodeId,
          label: edge.label,
          edgeStart: edge.start || '',
          edgeEnd: edge.end || '',
          shape: 'labelRect',
          width: 0,
          height: 0,
          isEdgeLabel: true,
          isDummy: true,
          parentId: undefined,
          isGroup: false,
          layer: 0,
          order: 0,
          labelStyle: edge?.labelStyle?.[0] || '',
          ...(startNode?.dir ? { dir: startNode.dir } : {}),
        };

        // Insert the label node into the DOM
        const labelNodeEl = await insertNode(nodesGroup, labelNode, {
          config,
          dir: startNode?.dir,
        });
        const boundingBox = labelNodeEl.node()?.getBBox() ?? { width: 0, height: 0 };

        // Update node dimensions
        labelNode.width = boundingBox.width;
        labelNode.height = boundingBox.height;

        if (capturedSizes) {
          capturedSizes.push({
            id: labelNodeId,
            width: boundingBox.width,
            height: boundingBox.height,
          });
        }

        // Add to graph and tracking maps
        graph.setNode(labelNodeId, { ...labelNode });
        nodeElements.set(labelNodeId, labelNodeEl as D3Selection<SVGElement | SVGGElement>);
        data4Layout.nodes.push(labelNode);

        // Create two edges to replace the original one
        const edgeToLabel = {
          ...edge,
          id: `${edge.id}-to-label`,
          end: labelNodeId,
          label: undefined,
          isLabelEdge: true,
          arrowTypeEnd: 'none',
          arrowTypeStart: 'none',
        };
        const edgeFromLabel = {
          ...edge,
          id: `${edge.id}-from-label`,
          start: labelNodeId,
          end: edge.end,
          label: undefined,
          isLabelEdge: true,
          arrowTypeStart: 'none',
          arrowTypeEnd: 'arrow_point',
        };
        graph.setEdge(edgeToLabel.start!, edgeToLabel.end, { ...edgeToLabel }, edgeToLabel.id);
        graph.setEdge(
          edgeFromLabel.start,
          edgeFromLabel.end!,
          { ...edgeFromLabel },
          edgeFromLabel.id
        );
        data4Layout.edges.push(edgeToLabel, edgeFromLabel);
        const edgeIdToRemove = edge.id;
        data4Layout.edges = data4Layout.edges.filter((edge) => edge.id !== edgeIdToRemove);
        const indexInOriginal = data4Layout.edges.findIndex((e) => e.id === edge.id);
        if (indexInOriginal !== -1) {
          data4Layout.edges.splice(indexInOriginal, 1);
        }
      } else {
        // Regular edge without label
        graph.setEdge(edge.start!, edge.end!, { ...edge }, edge.id);
        const edgeExists = data4Layout.edges.some((existingEdge) => existingEdge.id === edge.id);
        if (!edgeExists) {
          data4Layout.edges.push(edge);
        }
      }
    }
  } else {
    for (const edge of edgesToProcess) {
      graph.setEdge(edge.start!, edge.end!, { ...edge }, edge.id);
      const edgeExists = data4Layout.edges.some((existingEdge) => existingEdge.id === edge.id);
      if (!edgeExists) {
        data4Layout.edges.push(edge);
      }
    }
  }

  if (capturedSizes && capturedSizes.length > 0) {
    emitCapturedSizes(
      {
        metadata: {
          captureVersion: DDLT_SIZE_CAPTURE_VERSION,
          capturedAt: new Date().toISOString(),
          capturedFrom: capturedFromLocation(),
        },
        nodes: capturedSizes,
      },
      element
    );
  }

  return {
    graph,
    groups: { clusters, edgePaths, edgeLabels, nodes: nodesGroup, rootGroups },
    nodeElements,
  };
}
