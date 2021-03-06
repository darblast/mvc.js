/// <reference path="../Common.ts" />
/// <reference path="Lexer.ts" />
/// <reference path="AST.ts" />


namespace MVC {
export namespace Expressions {


export class Parser {
  private readonly _lexer: Lexer;

  private static readonly _BINARY_OPERATOR_PRECEDENCE_TABLE: [boolean, string[]][] = [
    [false, ['**']],
    [true, ['*', '/', '%']],
    [true, ['+', '-']],
    [true, ['<<', '>>', '>>>']],
    [true, ['<', '<=', '>', '>=', 'in']],
    [true, ['==', '!=', '===', '!==']],
  ];

  public constructor(public readonly input: string) {
    this._lexer = new Lexer(input);
    this._lexer.next();  // the first token is always "begin"
  }

  private _parseStringLiteral(label: string): string {
    return JSON.parse(label);
  }

  private _parseReferenceComponents(components: PathComponentInterface[]): ReferenceNode {
    switch (this._lexer.token) {
    case 'dot':
      const label = this._lexer.expect('name');
      return this._parseReferenceComponents(components.concat(new FieldComponent(label)));
    case 'left-square':
      this._lexer.next();
      const index = this._parseRoot();
      this._lexer.expect('right-square');
      return this._parseReferenceComponents(components.concat(new SubscriptComponent(index)));
    default:
      return new ReferenceNode(components);
    }
  }

  private _parseReference(): ReferenceNode {
    const label = this._lexer.expect('name');
    return this._parseReferenceComponents([new FieldComponent(label)]);
  }

  private _parseValue(): NodeInterface {
    switch (this._lexer.token) {
    case 'undefined':
      this._lexer.next();
      return new LiteralNode(void 0);
    case 'true':
      this._lexer.next();
      return new LiteralNode(true);
    case 'false':
      this._lexer.next();
      return new LiteralNode(false);
    case 'number':
      return new LiteralNode(parseFloat(this._lexer.step()));
    case 'string':
      return new LiteralNode(this._parseStringLiteral(this._lexer.step()));
    case 'left':
      const node = this._parseRoot();
      this._lexer.expect('right');
      return node;
    default:
      return this._parseReference();
    }
  }

  private _parseUnaryNode(): NodeInterface {
    if ('operator' !== this._lexer.token) {
      return this._parseValue();
    } else {
      const operator = this._lexer.label;
      if (['+', '-', '!'].includes(operator)) {
        this._lexer.next();
        return new UnaryNode(operator, this._parseUnaryNode());
      } else {
        throw new MVC.SyntaxError(this.input);
      }
    }
  }

  private _parseBinaryNode(precedenceIndex: number): NodeInterface {
    if (precedenceIndex < Parser._BINARY_OPERATOR_PRECEDENCE_TABLE.length) {
      const [leftAssociative, operators] = Parser._BINARY_OPERATOR_PRECEDENCE_TABLE[precedenceIndex];
      if (leftAssociative) {
        let node = this._parseBinaryNode(precedenceIndex + 1);
        while (['operator', 'in'].includes(this._lexer.token) &&
            operators.includes(this._lexer.label))
        {
          const operator = this._lexer.step();
          node = new BinaryNode(operator, node, this._parseBinaryNode(precedenceIndex + 1));
        }
        return node;
      } else {
        const left = this._parseBinaryNode(precedenceIndex + 1);
        if (!['operator', 'in'].includes(this._lexer.token) ||
            !operators.includes(this._lexer.label))
        {
          return left;
        } else {
          const operator = this._lexer.step();
          return new BinaryNode(operator, left, this._parseBinaryNode(precedenceIndex));
        }
      }
    } else {
      return this._parseUnaryNode();
    }
  }

  public _parseRoot(): NodeInterface {
    return this._parseBinaryNode(0);
  }

  public parse(): NodeInterface {
    const node = this._parseRoot();
    if (this._lexer.end) {
      return node;
    } else {
      throw new MVC.SyntaxError(this.input);
    }
  }

