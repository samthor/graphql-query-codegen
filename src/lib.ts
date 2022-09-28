import * as graphql from 'graphql';
import { join, wrap } from './render';


export const TYPENAME_FIELD_NAME = '__typename';


export type BuilderOptions = {

  /**
   * Whether to allow invalid shaped queries, e.g., requesting an object as a scalar or vice-versa.
   *
   * @default false
   */
  allowInvalidShape: boolean;

  /**
   * Whether to allow requesting fields that are not present on the model.
   *
   * @default false
   */
  allowMissingFields: boolean;

  /**
   * Whether to allow missing arguments on a function selection, e.g., `getThing(foo: String)`
   * where `foo` is missing.
   *
   * @default false
   */
  allowMissingArguments: boolean;

  /**
   * Whether to allow unknown types, e.g., selection of something valid, but where the underlying
   * type is missing.
   *
   * @default true
   */
  allowUnknownTypes: boolean;

  /**
   * Whether to export the input types in the generated output.
   *
   * @default false
   */
  exportInputTypes: boolean;

  /**
   * If the field __typename is requested, return it as the literal name.
   *
   * @default true
   */
  fixedTypenameField: boolean;

  /**
   * Whether to allow additional unneeded arguments.
   *
   * @default true
   */
  allowAdditionalArguments: boolean;

};


