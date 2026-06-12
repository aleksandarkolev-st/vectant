import ts from "typescript";
import type { DojoAffordancePatchOperation, DojoAffordancePatchTargetMatch } from "./affordance_pr_plan.js";

export interface DojoReactCodemodResult {
  changed: boolean;
  source: string;
  applied_operations: string[];
  skipped_operations: string[];
}

export interface DojoReactAffordanceContractResult {
  ok: boolean;
  checked_operations: string[];
  missing_operations: Array<{
    operation_id: string;
    expected: string;
  }>;
}

export interface DojoGeneratedReactAffordanceTest {
  path: string;
  source: string;
  required_operations: string[];
}

export function applyReactAffordanceCodemodPlan(
  source: string,
  operations: DojoAffordancePatchOperation[]
): DojoReactCodemodResult {
  let current = source;
  const applied: string[] = [];
  const skipped: string[] = [];
  parseReactSourceOrThrow(current);
  for (const operation of operations) {
    const result = applyReactAffordanceOperation(current, operation);
    current = result.source;
    if (result.changed) applied.push(operation.operation_id);
    else skipped.push(operation.operation_id);
  }
  parseReactSourceOrThrow(current);
  return {
    changed: applied.length > 0,
    source: current,
    applied_operations: applied,
    skipped_operations: skipped,
  };
}

export function applyReactAffordanceOperation(
  source: string,
  operation: DojoAffordancePatchOperation
): DojoReactCodemodResult {
  if (operation.kind === "proof_hook") {
    return applyReactProofHookOperation(source, operation);
  }
  if (operation.kind !== "stable_locator") {
    throw new Error(`dojo_react_codemod_operation_unsupported:${operation.kind}`);
  }
  const attribute = parseJsxAttribute(operation.after);
  const sourceFile = parseReactSourceOrThrow(source);
  const target = findTargetElement(sourceFile, operation.target_component, operation.target_match);
  if (!target) throw new Error("dojo_react_codemod_target_not_found");
  if (hasJsxAttribute(target, attribute.name, attribute.value)) {
    return {
      changed: false,
      source,
      applied_operations: [],
      skipped_operations: [operation.operation_id],
    };
  }
  const insertPosition = target.end - (ts.isJsxSelfClosingElement(target) ? 2 : 1);
  const nextSource = `${source.slice(0, insertPosition)} ${attribute.name}="${attribute.value}"${source.slice(insertPosition)}`;
  parseReactSourceOrThrow(nextSource);
  return {
    changed: true,
    source: nextSource,
    applied_operations: [operation.operation_id],
    skipped_operations: [],
  };
}

export function evaluateReactAffordanceContract(
  source: string,
  operations: DojoAffordancePatchOperation[]
): DojoReactAffordanceContractResult {
  parseReactSourceOrThrow(source);
  const required = operations.filter((operation) => operation.kind === "stable_locator" || operation.kind === "proof_hook");
  const missing = required
    .filter((operation) => !source.includes(contractExpectationForOperation(operation)))
    .map((operation) => ({
      operation_id: operation.operation_id,
      expected: contractExpectationForOperation(operation),
    }));
  return {
    ok: missing.length === 0,
    checked_operations: required.map((operation) => operation.operation_id),
    missing_operations: missing,
  };
}

export function generateReactAffordanceVitestContractTest(input: {
  source_file_path: string;
  test_file_path: string;
  component_name: string;
  operations: DojoAffordancePatchOperation[];
}): DojoGeneratedReactAffordanceTest {
  const required = input.operations.filter((operation) => operation.kind === "stable_locator" || operation.kind === "proof_hook");
  if (required.length === 0) {
    throw new Error("dojo_react_affordance_contract_test_requires_contract_operation");
  }
  const relativeSourcePath = relativePathForGeneratedTest(input.test_file_path, input.source_file_path);
  const expectations = required.map((operation) => ({
    operation_id: operation.operation_id,
    affordance_id: operation.affordance_id,
    expected: contractExpectationForOperation(operation),
  }));
  const source = `import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(relativeSourcePath)});
const expectations = ${JSON.stringify(expectations, null, 2)};

describe("Dojo affordance contract: ${escapeForDoubleQuotedString(input.component_name)}", () => {
  it("exposes reviewed stable agent affordances", () => {
    const source = readFileSync(sourcePath, "utf8");
    for (const expectation of expectations) {
      expect(source, expectation.operation_id).toContain(expectation.expected);
    }
  });
});
`;
  parseReactSourceOrThrow(source);
  return {
    path: input.test_file_path,
    source,
    required_operations: required.map((operation) => operation.operation_id),
  };
}

