import type { Positions, SVG } from '../../../diagram-api/types.js';
import type { InternalHelpers } from '../../../internals.js';
import type { D3Selection } from '../../../types.js';
import { log } from '../../../logger.js';
import { getConfig } from '../../../config.js';
import utils from '../../../utils.js';
import { getSubGraphTitleMargins } from '../../../utils/subGraphTitleMargins.js';
import { createGraphWithElements } from '../../createGraph.js';
import { clear as clearClusters, insertCluster } from '../../rendering-elements/clusters.js';
import {
  clear as clearEdges,
  edgeLabels,
  insertEdge,
  insertEdgeLabel,
  terminalLabels,
} from '../../rendering-elements/edges.js';
import insertMarkers from '../../rendering-elements/markers.js';
import { clear as clearNodes, positionNode } from '../../rendering-elements/nodes.js';
import type { LayoutData, Edge } from '../../types.js';
import type { RenderOptions } from '../../render.js';
import { clear as clearGraphlib } from '../dagre/mermaid-graphlib.js';

export type CommonLayoutMeasure = Awaited<ReturnType<typeof createGraphWithElements>>;
type RenderedEdge = Edge & {
  x?: number;
  y?: number;
  startLabelLeft?: string;
  endLabelRight?: string;
};
type EdgeRenderPath = Parameters<typeof utils.calcLabelPosition>[0];

interface EdgeRenderPaths {
  originalPath?: EdgeRenderPath;
  updatedPath?: EdgeRenderPath;
}

export interface CommonLayoutRenderContext<PreparedLayout = unknown> {
  element: D3Selection<SVGElement>;
  helpers?: InternalHelpers;
  options?: RenderOptions;
  positions?: Positions;
  preparedLayout?: PreparedLayout;
}

export interface CommonLayoutPaintContext<PreparedLayout = unknown>
  extends CommonLayoutRenderContext<PreparedLayout> {
  measure: CommonLayoutMeasure;
}

export interface CommonLayoutPaintOptions {
  skipEdge?: (edge: Edge) => boolean;
  skipIntersect?: boolean | ((edge: Edge) => boolean);
}

export interface CommonLayoutRendererDefinition<CoreResult = unknown, PreparedLayout = void> {
  prepareLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => PreparedLayout | Promise<PreparedLayout>;
  measureLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => Promise<CommonLayoutMeasure>;
  runLayoutCore: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => CoreResult | Promise<CoreResult>;
  paintLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutPaintContext<PreparedLayout>,
    coreResult: CoreResult
  ) => void | Promise<void>;
  afterPaint?: (
    data4Layout: LayoutData,
    context: CommonLayoutPaintContext<PreparedLayout>,
    coreResult: CoreResult
  ) => void | Promise<void>;
  paintOptions?: CommonLayoutPaintOptions;
}

export function createCommonLayoutRenderer<CoreResult = unknown, PreparedLayout = void>({
  prepareLayout,
  measureLayout = defaultMeasureLayout,
  runLayoutCore,
  paintLayout,
  afterPaint,
  paintOptions,
}: CommonLayoutRendererDefinition<CoreResult, PreparedLayout>) {
  return async function render(
    data4Layout: LayoutData,
    svg: SVG,
    helpers?: InternalHelpers,
    options?: RenderOptions,
    positions?: Positions
  ): Promise<void> {
    const element = svg.select('g') as unknown as D3Selection<SVGElement>;
    insertMarkers(element, data4Layout.markers, data4Layout.type, data4Layout.diagramId);
    clearLayoutRenderState();

    const renderContext: CommonLayoutRenderContext<PreparedLayout> = {
      element,
      helpers,
      options,
      positions,
    };
    renderContext.preparedLayout = await prepareLayout?.(data4Layout, renderContext);

    const measure = await measureLayout(data4Layout, renderContext);
    const coreResult = await runLayoutCore(data4Layout, renderContext);
    const paintContext: CommonLayoutPaintContext<PreparedLayout> = { ...renderContext, measure };

    if (paintLayout) {
      await paintLayout(data4Layout, paintContext, coreResult);
    } else {
      await paintLayoutData(data4Layout, paintContext, paintOptions);
    }
    await afterPaint?.(data4Layout, paintContext, coreResult);
  };
}

export function clearLayoutRenderState(): void {
  clearNodes();
  clearEdges();
  clearClusters();
  clearGraphlib();
}

