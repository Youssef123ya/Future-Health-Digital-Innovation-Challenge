import type { ViewProps } from '../../App'
import { Placeholder } from '../Placeholder'

/** STUB — replaced in the UI build wave. Active stop/emergency cases, cooling protocol, consented clinical detail for escalated cases. */
export function MedicView({ route }: ViewProps) {
  return <Placeholder route={route} title="First aid & occupational health" purpose="Active stop/emergency cases, cooling protocol, consented clinical detail for escalated cases." />
}
