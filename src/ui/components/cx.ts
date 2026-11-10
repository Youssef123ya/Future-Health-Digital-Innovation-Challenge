/**
 * Joins conditional class names into one string, dropping falsy entries.
 * [ENG] UI utility with no domain basis; kept dependency-free instead of pulling in a class-name library.
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined | 0>): string {
  let out = ''
  for (const part of parts) {
    if (part) out = out ? `${out} ${part}` : part
  }
  return out
}
