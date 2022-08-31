import * as fs from 'fs';
import { Builder, graphql } from './src';

const model = graphql.parse(fs.readFileSync('testdata/demo-schema.graphql', 'utf-8'));


const b = new Builder({
  allowInvalidShape: false,
});
b.addAllDocument(model);

b.addScalar('AWSDateTime', 'string');




const queries = graphql.parse(fs.readFileSync('testdata/query-comments.graphql', 'utf-8'));
queries.definitions.forEach((def) => {
  if (def.kind !== graphql.Kind.OPERATION_DEFINITION) {
    return;
  }

  const out = b.renderOp(def);
  process.stdout.write(out);
});

