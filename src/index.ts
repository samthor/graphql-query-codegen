import * as graphql from 'graphql';
import * as fs from 'fs';

/**
 * We re-export graphql so you can be confident it's the same version.
 */
export { graphql };

import { Builder, BuilderOptions } from './lib';
export * from './lib';

/**
 * Run the code generator and generate all dependent types.
 */
export function runAllBuilder(args: {
  options?: Partial<BuilderOptions>,
  model: string | string[],
  query: string | string[],
  scalars?: { [name: string]: string },
}) {
  const parts: string[] = [];
  const b = new Builder(args.options);

  for (const p of [args.model].flat()) {
    const model = graphql.parse(fs.readFileSync(p, 'utf-8'));
    b.addAllDocument(model);
  }

  for (const [key, value] of Object.entries(args.scalars ?? {})) {
    b.addScalar(key, value);
  }

  const allDeps: string[] = [];
  for (const p of [args.query].flat()) {
    const queries = graphql.parse(fs.readFileSync(p, 'utf-8'));
    queries.definitions.forEach((def) => {
      if (def.kind !== graphql.Kind.OPERATION_DEFINITION) {
        return;
      }
      const { code, deps } = b.renderOp(def);
      allDeps.push(...deps);
      parts.push(code);
    });
  }

  const { code } = b.renderDepTypes(allDeps);
  parts.push(code);

  return parts.join('');
}
