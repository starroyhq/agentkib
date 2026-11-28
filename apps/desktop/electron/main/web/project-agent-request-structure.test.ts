import { readFileSync } from "node:fs";
import { parseAst } from "vite";
import { expect, it } from "vitest";

it("routes both assignment operations and both outcomes through the final authorization", () => {
  const name = "project-agent-request.ts";
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  const ast = parseAst(source, { lang: "ts" }, name);
  function body(name: string) {
    for (const statement of ast.body) {
      const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (node?.type === "FunctionDeclaration" && node.id?.name === name && node.body)
        return node.body.body;
    }
    throw new Error(`Missing ${name}`);
  }
  const route = body("requestProjectAgent").find(
    (node) =>
      node.type === "IfStatement" &&
      node.test.type === "LogicalExpression" &&
      node.test.operator === "||" &&
      node.test.left.type === "Identifier" &&
      node.test.left.name === "listing" &&
      node.test.right.type === "Identifier" &&
      node.test.right.name === "assigning",
  );
  expect(route?.type === "IfStatement" && route.consequent).toMatchObject({
    type: "ReturnStatement",
    argument: { type: "CallExpression", callee: { type: "Identifier", name: "requestAssignment" } },
  });

  const assignment = body("requestAssignment");
  const exits: string[] = [];
  function visit(value: unknown, caught = false) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, caught);
      return;
    }
    const node = value as { type?: string; start?: number; end?: number };
    if (node.type?.includes("Function")) return;
    if (node.type === "ReturnStatement" || (node.type === "ThrowStatement" && !caught))
      exits.push(source.slice(node.start, node.end));
    const handler = node.type === "TryStatement" && "handler" in node && node.handler;
    for (const [key, child] of Object.entries(node))
      visit(child, caught || (key === "block" && !!handler));
  }
  visit(assignment);
  expect(exits).toEqual(["return finishAssignmentReply(deps, context, outcome, checkIdentity);"]);
  expect(assignment.at(-2)?.type).toBe("TryStatement");
});