export class Builder {
  #allTypes: { [name: string]: graphql.TypeDefinitionNode } = {};
  #scalars: { [name: string]: string } = {
    'String': 'string',
    'Int': 'number',
    'Float': 'number',
    'Boolean': 'boolean',
    'ID': 'string',
  };
  #options: BuilderOptions;

  /**
   * Temporary context for a render.
   */
  #context?: {
    variables: { [name: string]: graphql.VariableDefinitionNode },
    inputTypesToRender: string[],
  };

  constructor(options: Partial<BuilderOptions> = {}) {
    this.#options = {
      allowInvalidShape: false,
      allowMissingFields: false,
      allowMissingArguments: false,
      allowUnknownTypes: true,
      exportInputTypes: false,
      fixedTypenameField: true,
      allowAdditionalArguments: true,
      ...options,
    };
  }

  /**
   * Adds a scalar that reflects a TS type. This is required even if the document itself contains
   * "scalar Foo", as the GraphQL document knows nothing about what TS type it should be.
   */
  addScalar(name: string, tsType: string) {
    this.#scalars[name] = tsType;
  }

  /**
   * Adds all type definitions from the model document.
   */
  addAllDocument(doc: graphql.DocumentNode) {
    for (const def of doc.definitions) {
      if (!graphql.isTypeDefinitionNode(def)) {
        continue;
      }
      this.addModelType(def);
    }
  }

  /**
   * Adds a single type definition. This throws if a duplicate name is found.
   */
  addModelType(def: graphql.TypeDefinitionNode) {
    if (def.name.value in this.#allTypes) {
      const prev = this.#allTypes[def.name.value];
      throw new Error(`Can't add duplicate type to model: ${def.name.value}`);
    }
    this.#allTypes[def.name.value] = def;
  }

  /**
   * Finds the type that represents the entrypoint into the model, e.g., for "query Foo", this is
   * "type Query".
   */
  getBaseFor(op: graphql.OperationTypeNode): graphql.ObjectTypeDefinitionNode {
    let key = '';

    switch (op) {
      case graphql.OperationTypeNode.QUERY:
        key = 'Query';
        break;
      case graphql.OperationTypeNode.MUTATION:
        key = 'Mutation';
        break;
      default:
        throw new Error(`Unsupported operation: ${op}`);
    }

    const x = this.#allTypes[key];
    if (!x) {
      // The document may not have a Query or Mutation section. Return a dummy value.
      return {
        kind: graphql.Kind.OBJECT_TYPE_DEFINITION,
        name: { kind: graphql.Kind.NAME, value: key },
      };
    } else if (x.kind !== graphql.Kind.OBJECT_TYPE_DEFINITION) {
      throw new Error(`Unexpected type for ${JSON.stringify(key)}: ${x.kind}`);
    }

    return x;
  }

  #internalRenderSingleType(
    type: graphql.NamedTypeNode,
    sel: graphql.FieldNode | graphql.InlineFragmentNode | undefined,
    path: string,
  ): string {
    let renderInvalidObject = false;
    let renderInvalidScalar = false;

    // Now, we have a named type.
    const namedTypeName = type.name.value;
    let namedTypeDef = this.#allTypes[namedTypeName];

    resolvedUnknown:
    if (!namedTypeDef) {
      // Allow fall-through to built-in scalars.
      const maybeScalar = this.#scalars[namedTypeName];
      if (!sel?.selectionSet && maybeScalar !== undefined) {
        namedTypeDef = {
          kind: graphql.Kind.SCALAR_TYPE_DEFINITION,
          name: { kind: graphql.Kind.NAME, value: namedTypeName },
        };
        break resolvedUnknown;
      }

      if (!this.#options.allowUnknownTypes) {
        throw new Error(`Can't find unknown type=${namedTypeName}`);
      }

      // If the user didn't request anything under this, pretend it's a scalar.
      if (!sel?.selectionSet) {
        return `/* can't find scalar type=${JSON.stringify(namedTypeName)} */ unknown`;
      }

      // Otherwise, pretend it's an object we know nothing about.
      // TODO: this needs duplicate flags to work...
      namedTypeDef = {
        kind: graphql.Kind.OBJECT_TYPE_DEFINITION,
        name: { kind: graphql.Kind.NAME, value: namedTypeName },
      };
    }

    switch (namedTypeDef.kind) {
      case graphql.Kind.SCALAR_TYPE_DEFINITION:
        if (sel?.selectionSet) {
          // The user is trying to select a scalar as an object.
          renderInvalidObject = true;
          break;
        }
        const actualType = this.#scalars[namedTypeName];
        return actualType ?? `/* can't find scalar=${namedTypeName} */ any`;

      case graphql.Kind.INPUT_OBJECT_TYPE_DEFINITION:
        if (sel !== undefined) {
          throw new Error(`Can't use an input object type ...`);
        }
        return this.renderManyInput(namedTypeDef, path);

      case graphql.Kind.OBJECT_TYPE_DEFINITION:
        if (sel === undefined) {
          // Sel being undefined means this is an input type request, so this is invalid.
          throw new Error(`Can't use an object type as an input type: use "input ...".`);
        } else if (!sel.selectionSet) {
          renderInvalidScalar = true;
          break;
        }
        return this.renderMany(namedTypeDef, sel.selectionSet, path);

      case graphql.Kind.ENUM_TYPE_DEFINITION:
        if (sel?.selectionSet) {
          renderInvalidObject = true;
          break;
        }
        if (!namedTypeDef.values?.length) {
          throw new Error(`No values for enum ${namedTypeName}`);
        }
        return namedTypeDef.values.map((v) => JSON.stringify(v.name.value)).join(' | ');

      case graphql.Kind.UNION_TYPE_DEFINITION: {
        // TODO: reuse for interface

        if (!sel?.selectionSet) {
          // The user is trying to select a union as a scalar. By the spec, unions are not allowed
          // to include scalars.
          renderInvalidScalar = true;
          break;
        }

        // - namedTypedDef is the type we're pointing to (e.g. "union X = A | B")
        // - sel.selectionSet.selections is what we actually want
        return this.renderMany(namedTypeDef, sel.selectionSet, path);
      }
    }

    // The user tried to request an object as a scalar.
    if (renderInvalidScalar) {
      if (!this.#options.allowInvalidShape) {
        throw new Error(`Can't select ${JSON.stringify(path)}: maps to scalar ${namedTypeName}, add inner selection`);
      }
      return `/* invalid shape, should be object type=${namedTypeName} */ any`;
    }

    // The user tried to request a scalar as an object but due to their flags we render it anyway.
    if (renderInvalidObject) {
      if (!this.#options.allowInvalidShape) {
        throw new Error(`Can't perform object selection on path=${path}, should be scalar=${namedTypeName}`);
      }

      const inner = this.renderMany({
        kind: graphql.Kind.OBJECT_TYPE_DEFINITION,
        name: { kind: graphql.Kind.NAME, value: '' },
      }, sel!.selectionSet!, path);
      return `/* invalid shape, should be scalar=${namedTypeName} */ ${inner}`;
    }

    return `/* unsupported kind=${namedTypeDef.kind} */ any`;
  }

  renderSingleType(
    type: graphql.TypeNode | undefined,
    sel: graphql.FieldNode | undefined,
    path: string,
  ) {
    if (type === undefined) {
      // We can't find the named field inside a type (e.g., missing the Query listing).
      if (sel?.name.value === TYPENAME_FIELD_NAME) {
        return `string`;
      }
      if (this.#options.allowMissingFields) {
        return `/* can't find path=${path} */ unknown`;
      }
      throw new Error(`Can't request missing field path=${path}`);
    }

    // Deal with nullability, which is inversed in JS. Wrap in `(null | ...)` if we _can't_ find
    // the non-null type wrapper.
    const nullable = (type.kind !== graphql.Kind.NON_NULL_TYPE);
    const innerType = nullable ? type : type.type;
    const render = nullable ? (x: string) => `${x} | null` : (x: string) => x;

    if (innerType.kind === graphql.Kind.LIST_TYPE) {
      const inner = this.renderSingleType(innerType.type, sel, path + '[]');
      return render(`Array<${inner}>`);
    }

    // At this point, we're always a named type.
    // If this is an input, we need to extract the type.
    let inner;
    if (sel === undefined && this.#allTypes[innerType.name.value]?.kind === graphql.Kind.INPUT_OBJECT_TYPE_DEFINITION) {
      inner = innerType.name.value;
      this.#context!.inputTypesToRender.push(inner);
    } else {
      inner = this.#internalRenderSingleType(innerType, sel, path);
    }

    return render(inner);
  }

  #renderSingleInputName(
    type: graphql.InputValueDefinitionNode | graphql.VariableDefinitionNode,
    path: string,
  ) {
    const nullable = (type.type.kind !== graphql.Kind.NON_NULL_TYPE);
    let name: string;
    if (type.kind === graphql.Kind.INPUT_VALUE_DEFINITION) {
      name = type.name.value;
    } else {
      name = type.variable.name.value;
    }

    const o = this.renderSingleType(type.type, undefined, path + `.${name}`);

    // Inputs that are nullable are optional, since GraphQL will insert nulls!
    const optional = nullable || type.defaultValue !== undefined;
    return `${name}${optional ? '?' : ''}: ${o};`;
  }

  renderManyInput(
    type: graphql.InputObjectTypeDefinitionNode,
    path: string,
  ) {
    const lines = (type.fields ?? []).map((f) => this.#renderSingleInputName(f, path));
    return wrap(lines);
  }

  // #typeFromValue(
  //   value: graphql.ValueNode,
  // ) {
  //   switch (value.kind) {
  //     case graphql.Kind.VARIABLE: {
  //       const name = value.name.value;
  //       const variable = this.#context!.variables[name];

  //       if (!variable) {
  //         throw new Error(`Missing source variable=${name}`);
  //       }

  //       return variable.type;
  //     }

  //     case graphql.Kind.NULL:
  //       return null;

  //     case graphql.Kind.INT:
  //     case graphql.Kind.FLOAT:
  //     case graphql.Kind.STRING:
  //     case graphql.Kind.BOOLEAN:
  //       // TODO: this is a scalar
  //       return;

  //     case graphql.Kind.ENUM:
  //     case graphql.Kind.LIST:
  //     case graphql.Kind.OBJECT:
  //   }

  //   value.kind
  // }

  #checkTypeCompat(
    req: graphql.TypeNode,
    value: graphql.ValueNode,
    path: string,
  ) {

    // nb. We don't really care about nulls in 'req', because something has been provided.
    // Maybe for nested types?

    let requiredType = unwrapNonNullType(req);
    const providedValue = value;
    // TODO: we need to infer provided type from variable - what is it? we don't care _what value_ it has
    const providedType = value.kind;

    if (providedValue.kind === graphql.Kind.VARIABLE) {
      const name = providedValue.name.value;
      const variable = this.#context!.variables[name];

      if (!variable) {
        throw new Error(`Missing source variable=${name} for path=${path}`);
      }

      // TODO: We now have the _type_ of the source varibale, not an actual value.
    }

    // TODO: check type is valid

    // Short-circuit for list. Call ourselves again for every item in the list.
    // TODO: We vaguely should support unions here.
    if (requiredType.kind === graphql.Kind.LIST_TYPE) {
      if (providedValue.kind !== graphql.Kind.LIST) {
        throw new Error(`Cannot satisfy list requirement for path=${path}, was provided=${providedValue.kind}`);
      }
      for (const value of providedValue.values) {
        this.#checkTypeCompat(requiredType.type, value, path);
      }
      return;
    }
  }

  /**
   * Checks the list of field arguments (requirements) against the provided list.
   */
  #checkFieldArguments(
    req: readonly graphql.InputValueDefinitionNode[] | undefined,
    args: readonly graphql.ArgumentNode[] | undefined,
    path: string,
  ) {
    const fieldArguments: { [name: string]: graphql.InputValueDefinitionNode } = Object.fromEntries(
      (req ?? []).map((arg) => [arg.name.value, arg])
    );

    // Ensure that we're providing the required arguments here.
    for (const arg of args ?? []) {
      const req = fieldArguments[arg.name.value];
      if (req === undefined) {
        if (!this.#options.allowAdditionalArguments) {
          throw new Error(`can't select path=${path}, additional argument passed=${arg.name.value}`);
        }
      }
      this.#checkTypeCompat(req.type, arg.value, path + `.${arg.name.value}`);
      delete fieldArguments[arg.name.value];
    }

    // We don't require values that have a default or allow nulls.
    for (const fieldArgument of [...Object.values(fieldArguments)]) {
      if (fieldArgument.defaultValue || fieldArgument.type.kind !== graphql.Kind.NON_NULL_TYPE) {
        delete fieldArguments[fieldArgument.name.value];
      }
    }

    // If we're missing anything then explode now.
    const missingArguments = Object.keys(fieldArguments);
    if (missingArguments.length && !this.#options.allowMissingArguments) {
      throw new Error(`Can't select path=${path}, missing arguments=${missingArguments.join(',')}`);
    }
  }

  renderMany(
    type: graphql.ObjectTypeDefinitionNode | graphql.UnionTypeDefinitionNode,
    set: graphql.SelectionSetNode,
    path: string,
  ) {
    const extraFragmentParts: string[] = [];
    let selections = set.selections;

    // If __typename is in the outer part of a fragment selection, then we actually want to clone
    // it into the fragment branches.
    if (this.#options.fixedTypenameField) {
      selections = maybeCopyTypenameToInlineFragments(selections);
    }

    const lines = selections.map((sel) => {
      switch (sel.kind) {
        case graphql.Kind.FIELD: {
          const name = sel.name.value;

          if (type.kind === graphql.Kind.UNION_TYPE_DEFINITION) {
            const { types = [] } = type;

            // This is requesting a common field on a union type.
            // We render each sub-type and confirm they're the same.
            const possibleUnionOptions = types.map((type) => {
              const namedTypeDef = this.#allTypes[type.name.value];
              if (namedTypeDef.kind !== graphql.Kind.OBJECT_TYPE_DEFINITION) {
                // The spec says these have to be objects.
                throw new Error(`Found union containing non-object type: ${namedTypeDef.kind}`);
              }

              const field = namedTypeDef.fields?.find((x) => x.name.value === sel.name.value);
              this.#checkFieldArguments(field?.arguments, sel.arguments, path);

              return this.renderSingleType(field?.type, sel, path + `.${name}`);
            });

            const check = possibleUnionOptions[0];
            for (let i = 1; i < possibleUnionOptions.length; ++i) {
              if (check !== possibleUnionOptions[i]) {
                if (!this.#options.allowUnknownTypes) {
                  throw new Error(`got disjoint types on union selection: expected=${JSON.stringify(check)}, was ${JSON.stringify(possibleUnionOptions[i])}`);
                }
                return `${name}: /* inconsistent subtypes from union */ any;`;
              }
            }

            return `${name}: ${check};`;
          }

          const field = type?.fields?.find((x) => x.name.value === sel.name.value);
          this.#checkFieldArguments(field?.arguments, sel.arguments, path);

          // Short-circuit: the typename exists even without being in the schema.
          if (this.#options.fixedTypenameField && !field && sel.name.value === TYPENAME_FIELD_NAME) {
            return `${name}: ${JSON.stringify(type.name.value)};`;
          }

          return `${name}: ${this.renderSingleType(field?.type, sel, path + `.${name}`)};`;
        }
        case graphql.Kind.INLINE_FRAGMENT: {
          // This renders the inner fragment (e.g., "... on Foo { bar }") so we can merge it below.
          const t = this.#internalRenderSingleType(sel.typeCondition!, sel, path + `.${sel.typeCondition!.name.value}`);
          extraFragmentParts.push(t);
          return '';
        };
        default: {
          throw new Error(`only plain fields supported, found: ${sel.kind}`);
        }
      }
    }).filter((x) => x);

    // If this isn't one of the top-level types, include a hint as to what it is.
    const commentValue = type.name.value;
    if (!['Query', 'Mutation', 'Subscription'].includes(commentValue)) {
      lines.unshift(`// ${commentValue}`);
    }

    const w = wrap(lines);
    if (extraFragmentParts.length) {
      const extra = extraFragmentParts.join(' | ');
      return `(${w} & (${extra}))`;
    }
    return w;
  }

  /**
   * Renders an operation (e.g., a query or mutation) based on the current model information in
   * this {@link Builder}. This returns a chunk of TS code which includes the original query as
   * a variable, and types of its arguments and return type.
   */
  renderOp(op: graphql.OperationDefinitionNode) {
    if (!op.name) {
      throw new Error(`Cannot generate code for unnamed operation: ${op.operation}`);
    }
    const opName = op.name.value;
    const base = this.getBaseFor(op.operation);

    // e.g. "GetComments" => "getComments".
    const varName = opName.substring(0, 1).toLowerCase() + opName.substring(1);

    const parts: string[] = [];

    // Render to source again (this removes comments and needless whitespace).
    const originalOpSource = graphql.print(op).replace(/\s+/g, ' ');
    parts.push(`export const ${varName} = ${JSON.stringify(originalOpSource)};`);
    parts.push('');

    // We pull out the variables and store as context so we can check that they're of the correct
    // type and are provided for the query.
    const variables: { [name: string]: graphql.VariableDefinitionNode } = {};
    if (op.variableDefinitions?.length) {
      for (const v of op.variableDefinitions) {
        variables[v.variable.name.value] = v;
      }
    }

    try {
      this.#context = { variables, inputTypesToRender: [] };

      const returnTypeSource = this.renderMany(base, op.selectionSet, opName);
      parts.push(`export type ${opName}${base.name.value} = ${returnTypeSource}`);
      parts.push('');

      // These are the variables required to do this query.
      const variableParts = (op.variableDefinitions ?? []).map((v) => this.#renderSingleInputName(v, opName));
      parts.push(`export type ${opName}${base.name.value}Variables = ${wrap(variableParts)};`);

      const code = join(parts);
      const deps = this.#context.inputTypesToRender;

      return { code, deps };

    } finally {
      this.#context = undefined;
    }
  }

  /**
   * Renders dependent types (does not export them). This is needed for input types.
   */
  renderDepTypes(names: Iterable<string>) {
    const parts: string[] = [];

    try {
      this.#context = { variables: {}, inputTypesToRender: [...names] };

      // Input types can be recursive (well, so can results) in a way that means we have to include
      // additional type information. This renders them but allows each re-render to provide more
      // that we continue to render, etc.
      const seenInputTypes = new Set<string>();
      for (; ;) {
        const next = this.#context!.inputTypesToRender.shift();
        if (next === undefined) {
          break;
        } else if (seenInputTypes.has(next)) {
          continue;
        }
        seenInputTypes.add(next);

        const t = this.#allTypes[next];
        if (t === undefined) {
          throw new Error(`Can't render unknown input type: ${next}`);
        } else if (t.kind !== graphql.Kind.INPUT_OBJECT_TYPE_DEFINITION) {
          throw new Error(`Can't render non-object input type: ${next}`);
        }
        const inner = this.renderManyInput(t, '');
        const exportKeyword = this.#options.exportInputTypes ? 'export ' : '';
        parts.push(`${exportKeyword}type ${next} = ${inner};`)
        parts.push('');
      }

      parts.pop();
      const code = join(parts);
      return { code, deps: [...seenInputTypes] };

    } finally {
      this.#context = undefined;
    }
  }

}


