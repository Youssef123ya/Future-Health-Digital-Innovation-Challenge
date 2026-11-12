import type { ArmId } from './types'

/**
 * Arm colours, shared by every cohort chart and table so colour follows the arm across the page. The two Zill arms the
 * brief compares take categorical slots 1 (blue) and 2 (orange) of the dataviz reference palette; the arm without a
 * wearable takes slot 3 (aqua, below 3:1 on white: always labelled); baselines are context greys, labelled directly.
 */
export const ARM_COLORS: Readonly<Partial<Record<ArmId, string>>> = {
  ban_only: '#475569',
  site_index: '#94a3b8',
  zill_env: '#1baf7a',
  zill_full: '#2a78d6',
  zill_monitored: '#eb6834',
  shadow_zill_env: '#1baf7a',
  shadow_zill_full: '#2a78d6',
  shadow_zill_monitored: '#eb6834',
}
