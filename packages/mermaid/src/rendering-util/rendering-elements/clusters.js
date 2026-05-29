import { getConfig } from '../../diagram-api/diagramAPI.js';
import { evaluate, getEffectiveHtmlLabels } from '../../config.js';
import { log } from '../../logger.js';
import { getSubGraphTitleMargins } from '../../utils/subGraphTitleMargins.js';
import { select } from 'd3';
import rough from 'roughjs';
import { createText } from '../createText.ts';
import intersectRect from '../rendering-elements/intersect/intersect-rect.js';
import createLabel from './createLabel.js';
import { createRoundedRectPathD } from './shapes/roundedRectPath.ts';
import { styles2String, userNodeOverrides } from './shapes/handDrawnShapeStyles.js';

const rect = async (parent, node) => {
  log.info('Creating subgraph rect for ', node.id, node);
  const siteConfig = getConfig();
  const { themeVariables, handDrawnSeed } = siteConfig;
  const { clusterBkg, clusterBorder } = themeVariables;

  const { labelStyles, nodeStyles, borderStyles, backgroundStyles } = styles2String(node);

  // Add outer g element
  const shapeSvg = parent
    .insert('g')
    .attr('class', 'cluster ' + node.cssClasses)
    .attr('id', node.domId)
    .attr('data-look', node.look);

  const useHtmlLabels = getEffectiveHtmlLabels(siteConfig);

  // Create the label and insert it after the rect
  const labelEl = shapeSvg.insert('g').attr('class', 'cluster-label ');

  let text;
  if (node.labelType === 'markdown') {
    text = await createText(labelEl, node.label, {
      style: node.labelStyle,
      useHtmlLabels,
      isNode: true,
      width: node.width,
    });
  } else {
    text = await createLabel(labelEl, node.label, node.labelStyle || '', false, true);
  }

  // Get the size of the label
  let bbox = text.getBBox();

  if (getEffectiveHtmlLabels(siteConfig)) {
    const div = text.children[0];
    const dv = select(text);
    bbox = div.getBoundingClientRect();
    dv.attr('width', bbox.width);
    dv.attr('height', bbox.height);
  }

  const width = node.width <= bbox.width + node.padding ? bbox.width + node.padding : node.width;
  if (node.width <= bbox.width + node.padding) {
    node.diff = (width - node.width) / 2 - node.padding;
  } else {
    node.diff = -node.padding;
  }

  const height = node.height;
  const x = node.x - width / 2;
  const y = node.y - height / 2;

  log.trace('Data ', node, JSON.stringify(node));
  let rect;
  if (node.look === 'handDrawn') {
    // @ts-ignore TODO: Fix rough typings
    const rc = rough.svg(shapeSvg);
    const options = userNodeOverrides(node, {
      roughness: 0.7,
      fill: clusterBkg,
      // fill: 'red',
      stroke: clusterBorder,
      fillWeight: 3,
      seed: handDrawnSeed,
    });
    const roughNode = rc.path(createRoundedRectPathD(x, y, width, height, 0), options);
    rect = shapeSvg.insert(() => {
      log.debug('Rough node insert CXC', roughNode);
      return roughNode;
    }, ':first-child');
    // Should we affect the options instead of doing this?
    rect.select('path:nth-child(2)').attr('style', borderStyles.join(';'));
    rect.select('path').attr('style', backgroundStyles.join(';').replace('fill', 'stroke'));
  } else {
    // add the rect
    rect = shapeSvg.insert('rect', ':first-child');
    // center the rect around its coordinate
    rect
      .attr('style', nodeStyles)
      .attr('rx', node.rx)
      .attr('ry', node.ry)
      .attr('x', x)
      .attr('y', y)
      .attr('width', width)
      .attr('height', height);
  }
  const { subGraphTitleTopMargin } = getSubGraphTitleMargins(siteConfig);
  labelEl.attr(
    'transform',
    // This puts the label on top of the box instead of inside it
    `translate(${node.x - bbox.width / 2}, ${node.y - node.height / 2 + subGraphTitleTopMargin})`
  );

  if (labelStyles) {
    const span = labelEl.select('span');
    if (span) {
      span.attr('style', labelStyles);
    }
  }
  // Center the label

  const rectBox = rect.node().getBBox();
  node.offsetX = 0;
  node.width = rectBox.width;
  node.height = rectBox.height;
  // Used by layout engine to position subgraph in parent
  node.offsetY = bbox.height - node.padding / 2;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: bbox };
};

