import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A `.env` file as an ordered list of lines. Comments and blank lines are kept; `set` replaces
 * a variable in place or appends it. Values are written verbatim (no quoting), which is what
 * Node's `--env-file` reads back.
 */
export class EnvFile {
  static PLACEHOLDER = /^REPLACE_WITH/;

  /** @param {string[]} lines */
  constructor(lines) {
    this.lines = lines;
  }

  /** @param {string} path */
  static load(path) {
    return EnvFile.parse(readFileSync(path, 'utf8'));
  }

  /** @param {string} text */
  static parse(text) {
    return new EnvFile(text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));
  }

  /** Raw value as written (quotes included), so rewriting a file never changes it. @param {string} name */
  get(name) {
    for (const line of this.lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim();
    }
    return undefined;
  }

  /** @param {string} name */
  has(name) {
    return this.get(name) !== undefined;
  }

  /** True when the variable is empty, missing, or still holds the template placeholder. @param {string} name */
  needs(name) {
    const v = this.get(name);
    return v === undefined || v === '' || EnvFile.PLACEHOLDER.test(v) || v.split(',').some((part) => EnvFile.PLACEHOLDER.test(part.split(':')[1] ?? ''));
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  set(name, value) {
    const i = this.lines.findIndex((line) => new RegExp(`^\\s*${name}=`).test(line));
    const rendered = `${name}=${value}`;
    if (i === -1) this.lines.push(rendered);
    else this.lines[i] = rendered;
    return this;
  }

  /** Every variable as a plain object, quotes removed (what a process reading the file sees). */
  toObject() {
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of this.lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = EnvFile.#unquote(m[2]);
    }
    return out;
  }

  toString() {
    const text = this.lines.join('\n');
    return text.endsWith('\n') ? text : `${text}\n`;
  }

  /** @param {string} path */
  save(path) {
    writeFileSync(path, this.toString());
  }

  /** @param {string} raw */
  static #unquote(raw) {
    const v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  }
}
