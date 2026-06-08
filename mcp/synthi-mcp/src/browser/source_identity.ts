import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative } from "node:path";

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

export interface SourceIdentityRegistration {
  workspaceId?: string;
  root?: string;
  filePath: string;
  tokens: SourceIdentityToken[];
  transformVersion?: string;
  adapter?: string;
}

export interface SourceIdentityResolvedToken extends SourceIdentityToken {
  workspace_id: string;
  filePath: string;
  adapter: string;
  transform_version: string;
  registered_at: number;
}

export interface SourceIdentityWorkspaceStatus {
  workspace_id: string;
  status: "empty" | "mapped";
  token_count: number;
  file_count: number;
  files: Array<{
    file: string;
    token_count: number;
    updated_at: number;
    transform_version: string;
    adapter: string;
  }>;
  transform_versions: string[];
  last_registered_at: number | null;
}

interface SourceIdentityWorkspaceState {
  tokens: Map<string, SourceIdentityResolvedToken>;
  files: Map<string, {
    file: string;
    token_count: number;
    updated_at: number;
    transform_version: string;
    adapter: string;
    tokens: Set<string>;
  }>;
}

export const SOURCE_IDENTITY_ATTR = "data-synthi-source-id";
export const SOURCE_IDENTITY_DEFAULT_WORKSPACE = "default";
export const SOURCE_IDENTITY_TRANSFORM_VERSION = "vite_react_source_identity_v1";

export class SourceIdentityRegistry {
  private readonly workspaces = new Map<string, SourceIdentityWorkspaceState>();

  register(input: SourceIdentityRegistration): SourceIdentityWorkspaceStatus {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const state = this.stateFor(workspaceId);
    const transformVersion = input.transformVersion ?? SOURCE_IDENTITY_TRANSFORM_VERSION;
    const adapter = input.adapter ?? "vite-react";
    const file = workspaceFileFor(input.filePath, input.root);
    const updatedAt = Date.now();
    const previous = state.files.get(file);
    if (previous) {
      for (const token of previous.tokens) state.tokens.delete(token);
    }

    const tokenSet = new Set<string>();
    for (const token of input.tokens) {
      if (!validToken(token.token)) continue;
      const workspaceFile = workspaceFileFor(token.file || file, input.root);
      const resolved: SourceIdentityResolvedToken = {
        ...token,
        file: workspaceFile,
        filePath: workspaceFile,
        workspace_id: workspaceId,
        adapter,
        transform_version: transformVersion,
        registered_at: updatedAt,
      };
      state.tokens.set(token.token, resolved);
      tokenSet.add(token.token);
    }

    state.files.set(file, {
      file,
      token_count: tokenSet.size,
      updated_at: updatedAt,
      transform_version: transformVersion,
      adapter,
      tokens: tokenSet,
    });
    return this.status(workspaceId);
  }

  lookup(token: string, workspaceId?: string): SourceIdentityResolvedToken | null {
    if (!validToken(token)) return null;
    if (workspaceId) return this.workspaces.get(normalizeWorkspaceId(workspaceId))?.tokens.get(token) ?? null;
    for (const state of this.workspaces.values()) {
      const hit = state.tokens.get(token);
      if (hit) return hit;
    }
    return null;
  }

  status(workspaceId?: string): SourceIdentityWorkspaceStatus {
    const id = normalizeWorkspaceId(workspaceId);
    const state = this.workspaces.get(id);
    if (!state) {
      return {
        workspace_id: id,
        status: "empty",
        token_count: 0,
        file_count: 0,
        files: [],
        transform_versions: [],
        last_registered_at: null,
      };
    }
    const files = Array.from(state.files.values())
      .map((file) => ({
        file: file.file,
        token_count: file.token_count,
        updated_at: file.updated_at,
        transform_version: file.transform_version,
        adapter: file.adapter,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
    const transformVersions = Array.from(new Set(files.map((file) => file.transform_version))).sort();
    const lastRegisteredAt = files.length > 0 ? Math.max(...files.map((file) => file.updated_at)) : null;
    return {
      workspace_id: id,
      status: state.tokens.size > 0 ? "mapped" : "empty",
      token_count: state.tokens.size,
      file_count: files.length,
      files,
      transform_versions: transformVersions,
      last_registered_at: lastRegisteredAt,
    };
  }

  resetForTests(): void {
    this.workspaces.clear();
  }

  private stateFor(workspaceId: string): SourceIdentityWorkspaceState {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;
    const state: SourceIdentityWorkspaceState = {
      tokens: new Map(),
      files: new Map(),
    };
    this.workspaces.set(workspaceId, state);
    return state;
  }
}

export const sourceIdentityRegistry = new SourceIdentityRegistry();

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
        const existing = node.attributes.properties.find((prop) => jsxAttributeNameIs(ts, prop, SOURCE_IDENTITY_ATTR));
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const file = input.root ? relative(input.root, input.filePath) || input.filePath : input.filePath;
        if (mode === "strip") {
          const nextAttributes = node.attributes.properties.filter((prop) => !jsxAttributeNameIs(ts, prop, SOURCE_IDENTITY_ATTR));
          if (nextAttributes.length !== node.attributes.properties.length) stats.stripped += 1;
          return updateJsxElement(ts, node, ts.factory.createJsxAttributes(nextAttributes));
        }
        if (existing) {
          const token = jsxAttributeStringValue(ts, existing);
          if (token) tokens.push({ token, file, tag, line: position.line + 1, column: position.character + 1 });
          stats.preserved += 1;
          return ts.visitEachChild(node, visitor, context);
        }
        const token = tokenFor(file, tag, position.line + 1, position.character + 1);
        tokens.push({ token, file, tag, line: position.line + 1, column: position.character + 1 });
        stats.inserted += 1;
        return updateJsxElement(ts, node, ts.factory.createJsxAttributes([
          ...node.attributes.properties,
          ts.factory.createJsxAttribute(ts.factory.createIdentifier(SOURCE_IDENTITY_ATTR), ts.factory.createStringLiteral(token)),
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
  registry?: SourceIdentityRegistry;
  workspaceId?: string;
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
      if (result.tokens.length > 0) {
        options.registry?.register({
          workspaceId: options.workspaceId,
          root: options.root,
          filePath: id,
          tokens: result.tokens,
          transformVersion: SOURCE_IDENTITY_TRANSFORM_VERSION,
          adapter: "vite-react",
        });
        options.onTokens?.(id, result.tokens);
      }
      if (result.stats.inserted === 0 && result.stats.stripped === 0) return null;
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

function jsxAttributeStringValue(ts: typeof import("typescript"), prop: import("typescript").JsxAttributeLike): string | null {
  if (!ts.isJsxAttribute(prop)) return null;
  const initializer = prop.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  return null;
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

function normalizeWorkspaceId(workspaceId: string | undefined): string {
  return typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : SOURCE_IDENTITY_DEFAULT_WORKSPACE;
}

function workspaceFileFor(filePath: string, root: string | undefined): string {
  const raw = normalize(filePath).replace(/\\/g, "/");
  if (root && isAbsolute(filePath)) {
    const rel = relative(root, filePath).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== "..") return rel;
  }
  return raw.replace(/^\.\//, "");
}

function validToken(token: string): boolean {
  return typeof token === "string" && token.length > 0;
}