/**
 * Non visible cluster where the note is group with its
 *
 * @param {any} parent
 * @param {any} node
 * @returns {any} ShapeSvg
 */
const noteGroup = (parent, node) => {
  // Add outer g element
  const shapeSvg = parent.insert('g').attr('class', 'note-cluster').attr('id', node.domId);

  // add the rect
  const rect = shapeSvg.insert('rect', ':first-child');

  const padding = 0 * node.padding;
  const halfPadding = padding / 2;

  // center the rect around its coordinate
  rect
    .attr('rx', node.rx)
    .attr('ry', node.ry)
    .attr('x', node.x - node.width / 2 - halfPadding)
    .attr('y', node.y - node.height / 2 - halfPadding)
    .attr('width', node.width + padding)
    .attr('height', node.height + padding)
    .attr('fill', 'none');

  const rectBox = rect.node().getBBox();
  node.width = rectBox.width;
  node.height = rectBox.height;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: { width: 0, height: 0 } };
};

const roundedWithTitle = async (parent, node) => {
  const siteConfig = getConfig();

  const { themeVariables, handDrawnSeed } = siteConfig;
  const { altBackground, compositeBackground, compositeTitleBackground, nodeBorder } =
    themeVariables;

  // Add outer g element
  const shapeSvg = parent
    .insert('g')
    .attr('class', node.cssClasses)
    .attr('id', node.domId)
    .attr('data-id', node.id)
    .attr('data-look', node.look);

  // add the rect
  const outerRectG = shapeSvg.insert('g', ':first-child');

  // Create the label and insert it after the rect
  const label = shapeSvg.insert('g').attr('class', 'cluster-label');
  let innerRect = shapeSvg.append('rect');

  const text = await createLabel(label, node.label, node.labelStyle, undefined, true);

  // Get the size of the label
  let bbox = text.getBBox();

  if (getEffectiveHtmlLabels(siteConfig)) {
    const div = text.children[0];
    const dv = select(text);
    bbox = div.getBoundingClientRect();
    dv.attr('width', bbox.width);
    dv.attr('height', bbox.height);
  }

  // Rounded With Title
  const padding = 0 * node.padding;
  const halfPadding = padding / 2;

  const width =
    (node.width <= bbox.width + node.padding ? bbox.width + node.padding : node.width) + padding;
  if (node.width <= bbox.width + node.padding) {
    node.diff = (width - node.width) / 2 - node.padding;
  } else {
    node.diff = -node.padding;
  }

  const height = node.height + padding;
  // const height = node.height + padding;
  const innerHeight = node.height + padding - bbox.height - 6;
  const x = node.x - width / 2;
  const y = node.y - height / 2;
  node.width = width;
  const innerY = node.y - node.height / 2 - halfPadding + bbox.height + 2;

  // add the rect
  let rect;
  if (node.look === 'handDrawn') {
    const isAlt = node.cssClasses.includes('statediagram-cluster-alt');
    const rc = rough.svg(shapeSvg);
    const roughOuterNode =
      node.rx || node.ry
        ? rc.path(createRoundedRectPathD(x, y, width, height, 10), {
            roughness: 0.7,
            fill: compositeTitleBackground,
            fillStyle: 'solid',
            stroke: nodeBorder,
            seed: handDrawnSeed,
          })
        : rc.rectangle(x, y, width, height, { seed: handDrawnSeed });

    rect = shapeSvg.insert(() => roughOuterNode, ':first-child');
    const roughInnerNode = rc.rectangle(x, innerY, width, innerHeight, {
      fill: isAlt ? altBackground : compositeBackground,
      fillStyle: isAlt ? 'hachure' : 'solid',
      stroke: nodeBorder,
      seed: handDrawnSeed,
    });

    rect = shapeSvg.insert(() => roughOuterNode, ':first-child');
    innerRect = shapeSvg.insert(() => roughInnerNode);
  } else {
    rect = outerRectG.insert('rect', ':first-child');
    const outerRectClass = 'outer';

    // center the rect around its coordinate
    rect
      .attr('class', outerRectClass)
      .attr('x', x)
      .attr('y', y)
      .attr('width', width)
      .attr('height', height)
      .attr('data-look', node.look);
    innerRect
      .attr('class', 'inner')
      .attr('x', x)
      .attr('y', innerY)
      .attr('width', width)
      .attr('height', innerHeight);
  }

  label.attr(
    'transform',
    `translate(${node.x - bbox.width / 2}, ${y + 1 - (getEffectiveHtmlLabels(siteConfig) ? 0 : 3)})`
  );

  const rectBox = rect.node().getBBox();
  node.height = rectBox.height;
  node.offsetX = 0;
  // Used by layout engine to position subgraph in parent
  node.offsetY = bbox.height - node.padding / 2;
  node.labelBBox = bbox;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: bbox };
};
const kanbanSection = async (parent, node) => {
  log.info('Creating subgraph rect for ', node.id, node);
  const siteConfig = getConfig();
  const { themeVariables, handDrawnSeed } = siteConfig;
  const { clusterBkg, clusterBorder } = themeVariables;

  const { labelStyles, nodeStyles, borderStyles, backgroundStyles } = styles2String(node);

  // Add outer g element
  const shapeSvg = parent
    .insert('g')
    .attr('class', 'cluster ' + node.cssClasses)
    .attr('id', node.domId)
    .attr('data-look', node.look);

  const useHtmlLabels = getEffectiveHtmlLabels(siteConfig);

  // Create the label and insert it after the rect
  const labelEl = shapeSvg.insert('g').attr('class', 'cluster-label ');

  const text = await createText(labelEl, node.label, {
    style: node.labelStyle,
    useHtmlLabels,
    isNode: true,
    width: node.width,
  });

  // Get the size of the label
  let bbox = text.getBBox();

  if (getEffectiveHtmlLabels(siteConfig)) {
    const div = text.children[0];
    const dv = select(text);
    bbox = div.getBoundingClientRect();
    dv.attr('width', bbox.width);
    dv.attr('height', bbox.height);
  }

  const width = node.width <= bbox.width + node.padding ? bbox.width + node.padding : node.width;
  if (node.width <= bbox.width + node.padding) {
    node.diff = (width - node.width) / 2 - node.padding;
  } else {
    node.diff = -node.padding;
  }

  const height = node.height;
  const x = node.x - width / 2;
  const y = node.y - height / 2;

  log.trace('Data ', node, JSON.stringify(node));
  let rect;
  if (node.look === 'handDrawn') {
    // @ts-ignore TODO: Fix rough typings
    const rc = rough.svg(shapeSvg);
    const options = userNodeOverrides(node, {
      roughness: 0.7,
      fill: clusterBkg,
      // fill: 'red',
      stroke: clusterBorder,
      fillWeight: 4,
      seed: handDrawnSeed,
    });
    const roughNode = rc.path(createRoundedRectPathD(x, y, width, height, node.rx), options);
    rect = shapeSvg.insert(() => {
      log.debug('Rough node insert CXC', roughNode);
      return roughNode;
    }, ':first-child');
    // Should we affect the options instead of doing this?
    rect.select('path:nth-child(2)').attr('style', borderStyles.join(';'));
    rect.select('path').attr('style', backgroundStyles.join(';').replace('fill', 'stroke'));
  } else {
    // add the rect
    rect = shapeSvg.insert('rect', ':first-child');
    // center the rect around its coordinate
    rect
      .attr('style', nodeStyles)
      .attr('rx', node.rx)
      .attr('ry', node.ry)
      .attr('x', x)
      .attr('y', y)
      .attr('width', width)
      .attr('height', height);
  }
  const { subGraphTitleTopMargin } = getSubGraphTitleMargins(siteConfig);
  labelEl.attr(
    'transform',
    // This puts the label on top of the box instead of inside it
    `translate(${node.x - bbox.width / 2}, ${node.y - node.height / 2 + subGraphTitleTopMargin})`
  );

  if (labelStyles) {
    const span = labelEl.select('span');
    if (span) {
      span.attr('style', labelStyles);
    }
  }
  // Center the label

  const rectBox = rect.node().getBBox();
  node.offsetX = 0;
  node.width = rectBox.width;
  node.height = rectBox.height;
  // Used by layout engine to position subgraph in parent
  node.offsetY = bbox.height - node.padding / 2;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: bbox };
};
const divider = (parent, node) => {
  const siteConfig = getConfig();

  const { themeVariables, handDrawnSeed } = siteConfig;
  const { nodeBorder } = themeVariables;

  // Add outer g element
  const shapeSvg = parent
    .insert('g')
    .attr('class', node.cssClasses)
    .attr('id', node.domId)
    .attr('data-look', node.look);

  // add the rect
  const outerRectG = shapeSvg.insert('g', ':first-child');

  const padding = 0 * node.padding;

  const width = node.width + padding;

  node.diff = -node.padding;

  const height = node.height + padding;
  // const height = node.height + padding;
  const x = node.x - width / 2;
  const y = node.y - height / 2;
  node.width = width;

  // add the rect
  let rect;
  if (node.look === 'handDrawn') {
    const rc = rough.svg(shapeSvg);
    const roughOuterNode = rc.rectangle(x, y, width, height, {
      fill: 'lightgrey',
      roughness: 0.5,
      strokeLineDash: [5],
      stroke: nodeBorder,
      seed: handDrawnSeed,
    });

    rect = shapeSvg.insert(() => roughOuterNode, ':first-child');
  } else {
    rect = outerRectG.insert('rect', ':first-child');
    let outerRectClass = 'outer';
    if (node.look === 'neo') {
      outerRectClass = 'divider';
    } else {
      outerRectClass = 'divider';
    }

    // center the rect around its coordinate
    rect
      .attr('class', outerRectClass)
      .attr('x', x)
      .attr('y', y)
      .attr('width', width)
      .attr('height', height)
      .attr('data-look', node.look);
  }

  const rectBox = rect.node().getBBox();
  node.height = rectBox.height;
  node.offsetX = 0;
  // Used by layout engine to position subgraph in parent
  node.offsetY = 0;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: {} };
};