export function parseReactSourceOrThrow(source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile("affordance-codemod.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(`dojo_react_codemod_parse_failed:${diagnostics[0]?.messageText.toString()}`);
  }
  return sourceFile;
}

function findTargetElement(
  sourceFile: ts.SourceFile,
  targetComponent: string,
  targetMatch?: DojoAffordancePatchTargetMatch
): ts.JsxOpeningLikeElement | null {
  const candidates: ts.JsxOpeningLikeElement[] = [];
  function visit(node: ts.Node): void {
    if (isNamedComponent(node, targetComponent)) {
      collectActionElements(node);
      return;
    }
    ts.forEachChild(node, visit);
  }
  function collectActionElements(node: ts.Node): void {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isActionElement(node)) {
      candidates.push(node);
    }
    ts.forEachChild(node, collectActionElements);
  }
  visit(sourceFile);
  if (!targetMatch) return candidates[0] ?? null;
  const matches = candidates.filter((candidate) => targetElementMatches(sourceFile, candidate, targetMatch));
  if (matches.length > 1) throw new Error("dojo_react_codemod_target_ambiguous");
  return matches[0] ?? null;
}

function applyReactProofHookOperation(source: string, operation: DojoAffordancePatchOperation): DojoReactCodemodResult {
  const hookName = operation.after;
  if (!source.includes(hookName)) {
    throw new Error("dojo_react_codemod_proof_hook_not_in_scope");
  }
  const sourceFile = parseReactSourceOrThrow(source);
  const target = findTargetElement(sourceFile, operation.target_component, operation.target_match);
  if (!target) throw new Error("dojo_react_codemod_target_not_found");
  const expectedCall = proofHookCallExpression(operation);
  if (target.getText(sourceFile).includes(expectedCall)) {
    return {
      changed: false,
      source,
      applied_operations: [],
      skipped_operations: [operation.operation_id],
    };
  }
  const onClick = findJsxAttribute(target, "onClick");
  const replacement = onClick
    ? proofHookWrappedOnClick(sourceFile, onClick, operation)
    : `onClick={() => { ${expectedCall}; }}`;
  const nextSource = onClick
    ? `${source.slice(0, onClick.getStart(sourceFile))}${replacement}${source.slice(onClick.end)}`
    : `${source.slice(0, target.end - (ts.isJsxSelfClosingElement(target) ? 2 : 1))} ${replacement}${source.slice(target.end - (ts.isJsxSelfClosingElement(target) ? 2 : 1))}`;
  parseReactSourceOrThrow(nextSource);
  return {
    changed: true,
    source: nextSource,
    applied_operations: [operation.operation_id],
    skipped_operations: [],
  };
}

function proofHookWrappedOnClick(
  sourceFile: ts.SourceFile,
  onClick: ts.JsxAttribute,
  operation: DojoAffordancePatchOperation
): string {
  const initializer = onClick.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    throw new Error("dojo_react_codemod_onclick_expression_required");
  }
  const expression = initializer.expression;
  const expressionText = expression.getText(sourceFile);
  const expectedCall = proofHookCallExpression(operation);
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return `onClick={(event) => { ${expectedCall}; return (${expressionText})(event); }}`;
  }
  if (ts.isCallExpression(expression)) {
    return `onClick={(event) => { ${expectedCall}; return ${expressionText}; }}`;
  }
  return `onClick={(event) => { ${expectedCall}; return (${expressionText}); }}`;
}

function findJsxAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const property of node.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
  }
  return null;
}

function isNamedComponent(node: ts.Node, targetComponent: string): boolean {
  if (ts.isFunctionDeclaration(node) && node.name?.text === targetComponent) return true;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === targetComponent) return true;
  return false;
}