  private _parseCollectionIteration(name: string): CollectionIterationNode {
    return new CollectionIterationNode(name, this.parse());
  }

  private _parseDictionaryIteration(keyName: string): DictionaryIterationNode {
    const valueName = this._lexer.expect('name');
    this._lexer.expect('in');
    return new DictionaryIterationNode(keyName, valueName, this.parse());
  }

  public parseIteration(): CollectionIterationNode | DictionaryIterationNode {
    const name = this._lexer.expect('name');
    switch (this._lexer.token) {
    case 'comma':
      this._lexer.next();
      return this._parseDictionaryIteration(name);
    case 'in':
      this._lexer.next();
      return this._parseCollectionIteration(name);
    default:
      throw new MVC.SyntaxError(this.input);
    }
  }
}


export function parse(input: string): NodeInterface {
  const parser = new MVC.Expressions.Parser(input);
  return parser.parse();
}


export function interpolate(input: string): InterpolatedNode {
  const fragments: NodeInterface[] = [];
  let text = '';
  for (let i = 0; i < input.length; i++) {
    if ('{' !== input[i]) {
      text += input[i];
    } else if (++i < input.length && '{' === input[i]) {
      fragments.push(new StaticFragmentNode(text));
      fragments.push((function () {
        for (i++, text = ''; i < input.length; i++) {
          if ('}' !== input[i]) {
            text += input[i];
          } else if (++i < input.length && '}' === input[i]) {
            const parser = new Parser(text);
            return parser.parse();
          } else {
            text += '}' + input[i];
          }
        }
        throw new MVC.SyntaxError(input);
      }()));
      text = '';
    } else {
      text += '{' + input[i];
    }
  }
  fragments.push(new StaticFragmentNode(text));
  return new InterpolatedNode(fragments);
}


export type CompiledExpression<ValueType> = (this: Dictionary) => ValueType;


export function compile(expression: NodeInterface): CompiledExpression<any> {
  return <CompiledExpression<any>>(new Function(`return(${expression.compile()});`));
}


export function compileSafe(expression: NodeInterface): CompiledExpression<any> {
  return <CompiledExpression<any>>(new Function(`
    try {
      return (${expression.compile()});
    } catch (e) {
      console.error(e);
    }
  `));
}


export function compileSafeBoolean(expression: NodeInterface): CompiledExpression<boolean> {
  return <CompiledExpression<boolean>>(new Function(`
    try {
      return !!(${expression.compile()});
    } catch (e) {
      console.error(e);
      return false;
    }
  `));
}


export function compileSafeInteger(expression: NodeInterface): CompiledExpression<number> {
  return <CompiledExpression<number>>(new Function(`
    try {
      return ~~(${expression.compile()});
    } catch (e) {
      console.error(e);
      return 0;
    }
  `));
}


export function compileSafeNumber(expression: NodeInterface): CompiledExpression<number> {
  return <CompiledExpression<number>>(new Function(`
    try {
      return +(${expression.compile()});
    } catch (e) {
      console.error(e);
      return 0;
    }
  `));
}


export function compileSafeString(expression: NodeInterface): CompiledExpression<string> {
  return <CompiledExpression<string>>(new Function(`
    try {
      return String(${expression.compile()});
    } catch (e) {
      console.error(e);
      return '';
    }
  `));
}


export function compileSafeCollection(expression: NodeInterface): CompiledExpression<any[]> {
  return <CompiledExpression<any[]>>(new Function(`
    try {
      return [].concat(${expression.compile()});
    } catch (e) {
      console.error(e);
      return [];
    }
  `));
}


export function compileSafeDictionary(expression: NodeInterface): CompiledExpression<Dictionary> {
  return <CompiledExpression<Dictionary>>(new Function(`
    try {
      return (${expression.compile()});
    } catch (e) {
      console.error(e);
      return {};
    }
  `));
}


}  // namespace Expressions
}  // namespace MVC


type CompiledExpression<ValueType> = MVC.Expressions.CompiledExpression<ValueType>;
