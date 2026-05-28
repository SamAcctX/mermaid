/**
 * Configuration constants for the Swimlanes layout algorithm.
 * Centralizes all magic numbers and default values for maintainability.
 */

/**
 * Edge routing and spacing constants
 */
export const EDGE_ROUTING = {
  /** Spacing between parallel edges in the same corridor (px) */
  EDGE_GAP: 12,

  /** Horizontal offset from lane boundary to corridor center (px) */
  LANE_MARGIN: 20,
} as const;

/**
 * Numerical precision constants
 */
export const PRECISION = {
  /** Epsilon for floating-point comparisons */
  EPSILON: 1e-6,
} as const;

/**
 * Layer ordering constants
 */
export const ORDERING = {
  /** Default number of sweep iterations for crossing minimization */
  DEFAULT_SWEEPS: 3,

  /** Default heuristic for vertex ordering */
  DEFAULT_HEURISTIC: 'median' as const,

  /** Whether to use transpose improvement by default */
  DEFAULT_USE_TRANSPOSE: true,
} as const;

/**
 * Layer assignment constants
 */
export const LAYERING = {
  /** Default number of iterations for gravity-based layering */
  GRAVITY_ITERATIONS: 8,

  /** Maximum number of passes for crossing-based rank optimization */
  MAX_CROSSING_OPTIMIZATION_PASSES: 4,

  /** Whether to compact single-input nodes by default */
  DEFAULT_COMPACT_SINGLE_INPUT: true,
} as const;

/**
 * Coordinate assignment constants
 */
export const COORDINATES = {
  /** Default vertical gap between layers (px) */
  DEFAULT_LAYER_GAP: 100,

  /** Default horizontal gap between nodes (px) */
  DEFAULT_NODE_GAP: 40,

  /** Whether to straighten long edges by default */
  DEFAULT_STRAIGHTEN_LONG_EDGES: true,
} as const;

/**
 * Cycle removal constants
 */
export const CYCLE_REMOVAL = {
  /** Default heuristic for cycle removal */
  DEFAULT_HEURISTIC: 'dfs' as const,
} as const;