const swimlane = async (parent, node) => {
  const siteConfig = getConfig();
  const { themeVariables, handDrawnSeed } = siteConfig;
  const { clusterBkg, clusterBorder } = themeVariables;
  const laneStroke = clusterBorder;

  const { labelStyles, nodeStyles, borderStyles, backgroundStyles } = styles2String(node);

  // Add outer g element
  const shapeSvg = parent
    .insert('g')
    .attr('class', 'cluster swimlane ' + (node.cssClasses || ''))
    .attr('id', node.id)
    .attr('data-id', node.id)
    .attr('data-et', 'cluster')
    .attr('data-look', node.look);

  const useHtmlLabels = evaluate(siteConfig.flowchart.htmlLabels);

  // Determine if this is a left-to-right layout (title on left, rotated)
  const isLR = node.direction === 'LR';

  // Create the label and insert it after the rects
  const labelEl = shapeSvg.insert('g').attr('class', 'cluster-label swimlane-label');

  const text = await createText(labelEl, node.label, {
    style: node.labelStyle,
    useHtmlLabels,
    isNode: true,
    width: node.width,
  });

  // Get the size of the label
  let bbox = text.getBBox();

  if (useHtmlLabels) {
    const div = text.children[0];
    const dv = select(text);
    bbox = div.getBoundingClientRect();
    dv.attr('width', bbox.width);
    dv.attr('height', bbox.height);
  }

  const padding = node.padding ?? 0;
  const width = node.width <= bbox.width + padding ? bbox.width + padding : node.width;
  if (node.width <= bbox.width + padding) {
    node.diff = (width - node.width) / 2 - padding;
  } else {
    node.diff = -padding;
  }

  const height = node.height;
  const laneTop = node.y - height / 2;
  const laneBottom = node.y + height / 2;
  const laneLeft = node.x - width / 2;

  // Top of the content area across all lanes, computed in the swimlanes
  // layout write-back. This is the Y of the highest node in the pool.
  const contentTop =
    node.swimlaneContentTop !== undefined ? node.swimlaneContentTop : laneTop + height / 3;

  // Title band sizing - for LR, the title is on the left; for TB, on top.
  //
  // NOTE: For TB we intentionally use a smaller internal padding so that
  // the visible gap between the title band and the first row of nodes is
  // larger. In LR, the original padding works well visually and is kept.
  const titlePaddingY = isLR ? 4 : 0;
  const desiredTitleSize = bbox.height + 2 * titlePaddingY;

  let titleRect;
  let bodyRect;

  if (isLR) {
    // LR layout: title band is a vertical strip on the left
    // For rotated text, title width is based on label height (rotated)
    const titleWidth = Math.max(desiredTitleSize, bbox.height + 2 * titlePaddingY);
    const bodyX = laneLeft + titleWidth;
    const bodyWidth = Math.max(0, width - titleWidth);

    if (node.look === 'handDrawn') {
      // @ts-ignore TODO: Fix rough typings
      const rc = rough.svg(shapeSvg);
      const titleOptions = userNodeOverrides(node, {
        roughness: 0.7,
        fill: clusterBkg,
        stroke: laneStroke,
        fillWeight: 3,
        seed: handDrawnSeed,
      });
      const bodyOptions = userNodeOverrides(node, {
        roughness: 0.7,
        fill: 'none',
        stroke: laneStroke,
        seed: handDrawnSeed,
      });

      const roughTitle = rc.rectangle(laneLeft, laneTop, titleWidth, height, titleOptions);
      titleRect = shapeSvg.insert(() => roughTitle, ':first-child');
      const roughBody = rc.rectangle(bodyX, laneTop, bodyWidth, height, bodyOptions);
      bodyRect = shapeSvg.insert(() => roughBody, ':first-child');

      titleRect.select('path:nth-child(2)').attr('style', borderStyles.join(';'));
      titleRect.select('path').attr('style', backgroundStyles.join(';').replace('fill', 'stroke'));
    } else {
      titleRect = shapeSvg.insert('rect', ':first-child');
      bodyRect = shapeSvg.insert('rect', ':first-child');

      titleRect
        .attr('class', 'swimlane-title')
        .attr('style', nodeStyles)
        .attr('x', laneLeft)
        .attr('y', laneTop)
        .attr('width', titleWidth)
        .attr('height', height)
        .attr('fill', clusterBkg)
        .attr('stroke', laneStroke);

      bodyRect
        .attr('class', 'swimlane-body')
        .attr('style', nodeStyles)
        .attr('x', bodyX)
        .attr('y', laneTop)
        .attr('width', bodyWidth)
        .attr('height', height)
        .attr('fill', 'none')
        .attr('stroke', laneStroke);
    }

    // Position the label: center it within the title band and rotate -90 degrees
    // After rotation, the label reads bottom-to-top
    const labelCenterX = laneLeft + titleWidth / 2;
    const labelCenterY = node.y;
    labelEl.attr(
      'transform',
      `translate(${labelCenterX}, ${labelCenterY}) rotate(-90) translate(${-bbox.width / 2}, ${-bbox.height / 2})`
    );
  } else {
    // TB layout (default): title band is a horizontal strip on top
    const headerMaxHeight = Math.max(0, contentTop - laneTop);
    const titleHeight = Math.min(desiredTitleSize, headerMaxHeight);

    // The lane body should visually start exactly where the title band ends
    // so that their borders touch. The vertical gap between the title text
    // and the first row of nodes is then controlled purely by the
    // headerMaxHeight/titleHeight relationship (and thus by titlePaddingY).
    const bodyY = laneTop + titleHeight;
    const contentHeight = Math.max(0, laneBottom - bodyY);

    const x = node.x - width / 2;

    if (node.look === 'handDrawn') {
      // @ts-ignore TODO: Fix rough typings
      const rc = rough.svg(shapeSvg);
      const titleOptions = userNodeOverrides(node, {
        roughness: 0.7,
        fill: clusterBkg,
        stroke: laneStroke,
        fillWeight: 3,
        seed: handDrawnSeed,
      });
      const bodyOptions = userNodeOverrides(node, {
        roughness: 0.7,
        fill: 'none',
        stroke: laneStroke,
        seed: handDrawnSeed,
      });

      const roughTitle = rc.rectangle(x, laneTop, width, titleHeight, titleOptions);
      titleRect = shapeSvg.insert(() => roughTitle, ':first-child');
      const roughBody = rc.rectangle(x, bodyY, width, contentHeight, bodyOptions);
      bodyRect = shapeSvg.insert(() => roughBody, ':first-child');

      titleRect.select('path:nth-child(2)').attr('style', borderStyles.join(';'));
      titleRect.select('path').attr('style', backgroundStyles.join(';').replace('fill', 'stroke'));
    } else {
      titleRect = shapeSvg.insert('rect', ':first-child');
      bodyRect = shapeSvg.insert('rect', ':first-child');

      titleRect
        .attr('class', 'swimlane-title')
        .attr('style', nodeStyles)
        .attr('x', x)
        .attr('y', laneTop)
        .attr('width', width)
        .attr('height', titleHeight)
        .attr('fill', clusterBkg)
        .attr('stroke', laneStroke);

      bodyRect
        .attr('class', 'swimlane-body')
        .attr('style', nodeStyles)
        .attr('x', x)
        .attr('y', bodyY)
        .attr('width', width)
        .attr('height', contentHeight)
        .attr('fill', 'none')
        .attr('stroke', laneStroke);
    }

    // Place the label centered within the title band
    const labelX = node.x - bbox.width / 2;
    const labelY = laneTop + (titleHeight - bbox.height) / 2;
    labelEl.attr('transform', `translate(${labelX}, ${labelY})`);
  }

  log.trace('Swimlane data ', node, JSON.stringify(node));

  if (labelStyles) {
    const span = labelEl.select('span');
    if (span) {
      span.attr('style', labelStyles);
    }
  }

  node.offsetX = 0;
  node.width = width;
  node.height = height;
  // Used by layout engine to position subgraph in parent
  node.offsetY = bbox.height - padding / 2;

  node.intersect = function (point) {
    return intersectRect(node, point);
  };

  return { cluster: shapeSvg, labelBBox: bbox };
};