/**
 * Copy any found selection of "__typename" to any inline fragments.
 */
const maybeCopyTypenameToInlineFragments = (all: readonly graphql.SelectionNode[]): readonly graphql.SelectionNode[] => {
  let typenameField: graphql.FieldNode | null = null;
  let hasFragment = false;

  all.forEach((x) => {
    if (x.kind === graphql.Kind.FIELD && x.name.value === TYPENAME_FIELD_NAME) {
      typenameField = x;
    } else if (x.kind === graphql.Kind.INLINE_FRAGMENT) {
      hasFragment = true;
    }
  });
  if (!typenameField || !hasFragment) {
    return all;
  }

  return all.map((s) => {
    if (s.kind !== graphql.Kind.INLINE_FRAGMENT) {
      return s;
    }

    const alreadyHasTypename = s.selectionSet.selections.find((n) => n.kind === graphql.Kind.FIELD && n.name.value === TYPENAME_FIELD_NAME);
    if (alreadyHasTypename) {
      return s;
    }

    console.info('copying');
    return {
      ...s,
      selectionSet: {
        ...s.selectionSet,
        selections: [
          {
            kind: graphql.Kind.FIELD,
            name: { kind: graphql.Kind.NAME, value: TYPENAME_FIELD_NAME },
          },
          ...s.selectionSet.selections,
        ],
      },
    };
  });

}


/**
 * Removes {@link graphql.Kind.NON_NULL_TYPE} from this type node.
 */
const unwrapNonNullType = (t: graphql.TypeNode): graphql.NamedTypeNode | graphql.ListTypeNode => {
  if (t.kind == graphql.Kind.NON_NULL_TYPE) {
    return t.type;
  }
  return t;
};
