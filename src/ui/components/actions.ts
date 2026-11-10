import {
  BriefcaseMedical,
  CalendarDays,
  CalendarX,
  ClipboardList,
  CupSoda,
  DropletOff,
  Fan,
  GlassWater,
  Gauge,
  Hand,
  HandHelping,
  Hospital,
  PhoneCall,
  Repeat2,
  Snowflake,
  Stethoscope,
  Sun,
  Timer,
  Umbrella,
  UserRoundCheck,
  Users,
  Watch,
  type LucideIcon,
} from 'lucide-react'
import type { ActionId } from '../../engine/types'

/**
 * Pictogram for every recommended action. The `Record<ActionId, …>` type makes the map exhaustive at compile time, so an
 * action added to engine/types.ts cannot ship without an icon. Every use pairs the icon with a localised text label
 * (WCAG 2.2 SC 1.1.1 Non-text Content and SC 1.4.1 Use of Color). Action semantics follow ARCHITECTURE.md §5 (actions
 * derived from the level and its driving channels) and §1 principle 4 (emergency: call 998, cool first, transport
 * second). Icon choices are [ENG]:
 * - stop_work uses the same raised hand as the `stop` level, so the instruction and the level read as one;
 * - cool_first (whole-body cold-water cooling before transport) uses a snowflake, kept distinct from the fan of the
 *   routine cool_down;
 * - check_sensor uses a wrist-worn device, the sensor a worker is asked to check;
 * - restrict_fluids (suspected over-drinking, ARCHITECTURE.md §5 hydration channel) uses a struck-through drop.
 */
export const ACTION_ICONS: Readonly<Record<ActionId, LucideIcon>> = {
  drink_water: GlassWater,
  shade_breaks: Timer,
  reduce_intensity: Gauge,
  rotate_task: Repeat2,
  rest_shade_now: Umbrella,
  cool_down: Fan,
  stop_work: Hand,
  buddy_check: UserRoundCheck,
  first_aider_check: BriefcaseMedical,
  call_998: PhoneCall,
  cool_first: Snowflake,
  stay_with_worker: HandHelping,
  midday_break: Sun,
  acclimatization_plan: CalendarDays,
  occ_health_review: Stethoscope,
  check_sensor: Watch,
  symptom_checkin: ClipboardList,
  no_lone_work: Users,
  electrolytes: CupSoda,
  restrict_fluids: DropletOff,
  medical_evaluation: Hospital,
  no_hot_work_today: CalendarX,
}
