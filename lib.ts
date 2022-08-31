import * as graphql from 'graphql';


export class Builder {
  #allTypes: { [name: string]: graphql.TypeDefinitionNode } = {};
  #scalars: { [name: string]: string } = {
    'String': 'string',
    'Int': 'number',
    'Float': 'number',
    'Boolean': 'boolean',
    'ID': 'string',
  };

  addScalar(name: string, tsType: string) {
    this.#scalars[name] = tsType;
  }

  addAllDocument(doc: graphql.DocumentNode) {
    for (const def of doc.definitions) {
      if (!graphql.isTypeDefinitionNode(def) || !def.name.value) {
        continue;
      }
      this.addModelType(def);
    }
  }

  addModelType(def: graphql.TypeDefinitionNode) {
    if (def.name.value in this.#allTypes) {
      const prev = this.#allTypes[def.name.value];
      throw new Error(`Can't add duplicate type to model: ${def.name.value}`);
    }
    this.#allTypes[def.name.value] = def;
  }

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
      // This isn't real but for some reason we're missing it.
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
    type: graphql.NamedTypeNode | graphql.ListTypeNode,
    sel: graphql.FieldNode | undefined,
    path: string,
  ): string {
    if (type.kind === graphql.Kind.LIST_TYPE) {
      const inner = this.renderSingleType(type.type, sel, path + '[]');
      return `Array<${inner}>`;
    }

    // Now, we have a named type.
    const namedTypeName = type.name.value;
    const namedTypeDef = this.#allTypes[namedTypeName];
    if (!namedTypeDef) {
      // Allow fall-through to built-in scalars.
      const maybeScalar = this.#scalars[namedTypeName];
      if (maybeScalar !== undefined) {
        return maybeScalar;
      }

      // We can't find the named type (e.g., wants FooBar, can't see it).
      return `/* can't find type=${JSON.stringify(namedTypeName)} */ unknown`;
    }

    switch (namedTypeDef.kind) {
      case graphql.Kind.SCALAR_TYPE_DEFINITION:
        checkNoSubSelection(sel, path);
        const actualType = this.#scalars[namedTypeName];
        return actualType ?? `/* can't find scalar=${namedTypeName} */`;

      case graphql.Kind.INPUT_OBJECT_TYPE_DEFINITION:
        if (sel !== undefined) {
          throw new Error(`Can't use an input object type ...`);
        }
        return this.renderManyInput(namedTypeDef, path);

      case graphql.Kind.OBJECT_TYPE_DEFINITION:
        if (sel === undefined) {
          // Sel being undefined means this is an input type request, so this is invalid anyway.
          throw new Error(`Can't use an object type as an input type: use "input ...".`);
        } else if (!sel.selectionSet) {
          throw new Error(`Can't select ${JSON.stringify(path)}: maps to type ${namedTypeName}, add inner selection`);
        }
        return this.renderMany(namedTypeDef, sel.selectionSet, path);

      case graphql.Kind.ENUM_TYPE_DEFINITION:
        checkNoSubSelection(sel, path);
        if (!namedTypeDef.values) {
          throw new Error(`No values for enum ${namedTypeName}`);
        }
        return namedTypeDef.values.map((v) => {
          return JSON.stringify(v.name.value);
        }).join(' | ');
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
      return `/* can't find path=${path} */ unknown`;
    }

    // Deal with nullability, which is inversed in JS. Wrap in `(null | ...)` if we _can't_ find
    // the non-null type wrapper.
    if (type.kind === graphql.Kind.NON_NULL_TYPE) {
      return this.#internalRenderSingleType(type.type, sel, path);
    }
    const inner = this.#internalRenderSingleType(type, sel, path);
    return `(${inner} | null)`;
  }

  #renderSingleInputName(
    type: graphql.InputValueDefinitionNode | graphql.VariableDefinitionNode,
    path: string,
  ) {
    let name: string;
    if (type.kind === graphql.Kind.INPUT_VALUE_DEFINITION) {
      name = type.name.value;
    } else {
      name = type.variable.name.value;
    }

    const o = this.renderSingleType(type.type, undefined, path + `.${name}`);

    let optional = type.defaultValue !== undefined;
    return `${name}${optional ? '?' : ''}: ${o};`;
  }

  renderManyInput(
    type: graphql.InputObjectTypeDefinitionNode,
    path: string,
  ) {
    const lines = (type.fields ?? []).map((f) => this.#renderSingleInputName(f, path));
    return wrap(lines);
  }

  renderMany(
    type: graphql.ObjectTypeDefinitionNode,
    set: graphql.SelectionSetNode,
    path: string,
  ) {
    const lines = set.selections.map((sel) => {
      if (sel.kind !== graphql.Kind.FIELD) {
        throw new Error(`only plain fields supported, found: ${sel.kind}`);
      }

      const name = sel.name.value;
      let t = type?.fields?.find((x) => x.name.value === sel.name.value)?.type;

      return `${name}: ${this.renderSingleType(t, sel, path + `.${name}`)};`;
    });

    return wrap(lines);
  }

  renderOp(op: graphql.OperationDefinitionNode) {
    if (!op.name) {
      throw new Error(`Cannot generate code for unnamed operation: ${op.operation}`);
    }
    const opName = op.name.value;
    const base = this.getBaseFor(op.operation);

    const parts: string[] = [];

    // Render to source again (this removes comments and needless whitespace).
    const originalOpSource = graphql.print(op).replace(/\s+/g, ' ');
    parts.push(`export const query_${opName} = ${JSON.stringify(originalOpSource)};`);

    const returnTypeSource = this.renderMany(base, op.selectionSet, opName);
    parts.push(`export type return_${opName} = ${returnTypeSource}`);

    // These are the variables required to do this query.
    // TODO(samthor): This does not assert that the input is correct for its usages, which would be
    // pretty easy to do.
    if (op.variableDefinitions?.length) {
      const variableParts = op.variableDefinitions.map((v) => this.#renderSingleInputName(v, opName));
      parts.push(`export type variables_${opName} = ${wrap(variableParts)};`);
    }

    return join(parts);
  }

}


function wrap(raw: string | string[], indent = '  ') {
  let inner = join(raw, indent);
  if (!inner) {
    return '{}';
  }
  if (inner.endsWith('\n')) {
    inner = inner.substring(0, inner.length - 1);
  }
  return `{\n${inner}}`;
}


function join(raw: string | string[], indent = '') {
  if (Array.isArray(raw)) {
    raw = raw.map((x) => x + '\n').join('');
  }
  raw = raw.split('\n');

  raw = raw.map((line) => {
    line = line.trimEnd();
    return (line ? indent + line : '') + '\n';
  });

  return raw.join('');
}


function checkNoSubSelection(selection: graphql.FieldNode | undefined, path: string) {
  if (selection?.selectionSet !== undefined) {
    throw new Error(`Can't perform selection on path=${path}`);
  }
}
