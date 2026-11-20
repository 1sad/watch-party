/**
 * The port line is the only contract between the sidecar and the .NET host
 * (T1, Method notes): the host reads one line from the sidecar's stdout, and
 * that line says which port the page is on. Both sides are strict on purpose.
 */
export const PORT_LINE_PREFIX = 'PORT '

export function portLine(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`not a port: ${String(port)}`)
  }
  return `${PORT_LINE_PREFIX}${port}`
}
