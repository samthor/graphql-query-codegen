
GraphQL query code generator for TypeScript types.
This generates code specific to provided queries.

## Example

You might have a model like this:

```graphql
# model.graphql
type Query {
  getFoo(a: Int) {
    b
    c
  }
}
```

But want to write a query with a limited selection:

```graphql
# query.graphql
query GetFoo {
  getFoo(a: 123) {
    b
  }
}
```

This library will generate limited types for you.
It can be run either as a binary or as a library.
For use as a binary, run:

```bash
$ graphql-query-codegen -q query.graphql model.graphql
```

You can also specify `--loose` to be less restrictive on checks, and `-s ScalarName:tsTypeName` to specify a scalar resolution.
(e.g., `-s AWSDateTime:string` tells this code to render `AWSDateTime` as a `string`).

## Library

You can also import this library.
It exports a `Builder` class which is typed.

## Known Issues

### Input Validation

This library doesn't check that the input types of variables match the expected values in field arguments.
For example, this is still allowed:

```graphql
type Query {
  getFoo(a: Int!) {
    b
    c
  }
}

# This probably shouldn't pass: String is not Int.
# ...(although GraphQL treats both as "scalars" anyway)
query GetFoo($a: String!) {
  getFoo(a: $a) {
    b
  }
}
```

### Unions & Fragments

These features are not yet supported.
