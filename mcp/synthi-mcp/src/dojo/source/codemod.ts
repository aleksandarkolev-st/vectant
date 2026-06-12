import ts from "typescript";
import type { DojoAffordancePatchOperation } from "./affordance_pr_plan.js";

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
  if (operation.kind !== "stable_locator") {
    throw new Error(`dojo_react_codemod_operation_unsupported:${operation.kind}`);
  }
  const attribute = parseJsxAttribute(operation.after);
  const sourceFile = parseReactSourceOrThrow(source);
  const target = findTargetElement(sourceFile, operation.target_component);
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
  const required = operations.filter((operation) => operation.kind === "stable_locator");
  const missing = required
    .filter((operation) => !source.includes(operation.after))
    .map((operation) => ({
      operation_id: operation.operation_id,
      expected: operation.after,
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
  const required = input.operations.filter((operation) => operation.kind === "stable_locator");
  if (required.length === 0) {
    throw new Error("dojo_react_affordance_contract_test_requires_stable_locator");
  }
  const relativeSourcePath = relativePathForGeneratedTest(input.test_file_path, input.source_file_path);
  const expectations = required.map((operation) => ({
    operation_id: operation.operation_id,
    affordance_id: operation.affordance_id,
    expected: operation.after,
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

function findTargetElement(sourceFile: ts.SourceFile, targetComponent: string): ts.JsxOpeningLikeElement | null {
  let target: ts.JsxOpeningLikeElement | null = null;
  function visit(node: ts.Node): void {
    if (target) return;
    if (isNamedComponent(node, targetComponent)) {
      findFirstActionElement(node);
      return;
    }
    ts.forEachChild(node, visit);
  }
  function findFirstActionElement(node: ts.Node): void {
    if (target) return;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isActionElement(node)) {
      target = node;
      return;
    }
    ts.forEachChild(node, findFirstActionElement);
  }
  visit(sourceFile);
  return target;
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

function hasJsxAttribute(node: ts.JsxOpeningLikeElement, name: string, value: string): boolean {
  return node.attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) return false;
    return property.initializer?.getText().replace(/^"|"$/g, "") === value;
  });
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
