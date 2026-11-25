// Regresión de «l is not a function» (1.0.9): React guarda lo que devuelve un efecto como función
// de limpieza y la llama al desmontar o al volver a ejecutarlo. Un efecto con cuerpo de expresión
// (`useEffect(() => el.scrollIntoView())`) devuelve el valor de esa llamada; en WebView2 reciente
// `scrollIntoView()` devuelve una Promise y la limpieza fallaba. Los tipos del DOM no lo detectan.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const files = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.ts', '!/src/**/*.test.tsx'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** Llamadas cuyo valor es, por convenio del proyecto, la función de limpieza (`register…`, `subscribe…`). */
const RETURNS_CLEANUP = /^(register|subscribe|listen|watch|on)[A-Z]?\w*$/;

/** Efectos cuyo callback es una flecha con cuerpo de expresión que no es una función de limpieza. */
function riskyEffects(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(React\.)?use(Layout|Insertion)?Effect$/.test(node.expression.getText(source))) {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
        let body: ts.Node = callback.body;
        while (ts.isParenthesizedExpression(body)) body = body.expression;
        const cleanup = ts.isArrowFunction(body) || ts.isFunctionExpression(body) || ts.isVoidExpression(body)
          || (ts.isCallExpression(body) && ts.isIdentifier(body.expression) && RETURNS_CLEANUP.test(body.expression.text));
        if (!cleanup) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          found.push(`${file}:${line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('efectos de React', () => {
  it('se analiza el código de la aplicación', () => {
    expect(Object.keys(files).length).toBeGreaterThan(100);
  });

  it('no devuelven valores que React confundiría con la función de limpieza', () => {
    expect(Object.entries(files).flatMap(([file, text]) => riskyEffects(file, text))).toEqual([]);
  }, 30_000);

  it('detecta el patrón que causó el fallo de Live Preview', () => {
    const bad = 'useLayoutEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [n]);';
    expect(riskyEffects('x.tsx', bad)).toHaveLength(1);
    expect(riskyEffects('x.tsx', 'useEffect(() => () => off(), []);')).toHaveLength(0);
  });
});
