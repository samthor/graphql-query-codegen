
import mri from 'mri';
import { Builder, runAllBuilder } from './index';
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

const scalars: { [name: string]: string } = {};
[args.scalar].flat().filter((x) => x).forEach((scalar) => {
  const parts = scalar.split(':');
  if (parts.length > 2) {
    throw new Error(`invalid scalar: ${scalar}`);
  }
  scalars[parts[0]] = parts[1] || 'any';
});

const out = runAllBuilder({ options, model: args._, query: args.query, scalars })
process.stdout.write(out);
