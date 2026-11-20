/**
 * Minimal schema DSL for config tables. Validates types, unique ids and cross-table references,
 * and reports every problem with a precise path (table[row].field).
 */

export type FieldSpec =
  | { kind: 'string'; optional?: boolean; nonEmpty?: boolean }
  | { kind: 'int'; optional?: boolean; min?: number; max?: number }
  | { kind: 'number'; optional?: boolean; min?: number; max?: number }
  | { kind: 'bool'; optional?: boolean }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | { kind: 'ref'; table: string; optional?: boolean }
  | { kind: 'array'; of: FieldSpec; optional?: boolean; length?: number; lengthFrom?: string; minLength?: number }
  | { kind: 'object'; fields: Record<string, FieldSpec>; optional?: boolean }
  | { kind: 'record'; keys: readonly string[]; of: FieldSpec; optional?: boolean };

export interface TableSpec {
  /** Field used as primary key; must be unique. */
  idField?: string;
  row: Record<string, FieldSpec>;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

type Ids = Map<string, Set<string>>;

export function validateTables(
  tables: Record<string, unknown>,
  specs: Record<string, TableSpec>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const ids: Ids = new Map();

  // Pass 1: shape + collect ids.
  for (const [name, spec] of Object.entries(specs)) {
    const data = tables[name];
    if (!Array.isArray(data)) {
      issues.push({ path: name, message: 'missing table or not an array' });
      continue;
    }
    const set = new Set<string>();
    ids.set(name, set);
    if (spec.idField) {
      data.forEach((row, i) => {
        const id = (row as Record<string, unknown>)?.[spec.idField!];
        if (typeof id !== 'string' || id === '') return;
        if (set.has(id)) issues.push({ path: `${name}[${i}].${spec.idField}`, message: `duplicate id "${id}"` });
        set.add(id);
      });
    }
  }

  // Pass 2: fields + refs.
  for (const [name, spec] of Object.entries(specs)) {
    const data = tables[name];
    if (!Array.isArray(data)) continue;
    data.forEach((row, i) => {
      const base = `${name}[${i}]`;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        issues.push({ path: base, message: 'row must be an object' });
        return;
      }
      const r = row as Record<string, unknown>;
      for (const [field, fs] of Object.entries(spec.row)) {
        checkField(r[field], fs, `${base}.${field}`, r, ids, issues);
      }
      for (const key of Object.keys(r)) {
        if (!(key in spec.row)) issues.push({ path: `${base}.${key}`, message: 'unknown field' });
      }
    });
  }
  return issues;
}

function checkField(
  v: unknown,
  fs: FieldSpec,
  path: string,
  row: Record<string, unknown>,
  ids: Ids,
  issues: ConfigIssue[],
): void {
  if (v === undefined || v === null) {
    if (!fs.optional) issues.push({ path, message: 'required' });
    return;
  }
  const bad = (message: string): void => {
    issues.push({ path, message });
  };
  switch (fs.kind) {
    case 'string':
      if (typeof v !== 'string') return bad('expected string');
      if (fs.nonEmpty && v === '') bad('must not be empty');
      return;
    case 'int':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`expected ${fs.kind}`);
      if (fs.kind === 'int' && !Number.isInteger(v)) return bad('expected integer');
      if (fs.min !== undefined && v < fs.min) bad(`must be >= ${fs.min}`);
      if (fs.max !== undefined && v > fs.max) bad(`must be <= ${fs.max}`);
      return;
    case 'bool':
      if (typeof v !== 'boolean') bad('expected boolean');
      return;
    case 'enum':
      if (typeof v !== 'string' || !fs.values.includes(v)) bad(`expected one of ${fs.values.join('|')}`);
      return;
    case 'ref': {
      if (typeof v !== 'string') return bad('expected id string');
      const set = ids.get(fs.table);
      if (!set) return bad(`unknown ref table "${fs.table}"`);
      if (!set.has(v)) bad(`unknown ${fs.table} id "${v}"`);
      return;
    }
    case 'array': {
      if (!Array.isArray(v)) return bad('expected array');
      let want = fs.length;
      if (fs.lengthFrom !== undefined) {
        const n = row[fs.lengthFrom];
        if (typeof n === 'number') want = n;
      }
      if (want !== undefined && v.length !== want) bad(`expected length ${want}, got ${v.length}`);
      if (fs.minLength !== undefined && v.length < fs.minLength) bad(`expected at least ${fs.minLength} items`);
      v.forEach((item, i) => checkField(item, fs.of, `${path}[${i}]`, row, ids, issues));
      return;
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return bad('expected object');
      const o = v as Record<string, unknown>;
      for (const [k, sub] of Object.entries(fs.fields)) checkField(o[k], sub, `${path}.${k}`, row, ids, issues);
      for (const k of Object.keys(o)) if (!(k in fs.fields)) issues.push({ path: `${path}.${k}`, message: 'unknown field' });
      return;
    }
    case 'record': {
      if (typeof v !== 'object' || Array.isArray(v)) return bad('expected object');
      const o = v as Record<string, unknown>;
      for (const k of fs.keys) checkField(o[k], fs.of, `${path}.${k}`, row, ids, issues);
      for (const k of Object.keys(o)) if (!fs.keys.includes(k)) issues.push({ path: `${path}.${k}`, message: 'unknown key' });
      return;
    }
  }
}
