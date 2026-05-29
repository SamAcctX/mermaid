import { labelHelper, updateNodeBounds, getNodeClasses } from './util.js';
import intersect from '../intersect/index.js';
import type { Node, RectOptions } from '../../types.js';
import { createRoundedRectPathD } from './roundedRectPath.js';
import { userNodeOverrides, styles2String } from './handDrawnShapeStyles.js';
import rough from 'roughjs';
import type { D3Selection } from '../../../types.js';
import { handleUndefinedAttr } from '../../../utils.js';
import type { Bounds, Point } from '../../../types.js';
import { getIconSVG } from '../../icons.js';

export async function drawRect<T extends SVGGraphicsElement>(
  parent: D3Selection<T>,
  node: Node,
  options: RectOptions
) {
  const { labelStyles, nodeStyles } = styles2String(node);
  node.labelStyle = labelStyles;
  // If incoming height & width are present, subtract the padding from them
  // as labelHelper does not take padding into account
  // also check if the width or height is less than minimum default values (50),
  // if so set it to min value
  if (node.width || node.height) {
    node.width = (node?.width ?? 10) - options.labelPaddingX * 2;
    node.height = (node?.height ?? 10) - options.labelPaddingY * 2;
  }

  const iconSize = 20;
  const iconGap = 8;
  const iconWidth = node.icon ? iconSize + iconGap : 0;

  const { shapeSvg, bbox, label } = await labelHelper(parent, node, getNodeClasses(node));

  const totalWidth =
    (node?.width ? node?.width : bbox.width) + options.labelPaddingX * 2 + iconWidth;
  const totalHeight = (node?.height ? node?.height : bbox.height) + options.labelPaddingY * 2;

  const x = -totalWidth / 2;
  const y = -totalHeight / 2;
  let rect;
  let { rx, ry } = node;
  const { cssStyles } = node;

  //use options rx, ry overrides if present
  if (options?.rx && options.ry) {
    rx = options.rx;
    ry = options.ry;
  }

  if (node.look === 'handDrawn') {
    // @ts-ignore TODO: Fix rough typings
    const rc = rough.svg(shapeSvg);
    const options = userNodeOverrides(node, {});

    const roughNode =
      rx || ry
        ? rc.path(createRoundedRectPathD(x, y, totalWidth, totalHeight, rx || 0), options)
        : rc.rectangle(x, y, totalWidth, totalHeight, options);

    rect = shapeSvg.insert(() => roughNode, ':first-child');
    rect.attr('class', 'basic label-container').attr('style', handleUndefinedAttr(cssStyles));
  } else {
    rect = shapeSvg.insert('rect', ':first-child');

    const rectClass = 'basic label-container';

    rect
      .attr('class', rectClass)
      .attr('style', nodeStyles)
      .attr('rx', handleUndefinedAttr(rx))
      .attr('data-id', node.id)
      .attr('ry', handleUndefinedAttr(ry))
      .attr('x', x)
      .attr('y', y)
      .attr('width', totalWidth)
      .attr('height', totalHeight);
  }

  updateNodeBounds(node, rect);

  // Shift label right to make room for icon on the left, and render icon
  if (node.icon) {
    const currentTransform = label.attr('transform') ?? 'translate(0,0)';
    label.attr(
      'transform',
      currentTransform.replace(/translate\(([^,]+),([^)]+)\)/, (_m, x, y) => {
        return `translate(${parseFloat(x) + iconWidth / 2}, ${y})`;
      })
    );

    const iconElem = shapeSvg.append('g').attr('class', 'mindmap-icon');
    iconElem.html(
      `<g>${await getIconSVG(node.icon, { height: iconSize, fallbackPrefix: '' })}</g>`
    );
    const iconBBox = iconElem.node()!.getBBox();
    const iconTargetCenterX = -(bbox.width + iconGap) / 2;
    const tx = iconTargetCenterX - iconBBox.x - iconBBox.width / 2;
    const ty = -iconBBox.y - iconBBox.height / 2;
    iconElem.attr('transform', `translate(${tx}, ${ty})`);
  }

  node.calcIntersect = function (bounds: Bounds, point: Point) {
    return intersect.rect(bounds, point);
  };

  node.intersect = function (point) {
    return intersect.rect(node, point);
  };

  return shapeSvg;
}
