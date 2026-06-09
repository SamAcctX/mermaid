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
  hasEdgeLabel,
  insertEdge,
  insertEdgeLabel,
  terminalLabels,
} from '../../rendering-elements/edges.js';
import insertMarkers from '../../rendering-elements/markers.js';
import { clear as clearNodes, positionNode } from '../../rendering-elements/nodes.js';
import type { LayoutData, Edge, ClusterNode } from '../../types.js';
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
type ClusterDb = Map<string, { node?: LayoutData['nodes'][number] } & Record<string, unknown>>;

interface EdgeRenderPaths {
  originalPath?: EdgeRenderPath;
  updatedPath?: EdgeRenderPath;
}

const EMPTY_CLUSTER_DB: ClusterDb = new Map();

export interface CommonLayoutRenderContext<PreparedLayout = unknown> {
  element: D3Selection<SVGElement>;
  helpers?: InternalHelpers;
  options?: RenderOptions;
  positions?: Positions;
  preparedLayout?: PreparedLayout;
}

export interface CommonLayoutPaintContext<
  PreparedLayout = unknown,
  MeasureResult = CommonLayoutMeasure,
> extends CommonLayoutRenderContext<PreparedLayout> {
  measure: MeasureResult;
}

export interface CommonLayoutPaintOptions {
  clusterDb?: ClusterDb;
  getNodes?: (
    data4Layout: LayoutData,
    context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>
  ) => Iterable<LayoutData['nodes'][number]>;
  getEdgeNode?: (
    id: string | undefined,
    edge: Edge,
    context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>
  ) => LayoutData['nodes'][number] | object | undefined;
  skipNode?: (
    node: LayoutData['nodes'][number],
    context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>
  ) => boolean;
  isCluster?: (
    node: LayoutData['nodes'][number],
    context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>
  ) => boolean;
  skipEdge?: (edge: Edge) => boolean;
  skipIntersect?: boolean | ((edge: Edge) => boolean);
}

export interface CommonLayoutRendererDefinition<
  CoreResult = unknown,
  PreparedLayout = void,
  MeasureResult = CommonLayoutMeasure,
> {
  prepareLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => PreparedLayout | Promise<PreparedLayout>;
  measureLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => Promise<MeasureResult>;
  runLayoutCore: (
    data4Layout: LayoutData,
    context: CommonLayoutRenderContext<PreparedLayout>
  ) => CoreResult | Promise<CoreResult>;
  paintLayout?: (
    data4Layout: LayoutData,
    context: CommonLayoutPaintContext<PreparedLayout, MeasureResult>,
    coreResult: CoreResult
  ) => void | Promise<void>;
  afterPaint?: (
    data4Layout: LayoutData,
    context: CommonLayoutPaintContext<PreparedLayout, MeasureResult>,
    coreResult: CoreResult
  ) => void | Promise<void>;
  paintOptions?: CommonLayoutPaintOptions;
}

export function createCommonLayoutRenderer<
  CoreResult = unknown,
  PreparedLayout = void,
  MeasureResult = CommonLayoutMeasure,
