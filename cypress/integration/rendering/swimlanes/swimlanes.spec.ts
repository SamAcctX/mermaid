import { renderGraph } from '../../../helpers/util.ts';

const SWIMLANE_FIXTURE_DIR = 'cypress/platform/dev-diagrams/layout-tests/swimlanes';

const SWIMLANE_FIXTURES = [
  '1-simple.mmd',
  '10-node-placement.mmd',
  '2-decisions-lr.mmd',
  '3-decisions-tb.mmd',
  '4-car-fun-sales-tb.mmd',
  '5-car-fun-sales-wide-tb.mmd',
  '6-legal-constr-sales.mmd',
  '7-car-sales-constr.mmd',
  '8-query-process-2.mmd',
  '9-edge-labels.mmd',
  'commant.mmd',
  'mermaid-work.mmd',
  'query-process.mmd',
  'sales-process.mmd',
  'simple-2.mmd',
];

const shapeSelector = 'rect, polygon, ellipse, circle, path';
const edgePathSelector = 'g.edgePath path.path, g.edgePath path';

const asStandaloneSwimlanes = (source: string): string => {
  const updated = source.replace(/^(\s*)(?:flowchart|graph)(?=\s)/m, '$1swimlanes');
  expect(updated, 'fixture should contain a flowchart/graph header').not.to.eq(source);
  expect(updated, 'fixture should use the standalone swimlanes diagram type').to.match(
    /^\s*swimlanes\s/m
  );
  return updated;
};

const renderSwimlanes = (
  graph: string,
  name: string,
  options: Parameters<typeof renderGraph>[1] = {}
): void => {
  const { flowchart, ...rest } = options;
  renderGraph(graph, {
    screenshot: false,
    logLevel: 0,
    name,
    ...rest,
    flowchart: {
      htmlLabels: false,
      useMaxWidth: false,
      ...flowchart,
    },
  });
};

const assertStandaloneSwimlanesRendered = (): void => {
  cy.get('svg').should('have.attr', 'aria-roledescription', 'swimlanes');
  cy.get('svg .error-icon').should('not.exist');
  cy.get('g.cluster.swimlane').its('length').should('be.greaterThan', 0);
  cy.get('g.node').its('length').should('be.greaterThan', 0);
};

const nodeShape = (label: string): Cypress.Chainable<JQuery<HTMLElement>> => {
  return cy.contains('g.node', label).find(shapeSelector).first();
};

describe('Swimlanes diagram', () => {
  it('covers every swimlanes layout-test fixture', () => {
    cy.task('listSwimlaneFixtures').should('deep.equal', SWIMLANE_FIXTURES);
  });

  SWIMLANE_FIXTURES.forEach((fixture) => {
    it(`renders ${fixture} as a standalone swimlanes diagram`, () => {
      cy.readFile(`${SWIMLANE_FIXTURE_DIR}/${fixture}`, 'utf8').then((source) => {
        renderSwimlanes(asStandaloneSwimlanes(source), `swimlanes-fixture-${fixture}`);
        assertStandaloneSwimlanesRendered();
      });
    });
  });

  it('defaults to the swimlanes layout without an explicit layout config', () => {
    renderSwimlanes(
      `swimlanes LR
        subgraph Intake
          A[Request]
        end
        subgraph Delivery
          B[Build]
        end
        A --> B
      `,
      'swimlanes-default-layout'
    );

    assertStandaloneSwimlanesRendered();
    cy.get('g.cluster.swimlane').should('have.length', 2);
  });

  it('applies custom theme variables', () => {
    renderSwimlanes(
      `swimlanes LR
        subgraph ThemeLane
          A[Themed node]
          B[Next node]
        end
        A --> B
      `,
      'swimlanes-custom-theme',
      {
        theme: 'base',
        themeVariables: {
          mainBkg: '#ffe1ef',
          nodeBorder: '#225577',
          lineColor: '#118844',
        },
      }
    );

    assertStandaloneSwimlanesRendered();
    nodeShape('Themed node').should(($shape) => {
      expect($shape.css('fill')).to.eq('rgb(255, 225, 239)');
      expect($shape.css('stroke')).to.eq('rgb(34, 85, 119)');
    });
    cy.get(edgePathSelector)
      .first()
      .should(($path) => {
        expect($path.css('stroke')).to.eq('rgb(17, 136, 68)');
      });
  });

  it('applies flowchart style and linkStyle statements', () => {
    renderSwimlanes(
      `swimlanes LR
        subgraph StyledLane
          A[Styled node]
          B[Linked node]
        end
        A --> B
        style A fill:#ff99cc,stroke:#003366,stroke-width:5px,color:#111111
        linkStyle 0 stroke:#ff6600,stroke-width:5px
      `,
      'swimlanes-style-statements'
    );

    assertStandaloneSwimlanesRendered();
    nodeShape('Styled node').should(($shape) => {
      expect($shape.css('fill')).to.eq('rgb(255, 153, 204)');
      expect($shape.css('stroke')).to.eq('rgb(0, 51, 102)');
      expect($shape.css('stroke-width')).to.eq('5px');
    });
    cy.get(edgePathSelector)
      .first()
      .should(($path) => {
        expect($path.css('stroke')).to.eq('rgb(255, 102, 0)');
        expect($path.css('stroke-width')).to.eq('5px');
      });
  });

  it('applies classDef and class statements', () => {
    renderSwimlanes(
      `swimlanes LR
        subgraph ClassLane
          A[Classed node]
          B[Default node]
        end
        A --> B
        classDef highlighted fill:#bbf,stroke:#f66,stroke-width:4px,color:#000000
        class A highlighted
      `,
      'swimlanes-classdef'
    );

    assertStandaloneSwimlanesRendered();
    cy.contains('g.node.highlighted', 'Classed node').should('exist');
    nodeShape('Classed node').should(($shape) => {
      expect($shape.css('fill')).to.eq('rgb(187, 187, 255)');
      expect($shape.css('stroke')).to.eq('rgb(255, 102, 102)');
      expect($shape.css('stroke-width')).to.eq('4px');
    });
  });

  it('puts nodes without an explicit subgraph into a default swimlane', () => {
    renderSwimlanes(
      `swimlanes LR
        subgraph OwnedLane
          A[Owned node]
        end
        Loose[Loose node] --> A
      `,
      'swimlanes-default-lane'
    );

    assertStandaloneSwimlanesRendered();
    cy.get('g.cluster.swimlane[data-id="__swimlane_default__"]').should('exist');
    cy.contains('g.node', 'Loose node').should('exist');
  });
});
