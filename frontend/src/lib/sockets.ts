// Sockets are per schema, like a Blender node's: a node with several input (or output) schemas has one socket
// per schema; with one (or none known) it has a single "in"/"out" socket. A connection in the manifest
// (dataset -> processor, processor -> dataset) is drawn as one wire per schema it carries, between the
// sockets of that schema.

import type { GraphNode } from "../types";
import { datasetSchema, expects, emits, schemaList, type Processors } from "./rules";

export const socketId = (port: "in" | "out", schema: string) => `${port}:${schema}`;

/** The schemas a node has separate input sockets for; empty: one "in" socket. */
export function inputSockets(node: GraphNode | undefined, processors: Processors): string[] {
  const list = schemaList(node?.kind === "dataset" ? datasetSchema(node) : expects(node, processors)) ?? [];
  return list.length > 1 ? list : [];
}

/** The schemas a node has separate output sockets for; empty: one "out" socket. Only a dataset carrying several has more. */
export function outputSockets(node: GraphNode | undefined): string[] {
  const list = node?.kind === "dataset" ? schemaList(datasetSchema(node)) ?? [] : [];
  return list.length > 1 ? list : [];
}

export interface Wire {
  sourceHandle: string;
  targetHandle: string;
  schema?: string;
}

/** The wires drawing one connection: one per schema it carries, landing on that schema's sockets where they exist. */
export function wires(source: GraphNode | undefined, target: GraphNode | undefined, processors: Processors): Wire[] {
  const ins = inputSockets(target, processors);
  const into = (schema: string | undefined) =>
    !ins.length ? "in" : socketId("in", schema && ins.includes(schema) ? schema : ins[0]);
  const outs = outputSockets(source);
  if (outs.length) return outs.map((s) => ({ sourceHandle: socketId("out", s), targetHandle: into(s), schema: s }));
  const schema = schemaList(emits(source, processors))?.[0];
  return [{ sourceHandle: "out", targetHandle: into(schema), schema }];
}

/** Schemas in the node's saved order (rearranged by hand); ones the order doesn't mention keep their place at the end. */
export function ordered(schemas: string[], order: string[] | undefined): string[] {
  if (!order?.length) return schemas;
  const at = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length + schemas.indexOf(s));
  return [...schemas].sort((a, b) => at(a) - at(b));
}

/** The order after dragging `moved` onto `onto`: it takes that place. */
export function moveSocket(schemas: string[], moved: string, onto: string): string[] {
  const to = schemas.indexOf(onto);
  if (to < 0 || !schemas.includes(moved)) return schemas;
  const rest = schemas.filter((s) => s !== moved);
  rest.splice(to, 0, moved);
  return rest;
}
