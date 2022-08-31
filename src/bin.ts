
import mri from 'mri';
import * as fs from 'fs';
import { Builder, graphql } from './index';
import { BuilderOptions } from './lib';

const args = mri(process.argv.slice(2), {
  alias: {
    'q': 'query',
    'l': 'loose',
    's': 'scalar',
  },
  string: ['query', 'scalar'],
  boolean: ['loose'],
});

if (!args.query || !args._.length) {
  process.stderr.write(`usage: ${process.argv[1]} -q <queryfile> <modelfile> [<modelfile>...]\n`);
  process.exit(1);
}


const options: Partial<BuilderOptions> = {};

if (args.loose) {
  options.allowInvalidShape = true;
  options.allowMissingFields = true;
  options.allowUnknownTypes = true;
}

const b = new Builder(options);

[args.scalar].flat().filter((x) => x).forEach((scalar) => {
  const parts = scalar.split(':');
  if (parts.length > 2) {
    throw new Error(`invalid scalar: ${scalar}`);
  }
  b.addScalar(parts[0], parts[1] || 'any');
});

for (const p of args._) {
  const model = graphql.parse(fs.readFileSync(p, 'utf-8'));
  b.addAllDocument(model);
}

for (const p of [args.query].flat()) {
  const queries = graphql.parse(fs.readFileSync(p, 'utf-8'));
  queries.definitions.forEach((def) => {
    if (def.kind !== graphql.Kind.OPERATION_DEFINITION) {
      return;
    }
    const out = b.renderOp(def);
    process.stdout.write(out);
  });
}
