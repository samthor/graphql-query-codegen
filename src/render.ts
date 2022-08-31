

/**
 * Renders a {} block.
 */
export function wrap(raw: string | string[], indent = '  ') {
  let inner = join(raw, indent);
  if (!inner.trim()) {
    return '{}';
  }
  if (inner.endsWith('\n')) {
    inner = inner.substring(0, inner.length - 1);
  }
  return `{\n${inner}}`;
}


/**
 * Joins the given string data into a number of lines with added indent.
 */
export function join(raw: string | string[], indent = '') {
  if (Array.isArray(raw)) {
    raw = raw.map((x) => x + '\n').join('');
  }
  return raw.split('\n').map((l) => (indent + l).trimEnd() + '\n').join('');
}