const squareRect = rect;
const shapes = {
  rect,
  squareRect,
  roundedWithTitle,
  noteGroup,
  divider,
  kanbanSection,
  swimlane,
};

let clusterElems = new Map();

/**
 * @typedef {keyof typeof shapes} ClusterShapeID
 */

/**
 * @param {import('../types.js').ClusterNode} node - Shape defaults to 'rect'
 */
export const insertCluster = async (elem, node) => {
  const shape = node.shape || 'rect';
  const cluster = await shapes[shape](elem, node);
  clusterElems.set(node.id, cluster);
  return cluster;
};

export const getClusterTitleWidth = (elem, node) => {
  // TODO: Doesn't this need an `await`?
  const label = createLabel(elem, node.label, node.labelStyle, undefined, true);
  const width = label.getBBox().width;
  elem.node().removeChild(label);
  return width;
};

export const clear = () => {
  clusterElems = new Map();
};

export const positionCluster = (node) => {
  log.info(
    'Position cluster (' +
      node.id +
      ', ' +
      node.x +
      ', ' +
      node.y +
      ') (' +
      node?.width +
      ', ' +
      node?.height +
      ')',
    clusterElems.get(node.id)
  );
  const el = clusterElems.get(node.id);
  el.cluster.attr('transform', 'translate(' + node.x + ', ' + node.y + ')');
};