export async function defaultMeasureLayout(
  data4Layout: LayoutData,
  { element }: CommonLayoutRenderContext
): Promise<CommonLayoutMeasure> {
  return await createGraphWithElements(element, data4Layout);
}

export async function paintLayoutData(
  data4Layout: LayoutData,
  { measure }: CommonLayoutPaintContext,
  options: CommonLayoutPaintOptions = {}
): Promise<void> {
  const { groups } = measure;

  // Render clusters and position nodes; this also populates node.intersect on shapes.
  for (const node of data4Layout.nodes) {
    if (node.isGroup) {
      await insertCluster(groups.clusters, node);
    } else {
      positionNode(node);
    }
  }

  const nodeById = new Map<string, unknown>();
  for (const node of data4Layout.nodes) {
    if (node?.id) {
      nodeById.set(node.id, node);
    }
  }

  for (const edge of data4Layout.edges) {
    if (edge.isLayoutOnly || options.skipEdge?.(edge)) {
      continue;
    }

    const startNode = edge.start ? (nodeById.get(edge.start) ?? {}) : {};
    const endNode = edge.end ? (nodeById.get(edge.end) ?? {}) : {};
    const skipIntersect =
      typeof options.skipIntersect === 'function'
        ? options.skipIntersect(edge)
        : (options.skipIntersect ?? false);

    const paths = insertEdge(
      groups.edgePaths,
      { ...edge },
      {},
      data4Layout.type,
      startNode,
      endNode,
      data4Layout.diagramId,
      skipIntersect
    ) as EdgeRenderPaths | undefined;
    if (edge.label) {
      await insertEdgeLabel(groups.rootGroups, edge);
      positionRenderedEdgeLabel(edge, paths);
    }
  }
}

function positionRenderedEdgeLabel(edge: RenderedEdge, paths?: EdgeRenderPaths): void {
  const path = paths?.updatedPath ?? paths?.originalPath;
  const siteConfig = getConfig();
  const { subGraphTitleTotalMargin } = getSubGraphTitleMargins({
    flowchart: siteConfig.flowchart ?? {},
  });
  if (edge.label) {
    const el = edgeLabels.get(edge.id);
    let x = edge.x;
    let y = edge.y;
    if (path) {
      const pos = utils.calcLabelPosition(path);
      log.debug(
        'Moving label ' + edge.label + ' from (',
        x,
        ',',
        y,
        ') to (',
        pos.x,
        ',',
        pos.y,
        ') abc88'
      );
      if (paths) {
        x = pos.x;
        y = pos.y;
      }
    }
    el.attr('transform', `translate(${x}, ${y! + subGraphTitleTotalMargin / 2})`);
  }

  if (edge?.startLabelLeft) {
    const el = terminalLabels.get(edge.id).startLeft;
    let x = edge?.x;
    let y = edge?.y;
    if (path) {
      const pos = utils.calcTerminalLabelPosition(edge.arrowTypeStart ? 10 : 0, 'start_left', path);
      x = pos.x;
      y = pos.y;
    }
    el.attr('transform', `translate(${x}, ${y})`);
  }
  if (edge.startLabelRight) {
    const el = terminalLabels.get(edge.id).startRight;
    let x = edge.x;
    let y = edge.y;
    if (path) {
      const pos = utils.calcTerminalLabelPosition(
        edge.arrowTypeStart ? 10 : 0,
        'start_right',
        path
      );
      x = pos.x;
      y = pos.y;
    }
    el.attr('transform', `translate(${x}, ${y})`);
  }
  if (edge.endLabelLeft) {
    const el = terminalLabels.get(edge.id).endLeft;
    let x = edge.x;
    let y = edge.y;
    if (path) {
      const pos = utils.calcTerminalLabelPosition(edge.arrowTypeEnd ? 10 : 0, 'end_left', path);
      x = pos.x;
      y = pos.y;
    }
    el.attr('transform', `translate(${x}, ${y})`);
  }
  if (edge.endLabelRight) {
    const el = terminalLabels.get(edge.id).endRight;
    let x = edge.x;
    let y = edge.y;
    if (path) {
      const pos = utils.calcTerminalLabelPosition(edge.arrowTypeEnd ? 10 : 0, 'end_right', path);
      x = pos.x;
      y = pos.y;
    }
    el.attr('transform', `translate(${x}, ${y})`);
  }
}
