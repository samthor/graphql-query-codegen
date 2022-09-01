#!/bin/bash

set -eu

tsx src/bin.ts \
  --query testdata/query-comments.graphql \
  -s foo:bar \
  -s zing:test \
  -s AWSDateTime:string \
  testdata/demo-schema.graphql
