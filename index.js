/**
 * Host half of dsh-mermaid.
 *
 * All work happens in the browser half (`lib/client.js`). The empty Host apply
 * still matters: the Client module loader only scans packages that are mounted
 * as Host rows, and the empty row is what makes the browser half discoverable.
 */
export function apply() {}
