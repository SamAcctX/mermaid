import type d3 from 'd3';
import { arc, pie as d3pie, scaleOrdinal } from 'd3';
import type { MermaidConfig, PieDiagramConfig } from '../../config.type.js';
import { getConfig } from '../../diagram-api/diagramAPI.js';
import type { DrawDefinition, SVG, SVGGroup } from '../../diagram-api/types.js';
import { log } from '../../logger.js';
import { selectSvgElement } from '../../rendering-util/selectSvgElement.js';
import { configureSvgSize } from '../../setupGraphViewbox.js';
import { cleanAndMerge, parseFontSize } from '../../utils.js';
import type { D3Section, PieDB, Sections } from './pieTypes.js';

const createPieArcs = (sections: Sections): d3.PieArcDatum<D3Section>[] => {
  const sum = [...sections.values()].reduce((acc, val) => acc + val, 0);

  const pieData: D3Section[] = [...sections.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((d) => (d.value / sum) * 100 >= 1); // Remove values < 1%

  const pie: d3.Pie<unknown, D3Section> = d3pie<D3Section>()
    .value((d) => d.value)
    .sort(null);
  return pie(pieData);
};

/**
 * Draws a Pie Chart with the data given in text.
 *
 * @param text - pie chart code
 * @param id - diagram id
 * @param _version - MermaidJS version from package.json.
 * @param diagObj - A standard diagram containing the DB and the text and type etc of the diagram.
 */
export const draw: DrawDefinition = (text, id, _version, diagObj) => {
  log.debug('rendering pie chart\n' + text);
  const db = diagObj.db as PieDB;
  const globalConfig: MermaidConfig = getConfig();
  const pieConfig: Required<PieDiagramConfig> = cleanAndMerge(db.getConfig(), globalConfig.pie);
  const MARGIN = 40;
  const LEGEND_RECT_SIZE = 18;
  const LEGEND_SPACING = 4;
  const height = 450;
  const pieWidth: number = height;
  const svg: SVG = selectSvgElement(id);
  const group: SVGGroup = svg.append('g');
  group.attr('transform', 'translate(' + pieWidth / 2 + ',' + height / 2 + ')');

  const { themeVariables } = globalConfig;
  let [outerStrokeWidth] = parseFontSize(themeVariables.pieOuterStrokeWidth);
  outerStrokeWidth ??= 2;

  const legendPosition = pieConfig.legendPosition;
  const noLegend: boolean = legendPosition === 'none';

  const textPosition: number = pieConfig.textPosition;
  const innerHole: number = pieConfig.innerHole;
  const radius: number = Math.min(pieWidth, height) / 2 - MARGIN;
  // Shape helper to build arcs:
  const arcGenerator: d3.Arc<unknown, d3.PieArcDatum<D3Section>> = arc<d3.PieArcDatum<D3Section>>()
    .innerRadius(innerHole * radius)
    .outerRadius(radius);
  const labelArcGenerator: d3.Arc<unknown, d3.PieArcDatum<D3Section>> = arc<
    d3.PieArcDatum<D3Section>
  >()
    .innerRadius(radius * textPosition)
    .outerRadius(radius * textPosition);

  const pie = group.append('g');

  pie
    .append('circle')
    .attr('cx', 0)
    .attr('cy', 0)
    .attr('r', radius + outerStrokeWidth / 2)
    .attr('class', 'pieOuterCircle');

  const sections: Sections = db.getSections();
  const arcs: d3.PieArcDatum<D3Section>[] = createPieArcs(sections);

  const myGeneratedColors = [
    themeVariables.pie1,
    themeVariables.pie2,
    themeVariables.pie3,
    themeVariables.pie4,
    themeVariables.pie5,
    themeVariables.pie6,
    themeVariables.pie7,
    themeVariables.pie8,
    themeVariables.pie9,
    themeVariables.pie10,
    themeVariables.pie11,
    themeVariables.pie12,
  ];
  let sum = 0;
  sections.forEach((section) => {
    sum += section;
  });

  // Filter out arcs that would render as 0%
  const filteredArcs = arcs.filter((datum) => ((datum.data.value / sum) * 100).toFixed(0) !== '0');

  // Set the color scale
  const color: d3.ScaleOrdinal<string, 12, never> = scaleOrdinal(myGeneratedColors).domain([
    ...sections.keys(),
  ]);

  // Build the pie chart: each part of the pie is a path that we build using the arc function.
  pie
    .selectAll('mySlices')
    .data(filteredArcs)
    .enter()
    .append('path')
    .attr('d', arcGenerator)
    .attr('fill', (datum: d3.PieArcDatum<D3Section>) => {
      return color(datum.data.label);
    })
    .attr('class', 'pieCircle');

  // Now add the section text.
  // Use the centroid method to get the best coordinates.
  pie
    .selectAll('mySlices')
    .data(filteredArcs)
    .enter()
    .append('text')
    .text((datum: d3.PieArcDatum<D3Section>): string => {
      let label: string = datum.data.label;
      if (db.getShowData()) {
        label = `${datum.data.label} [${datum.data.value}]`;
      }
      const percentage: string = ((datum.data.value / sum) * 100).toFixed(0) + '%';
      if (noLegend) {
        return `${label} - ${percentage}`;
      }
      return percentage;
    })
    .attr('transform', (datum: d3.PieArcDatum<D3Section>): string => {
      // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
      return 'translate(' + labelArcGenerator.centroid(datum) + ')';
    })
    .style('text-anchor', 'middle')
    .attr('class', 'slice');

  const titleText = group
    .append('text')
    .text(db.getDiagramTitle())
    .attr('x', 0)
    .attr('y', -(height - 50) / 2)
    .attr('class', 'pieTitleText');

  // Add the legends/annotations for each section
  const allSectionData: D3Section[] = [...sections.entries()].map(([label, value]) => ({
    label,
    value,
  }));

  let chartAndLegendHeight: number = pieWidth + MARGIN;
  let chartAndLegendWidth: number = pieWidth + MARGIN;

  if (!noLegend) {
    // Draw legend
    const legend = group
      .selectAll('.legend')
      .data(allSectionData)
      .enter()
      .append('g')
      .attr('class', 'legend');

    legend
      .append('rect')
      .attr('width', LEGEND_RECT_SIZE)
      .attr('height', LEGEND_RECT_SIZE)
      .style('fill', (d) => color(d.label))
      .style('stroke', (d) => color(d.label));

    legend
      .append('text')
      .attr('x', LEGEND_RECT_SIZE + LEGEND_SPACING)
      .attr('y', LEGEND_RECT_SIZE - LEGEND_SPACING)
      .text((d) => {
        if (db.getShowData()) {
          return `${d.label} [${d.value}]`;
        }
        return d.label;
      });

    const longestTextWidth: number = Math.max(
      ...legend
        .selectAll('text')
        .nodes()
        .map((node) => (node as Element)?.getBoundingClientRect().width ?? 0)
    );

    const legendHeight = LEGEND_RECT_SIZE + LEGEND_SPACING;
    const totalLegendHeight = allSectionData.length * legendHeight;

    switch (legendPosition) {
      case 'center':
        legend.attr('transform', (_datum, index: number): string => {
          const offset: number = (legendHeight * allSectionData.length) / 2;
          const horizontal: number = -longestTextWidth / 2;
          const vertical: number = index * legendHeight - offset;
          return 'translate(' + horizontal + ',' + vertical + ')';
        });
        break;
      case 'top':
        chartAndLegendHeight += totalLegendHeight;

        legend.attr('transform', (_datum, index: number): string => {
          const offset: number = radius;
          const horizontal: number = -longestTextWidth / 2;
          const vertical: number = index * legendHeight - offset;
          return `translate(${horizontal}, ${vertical})`;
        });
        pie.attr('transform', (): string => {
          return `translate(0, ${totalLegendHeight + legendHeight})`;
        });
        break;
      case 'bottom':
        chartAndLegendHeight += totalLegendHeight;

        legend.attr('transform', (_datum, index: number): string => {
          const offset: number = -radius - legendHeight;
          const horizontal: number = -longestTextWidth / 2;
          const vertical: number = index * legendHeight - offset;
          return 'translate(' + horizontal + ',' + vertical + ')';
        });
        break;
      case 'left':
        chartAndLegendWidth += longestTextWidth;

        legend.attr('transform', (_datum, index: number): string => {
          const offset: number = (legendHeight * allSectionData.length) / 2;
          const horizontal: number = -radius - legendHeight;
          const vertical: number = index * legendHeight - offset;
          return 'translate(' + horizontal + ',' + vertical + ')';
        });
        pie.attr('transform', (): string => {
          return `translate(${longestTextWidth + legendHeight}, 0)`;
        });
        break;
      default:
        chartAndLegendWidth += longestTextWidth;

        legend.attr('transform', (_datum, index: number): string => {
          const offset: number = (legendHeight * allSectionData.length) / 2;
          const horizontal: number = radius + legendHeight;
          const vertical: number = index * legendHeight - offset;
          return 'translate(' + horizontal + ',' + vertical + ')';
        });
        break;
    }
  }

  // Measure title width to ensure it's not clipped
  const titleWidth = (titleText.node() as Element)?.getBoundingClientRect().width ?? 0;

  // Title is centered at pieWidth/2 in SVG coords — expand viewBox to contain it
  const titleLeft = pieWidth / 2 - titleWidth / 2;
  const titleRight = pieWidth / 2 + titleWidth / 2;

  const viewBoxX = Math.min(0, titleLeft);
  const viewBoxRight = Math.max(chartAndLegendWidth, titleRight);
  const totalWidth = viewBoxRight - viewBoxX;
  const totalHeight = Math.max(chartAndLegendHeight, height);

  svg.attr('viewBox', `${viewBoxX} 0 ${totalWidth} ${totalHeight}`);
  configureSvgSize(svg, totalHeight, totalWidth, pieConfig.useMaxWidth);
};

export const renderer = { draw };