>({
  prepareLayout,
  measureLayout,
  runLayoutCore,
  paintLayout,
  afterPaint,
  paintOptions,
}: CommonLayoutRendererDefinition<CoreResult, PreparedLayout, MeasureResult>) {
  const measureLayoutFn =
    measureLayout ??
    (defaultMeasureLayout as unknown as NonNullable<
      CommonLayoutRendererDefinition<CoreResult, PreparedLayout, MeasureResult>['measureLayout']
    >);

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

    const measure = await measureLayoutFn(data4Layout, renderContext);
    const coreResult = await runLayoutCore(data4Layout, renderContext);
    const paintContext: CommonLayoutPaintContext<PreparedLayout, MeasureResult> = {
      ...renderContext,
      measure,
    };

    if (paintLayout) {
      await paintLayout(data4Layout, paintContext, coreResult);
    } else {
      await paintLayoutData(
        data4Layout,
        paintContext as unknown as CommonLayoutPaintContext<unknown, CommonLayoutMeasure>,
        paintOptions
      );
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
  context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>,
  options: CommonLayoutPaintOptions = {}
): Promise<void> {
  const { measure } = context;
  const { groups } = measure;

  // Render clusters and position nodes; this also populates node.intersect on shapes.
  for (const node of options.getNodes?.(data4Layout, context) ?? data4Layout.nodes) {
    if (options.skipNode?.(node, context)) {
      continue;
    }
    await paintLayoutNode(groups, node, context, options);
  }

  const nodeById = buildNodeLookup(data4Layout.nodes);

  for (const edge of data4Layout.edges) {
    if (shouldSkipPaintEdge(edge, options)) {
      continue;
    }

    await paintLayoutEdge(groups, edge, nodeById, data4Layout, options, context);
  }
}

async function paintLayoutNode(
  groups: CommonLayoutMeasure['groups'],
  node: LayoutData['nodes'][number],
  context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>,
  options: CommonLayoutPaintOptions
): Promise<void> {
  if ((node as { clusterNode?: boolean }).clusterNode) {
    positionNode(node);
  } else if (shouldPaintAsCluster(node, context, options)) {
    await insertCluster(groups.clusters, node);
  } else {
    positionNode(node);
  }
}

function shouldPaintAsCluster(
  node: LayoutData['nodes'][number],
  context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>,
  options: CommonLayoutPaintOptions
): node is ClusterNode {
  return node.isGroup === true && (options.isCluster?.(node, context) ?? true);
}

function buildNodeLookup(nodes: LayoutData['nodes']): Map<string, LayoutData['nodes'][number]> {
  const nodeById = new Map<string, LayoutData['nodes'][number]>();
  for (const node of nodes) {
    if (node?.id) {
      nodeById.set(node.id, node);
    }
  }
  return nodeById;
}

function shouldSkipPaintEdge(edge: Edge, options: CommonLayoutPaintOptions): boolean {
  return edge.isLayoutOnly || Boolean(options.skipEdge?.(edge));
}

async function paintLayoutEdge(
  groups: CommonLayoutMeasure['groups'],
  edge: Edge,
  nodeById: Map<string, LayoutData['nodes'][number]>,
  data4Layout: LayoutData,
  options: CommonLayoutPaintOptions,
  context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>
): Promise<void> {
  const paths = insertEdge(
    groups.edgePaths,
    { ...edge },
    options.clusterDb ?? EMPTY_CLUSTER_DB,
    data4Layout.type,
    getRenderedNode(edge.start, edge, nodeById, context, options),
    getRenderedNode(edge.end, edge, nodeById, context, options),
    data4Layout.diagramId,
    shouldSkipIntersect(edge, options)
  ) as EdgeRenderPaths | undefined;

  if (hasEdgeLabel(edge)) {
    if (!edgeLabels.has(edge.id)) {
      await insertEdgeLabel(groups.edgeLabels, edge);
    }
    positionRenderedEdgeLabel(edge, paths);
  }
}

function getRenderedNode(
  id: string | undefined,
  edge: Edge,
  nodeById: Map<string, LayoutData['nodes'][number]>,
  context: CommonLayoutPaintContext<unknown, CommonLayoutMeasure>,
  options: CommonLayoutPaintOptions
): LayoutData['nodes'][number] | object {
  return options.getEdgeNode?.(id, edge, context) ?? (id ? (nodeById.get(id) ?? {}) : {});
}

function shouldSkipIntersect(edge: Edge, options: CommonLayoutPaintOptions): boolean {
  return typeof options.skipIntersect === 'function'
    ? options.skipIntersect(edge)
    : (options.skipIntersect ?? false);
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
      if (paths?.updatedPath) {
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
