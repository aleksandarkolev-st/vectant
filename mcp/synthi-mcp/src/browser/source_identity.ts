import { createHash } from "node:crypto";
import { relative } from "node:path";

export interface SourceIdentityToken {
  token: string;
  file: string;
  line: number;
  column: number;
  tag: string;
}

export interface SourceIdentityTransformResult {
  code: string;
  tokens: SourceIdentityToken[];
  stats: {
    inserted: number;
    stripped: number;
    preserved: number;
    skipped_custom_components: number;
  };
}

export interface SourceIdentityTransformInput {
  code: string;
  filePath: string;
  root?: string;
  mode?: "inject" | "strip";
}

export interface SynthiViteReactSourceIdentityPlugin {
  name: string;
  enforce: "pre";
  transform(code: string, id: string, options?: { ssr?: boolean }): Promise<{ code: string; map: null } | null>;
}

const SOURCE_ATTR = "data-synthi-source-id";

export async function transformJsxSourceIdentity(input: SourceIdentityTransformInput): Promise<SourceIdentityTransformResult> {
  if (!isJsxLike(input.filePath)) {
    return {
      code: input.code,
      tokens: [],
      stats: { inserted: 0, stripped: 0, preserved: 0, skipped_custom_components: 0 },
    };
  }
  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(input.filePath, input.code, ts.ScriptTarget.Latest, true, scriptKindFor(ts, input.filePath));
  const tokens: SourceIdentityToken[] = [];
  const stats = { inserted: 0, stripped: 0, preserved: 0, skipped_custom_components: 0 };
  const mode = input.mode ?? "inject";

  const transformer: import("typescript").TransformerFactory<import("typescript").SourceFile> = (context) => {
    const visitor = (node: import("typescript").Node): import("typescript").VisitResult<import("typescript").Node> => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = jsxTagName(ts, node.tagName);
        if (!tag) return ts.visitEachChild(node, visitor, context);
        if (!isIntrinsicTag(tag)) {
          stats.skipped_custom_components += 1;
          return ts.visitEachChild(node, visitor, context);
        }
        const existing = node.attributes.properties.find((prop) => jsxAttributeNameIs(ts, prop, SOURCE_ATTR));
        if (mode === "strip") {
          const nextAttributes = node.attributes.properties.filter((prop) => !jsxAttributeNameIs(ts, prop, SOURCE_ATTR));
          if (nextAttributes.length !== node.attributes.properties.length) stats.stripped += 1;
          return updateJsxElement(ts, node, ts.factory.createJsxAttributes(nextAttributes));
        }
        if (existing) {
          stats.preserved += 1;
          return ts.visitEachChild(node, visitor, context);
        }
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const file = input.root ? relative(input.root, input.filePath) || input.filePath : input.filePath;
        const token = tokenFor(file, tag, position.line + 1, position.character + 1);
        tokens.push({ token, file, tag, line: position.line + 1, column: position.character + 1 });
        stats.inserted += 1;
        return updateJsxElement(ts, node, ts.factory.createJsxAttributes([
          ...node.attributes.properties,
          ts.factory.createJsxAttribute(ts.factory.createIdentifier(SOURCE_ATTR), ts.factory.createStringLiteral(token)),
        ]));
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return (node) => ts.visitNode(node, visitor) as import("typescript").SourceFile;
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return {
      code: printer.printFile(transformed.transformed[0] ?? sourceFile),
      tokens,
      stats,
    };
  } finally {
    transformed.dispose();
  }
}

export function createSynthiViteReactSourceIdentityPlugin(options: {
  root?: string;
  enabled?: boolean;
  mode?: "inject" | "strip";
  onTokens?: (filePath: string, tokens: SourceIdentityToken[]) => void;
} = {}): SynthiViteReactSourceIdentityPlugin {
  return {
    name: "synthi:vite-react-source-identity",
    enforce: "pre",
    async transform(code: string, id: string) {
      if (options.enabled === false || !isJsxLike(id)) return null;
      const result = await transformJsxSourceIdentity({
        code,
        filePath: id,
        root: options.root,
        mode: options.mode ?? "inject",
      });
      if (result.stats.inserted === 0 && result.stats.stripped === 0) return null;
      options.onTokens?.(id, result.tokens);
      return { code: result.code, map: null };
    },
  };
}

function updateJsxElement(
  ts: typeof import("typescript"),
  node: import("typescript").JsxOpeningElement | import("typescript").JsxSelfClosingElement,
  attributes: import("typescript").JsxAttributes
) {
  if (ts.isJsxOpeningElement(node)) {
    return ts.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, attributes);
  }
  return ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, attributes);
}

function jsxTagName(ts: typeof import("typescript"), tagName: import("typescript").JsxTagNameExpression): string | null {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isJsxNamespacedName(tagName)) return `${tagName.namespace.text}:${tagName.name.text}`;
  if (ts.isPropertyAccessExpression(tagName)) return null;
  return null;
}

function jsxAttributeNameIs(ts: typeof import("typescript"), prop: import("typescript").JsxAttributeLike, name: string): boolean {
  return ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.name.text === name;
}

function isIntrinsicTag(tag: string): boolean {
  return /^[a-z]/.test(tag) || tag.includes("-");
}

function isJsxLike(filePath: string): boolean {
  return /\.(jsx|tsx)$/.test(filePath.split("?")[0] ?? filePath);
}

function scriptKindFor(ts: typeof import("typescript"), filePath: string) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
}

function tokenFor(file: string, tag: string, line: number, column: number): string {
  const digest = createHash("sha256").update(`${file}:${tag}:${line}:${column}`).digest("hex").slice(0, 10);
  return `s_${digest}`;
}