function isActionElement(node: ts.JsxOpeningLikeElement): boolean {
  const tagName = node.tagName.getText();
  return tagName === "button" || node.attributes.properties.some((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === "onClick"
  );
}

function targetElementMatches(
  sourceFile: ts.SourceFile,
  node: ts.JsxOpeningLikeElement,
  targetMatch: DojoAffordancePatchTargetMatch
): boolean {
  if (targetMatch.role && !elementRoleMatches(node, targetMatch.role)) return false;
  if (targetMatch.attribute && !hasTargetAttribute(node, targetMatch.attribute.name, targetMatch.attribute.value)) return false;
  if (targetMatch.text?.trim() && normalizeVisibleText(getVisibleJsxText(sourceFile, node)) !== normalizeVisibleText(targetMatch.text)) return false;
  return true;
}

function elementRoleMatches(node: ts.JsxOpeningLikeElement, role: NonNullable<DojoAffordancePatchTargetMatch["role"]>): boolean {
  if (role === "action") return isActionElement(node);
  const tagName = node.tagName.getText();
  if (role === "button" && tagName === "button") return true;
  if (role === "link" && tagName === "a") return true;
  if (role === "input" && tagName === "input") return true;
  return hasTargetAttribute(node, "role", role);
}

function hasTargetAttribute(node: ts.JsxOpeningLikeElement, name: string, value?: string): boolean {
  return node.attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) return false;
    if (value === undefined) return true;
    return attributeInitializerText(property) === value;
  });
}

function attributeInitializerText(attribute: ts.JsxAttribute): string | undefined {
  const initializer = attribute.initializer;
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    if (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression)) {
      return initializer.expression.text;
    }
  }
  return initializer.getText().replace(/^"|"$/g, "");
}

function getVisibleJsxText(sourceFile: ts.SourceFile, node: ts.JsxOpeningLikeElement): string {
  if (ts.isJsxSelfClosingElement(node)) return "";
  const parent = node.parent;
  if (!parent || !ts.isJsxElement(parent) || parent.openingElement !== node) return "";
  const fragments: string[] = [];
  collectVisibleJsxText(sourceFile, parent, fragments);
  return fragments.join(" ");
}

function collectVisibleJsxText(sourceFile: ts.SourceFile, node: ts.Node, fragments: string[]): void {
  if (ts.isJsxText(node)) {
    fragments.push(node.getText(sourceFile));
    return;
  }
  if (ts.isJsxExpression(node) && node.expression) {
    if (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) {
      fragments.push(node.expression.text);
    }
    return;
  }
  ts.forEachChild(node, (child) => collectVisibleJsxText(sourceFile, child, fragments));
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasJsxAttribute(node: ts.JsxOpeningLikeElement, name: string, value: string): boolean {
  return node.attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) return false;
    return attributeInitializerText(property) === value;
  });
}

function contractExpectationForOperation(operation: DojoAffordancePatchOperation): string {
  if (operation.kind === "proof_hook") return proofHookCallExpression(operation);
  return operation.after;
}

function proofHookCallExpression(operation: DojoAffordancePatchOperation): string {
  return `${operation.after}(${JSON.stringify(operation.affordance_id)})`;
}

function parseJsxAttribute(value: string): { name: string; value: string } {
  const match = value.match(/^([a-zA-Z0-9_:-]+)="([^"]+)"$/);
  if (!match?.[1] || match[2] === undefined) throw new Error("dojo_react_codemod_attribute_invalid");
  return { name: match[1], value: match[2] };
}

function relativePathForGeneratedTest(testFilePath: string, sourceFilePath: string): string {
  const testDir = testFilePath.split(/[\\/]/).slice(0, -1).join("/") || ".";
  const sourceParts = sourceFilePath.split(/[\\/]/);
  const testParts = testDir === "." ? [] : testDir.split("/");
  while (sourceParts.length && testParts.length && sourceParts[0] === testParts[0]) {
    sourceParts.shift();
    testParts.shift();
  }
  const upward = testParts.map(() => "..");
  return [...upward, ...sourceParts].join("/") || ".";
}

function escapeForDoubleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
