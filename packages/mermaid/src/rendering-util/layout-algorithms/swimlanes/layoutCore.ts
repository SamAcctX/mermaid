import { log } from '../../../logger.js';
import type { LayoutData } from '../../types.js';
import { postProcessSwimlaneLayout, validateSwimlanesLayout } from './postProcessing.js';
import { toGraphView, writeBackToLayoutData } from './helpers.js';
import { sugiyamaLayout } from './pipeline.js';
import { routeEdgesOrthogonal as raykovRouting } from './raykovGemini/raykov.js';

const SWIMLANE_DEBUG = '[SWIMLANE_DEBUG]';

export type SwimlaneDirection = 'TB' | 'LR' | 'BT' | 'RL';

export function getSwimlaneDirection(data4Layout: LayoutData): SwimlaneDirection {
  return ((data4Layout as LayoutData & { direction?: string }).direction ??
    'TB') as SwimlaneDirection;
}

/**
 * Pure swimlane layout core shared by browser rendering and DDLT.
 *
 * The browser measures DOM nodes before this runs; DDLT injects captured sizes
 * before calling the same function.
 */
export function runSwimlaneLayoutCore(data4Layout: LayoutData): SwimlaneDirection {
  const g = toGraphView(data4Layout);
  const nodeGap = data4Layout.config.flowchart?.nodeSpacing ?? 40;
  const layerGap = data4Layout.config.flowchart?.rankSpacing ?? 100;
  const ignoreCrossLaneEdges = Boolean(
    (data4Layout.config as { flowchart?: { ignoreCrossLaneEdges?: unknown } }).flowchart
      ?.ignoreCrossLaneEdges
  );
  const optimizeRanksSetting = (
    data4Layout.config as { flowchart?: { optimizeRanksByCrossings?: boolean } }
  ).flowchart?.optimizeRanksByCrossings;
  const optimizeRanksByCrossings =
    optimizeRanksSetting !== undefined ? optimizeRanksSetting : ignoreCrossLaneEdges;
  const direction = getSwimlaneDirection(data4Layout);

  const { ordered, coordinates } = sugiyamaLayout(g, {
    nodeGap,
    layerGap,
    sweeps: 3,
    useTranspose: true,
    heuristic: 'median',
    cycleHeuristic: 'dfs',
    straightenLongEdges: true,
    ignoreCrossLaneEdges,
    optimizeRanksByCrossings,
    direction,
  });
  writeBackToLayoutData(g, ordered, coordinates, { nodeGap, layerGap });

  log.debug(SWIMLANE_DEBUG, 'Node positions after Sugiyama layout:');
  for (const node of data4Layout.nodes ?? []) {
    if (!node.isGroup) {
      const isLabelNode = (node as { isEdgeLabel?: boolean }).isEdgeLabel;
      log.debug(
        SWIMLANE_DEBUG,
        `  ${node.id}: x=${node.x?.toFixed(2)}, y=${node.y?.toFixed(2)}, w=${node.width?.toFixed(2)}, h=${node.height?.toFixed(2)}${isLabelNode ? ' [LABEL_NODE]' : ''}, parentId=${node.parentId}`
      );
    }
  }

  log.debug('RAYKOV: Starting routing');
  for (const edge of data4Layout.edges ?? []) {
    delete edge.points;
  }
  raykovRouting(data4Layout, direction);

  for (const edge of data4Layout.edges ?? []) {
    if (!edge.curve || edge.curve === 'basis') {
      edge.curve = 'rounded';
    }
  }

  const contentNodes = (data4Layout.nodes ?? []).filter((n) => !n.isGroup);
  log.debug(`SWIMLANE_SPACING [${direction}] Before direction transform - node positions:`);
  for (const n of contentNodes) {
    log.debug(
      `SWIMLANE_SPACING [${direction}]   ${n.id}: x=${n.x?.toFixed(2)}, y=${n.y?.toFixed(2)}, w=${n.width?.toFixed(2)}, h=${n.height?.toFixed(2)}`
    );
  }

  postProcessSwimlaneLayout(data4Layout, direction);

  log.debug(`SWIMLANE_SPACING [${direction}] After direction transform - node positions:`);
  for (const n of contentNodes) {
    const isLabelNode = (n as { isEdgeLabel?: boolean }).isEdgeLabel;
    log.debug(
      `SWIMLANE_SPACING [${direction}]   ${n.id}: x=${n.x?.toFixed(2)}, y=${n.y?.toFixed(2)}, w=${n.width?.toFixed(2)}, h=${n.height?.toFixed(2)}${isLabelNode ? ' [LABEL_NODE]' : ''}`
    );
  }

  validateSwimlanesLayout(data4Layout);

  return direction;
}
