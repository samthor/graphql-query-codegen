import * as graphql from 'graphql';
import * as fs from 'fs';
import { Builder } from './lib';

const model = graphql.parse(fs.readFileSync('demo-schema.graphql', 'utf-8'));


const b = new Builder();
b.addAllDocument(model);

b.addScalar('AWSDateTime', 'string');




const queries = graphql.parse(fs.readFileSync('query-comments.graphql', 'utf-8'));
queries.definitions.forEach((def) => {
  if (def.kind !== graphql.Kind.OPERATION_DEFINITION) {
    return;
  }

  const out = b.renderOp(def);

  process.stdout.write(out);
});

