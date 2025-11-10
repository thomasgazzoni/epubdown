/**
 * Configuration options for the RenderQueue.
 */
export interface RenderQueueConfig {
  /**
   * Number of pages to pre-render ahead of and behind the current page.
   *
   * - lookaheadDistance = 0: Only render the current page
   * - lookaheadDistance = 1: Render current page ± 1 (3 pages total)
   * - lookaheadDistance = 2: Render current page ± 2 (5 pages total)
   *
   * @default 1
   */
  lookaheadDistance: number;

  /**
   * Maximum number of tasks allowed in the queue at once.
   * This prevents runaway queues in edge cases.
   *
   * @default 10
   */
  maxQueueSize: number;

  /**
   * Enable debug logging to console.
   * Logs enqueue, dequeue, and cancellation operations.
   *
   * @default true
   */
  debug?: boolean;
}

/**
 * Default configuration for the RenderQueue.
 */
export const defaultRenderQueueConfig: RenderQueueConfig = {
  lookaheadDistance: 1,
  maxQueueSize: 10,
  debug: true,
};

/**
 * Merge user configuration with defaults.
 *
 * @param userConfig - Partial configuration to override defaults
 * @returns Complete configuration with defaults filled in
 */
export function mergeRenderQueueConfig(
  userConfig?: Partial<RenderQueueConfig>,
): RenderQueueConfig {
  return {
    ...defaultRenderQueueConfig,
    ...userConfig,
  };
}
