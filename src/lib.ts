import * as graphql from 'graphql';
import { join, wrap } from './render';


export type BuilderOptions = {

  /**
   * Whether to allow invalid shaped queries, e.g., requesting an object as a scalar or vice-versa.
   * This probably needs {@link BuilderOptions#allowMissingFields} to be set to work for objects.
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

  constructor(options: Partial<BuilderOptions> = {}) {
    this.#options = {
      allowInvalidShape: false,
      allowMissingFields: false,
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
    let namedTypeDef = this.#allTypes[namedTypeName];
    if (!namedTypeDef) {
      // Allow fall-through to built-in scalars.
      const maybeScalar = this.#scalars[namedTypeName];
      if (maybeScalar === undefined) {
        // We can't find the named type (e.g., wants FooBar, can't see it).
        return `/* can't find type=${JSON.stringify(namedTypeName)} */ unknown`;
      }

      // Pretend we have a scalar.
      namedTypeDef = {
        kind: graphql.Kind.SCALAR_TYPE_DEFINITION,
        name: { kind: graphql.Kind.NAME, value: namedTypeName },
      };
    }

    let renderInvalidObject = false;

    switch (namedTypeDef.kind) {
      case graphql.Kind.SCALAR_TYPE_DEFINITION:
        if (sel?.selectionSet) {
          // The user is trying to select a scalar as an object.
          if (this.#options.allowInvalidShape) {
            renderInvalidObject = true;
            break;
          }
          throw new Error(`Can't perform object selection on path=${path}, should be scalar=${namedTypeName}`);
        }
        const actualType = this.#scalars[namedTypeName];
        return actualType ?? `/* can't find scalar=${namedTypeName} */`;

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
          if (this.#options.allowInvalidShape) {
            return `/* invalid shape, should be type=${namedTypeName} */ any`;
          }
          throw new Error(`Can't select ${JSON.stringify(path)}: maps to type ${namedTypeName}, add inner selection`);
        }
        return this.renderMany(namedTypeDef, sel.selectionSet, path);

      case graphql.Kind.ENUM_TYPE_DEFINITION:
        if (sel?.selectionSet) {
          if (this.#options.allowInvalidShape) {
            renderInvalidObject = true;
            break;
          }
          throw new Error(`Can't perform object selection on path=${path}, should be enum=${namedTypeName}`);
        }
        if (!namedTypeDef.values?.length) {
          throw new Error(`No values for enum ${namedTypeName}`);
        }
        return namedTypeDef.values.map((v) => JSON.stringify(v.name.value)).join(' | ');
    }

    // The user tried to request a scalar as an object but due to their flags we render it anyway.
    if (renderInvalidObject) {
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
      if (this.#options.allowMissingFields) {
        return `/* can't find path=${path} */ unknown`;
      }
      throw new Error(`Can't request missing field path=${path}`);
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

    const optional = type.defaultValue !== undefined;
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

    const parts: string[] = [];

    // Render to source again (this removes comments and needless whitespace).
    const originalOpSource = graphql.print(op).replace(/\s+/g, ' ');
    parts.push(`export const ${op.operation}${opName} = ${JSON.stringify(originalOpSource)};`);
    parts.push('');

    const returnTypeSource = this.renderMany(base, op.selectionSet, opName);
    parts.push(`export type ${opName}${base.name.value} = ${returnTypeSource}`);
    parts.push('');

    // These are the variables required to do this query.
    // TODO(samthor): This does not assert that the input is correct for its usages, which would be
    // pretty easy to do.
    if (op.variableDefinitions?.length) {
      const variableParts = op.variableDefinitions.map((v) => this.#renderSingleInputName(v, opName));
      parts.push(`export type ${opName}Variables = ${wrap(variableParts)};`);
    }

    return join(parts);
  }

}


