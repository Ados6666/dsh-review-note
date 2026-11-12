// Loads lib/client.js the way the browser ModuleLoader would, with a tiny fake
// React, so the dependency-free Markdown renderer can be checked in Node.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
}

const React = {
  createElement,
  Component: class Component {
    constructor(props) {
      this.props = props || {};
    }
  },
  useEffect() {},
  useMemo(fn) { return fn(); },
  useRef(value) { return { current: value }; },
  useState(value) { return [typeof value === "function" ? value() : value, function () {}]; },
  useCallback(fn) { return fn; },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
};

let definition = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  },
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  console,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { documentElement: { classList: { add() {}, remove() {} } }, head: { appendChild() {} }, createElement: () => ({ set textContent(v) {} }) },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

assert.ok(definition, "ModuleLoader.load was called");
const plugin = definition.factory((name) => {
  if (name === "react") return React;
  throw new Error("unexpected module: " + name);
});
assert.equal(plugin.name, "dsh-review-note");
assert.equal(typeof plugin.apply, "function");

const { markdownBlocks, inlineMarkdown } = plugin.internal;

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return node.children.map(textOf).join("");
}

function flatten(nodes) {
  return Array.from(nodes.flat(Infinity).filter(Boolean));
}

// Values produced inside the vm have that realm's Array prototype, so compare
// with host-realm arrays.
const list = (value) => Array.from(value);

// Inline: code, bold, italic, safe link, unsafe link.
{
  const nodes = inlineMarkdown("use `a>b` and **bold** plus *em* [doc](https://x.test/a) [bad](javascript:alert(1))", "k");
  assert.equal(nodes[0], "use ");
  assert.equal(nodes[1].type, "code");
  assert.equal(nodes[1].children[0], "a>b");
  assert.equal(nodes[3].type, "strong");
  assert.equal(nodes[5].type, "em");
  assert.equal(nodes[7].type, "a");
  assert.equal(nodes[7].props.href, "https://x.test/a");
  assert.equal(nodes[8], " ");
  assert.equal(textOf(nodes.slice(9)), "[bad](javascript:alert(1))", "unsafe targets stay text");
}

// Headings, lists, quotes, code fences.
{
  const blocks = flatten(markdownBlocks("# Title\n\n## Section\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted **line**\n\n```js\nconst a = 1;\n```", "k"));
  const types = blocks.map((node) => node.type);
  assert.deepEqual(list(types), ["h2", "h3", "ul", "ol", "blockquote", "pre"]);
  assert.equal(textOf(blocks[0]), "Title");
  assert.deepEqual(list(blocks[2].children).map((li) => textOf(li)), ["one", "two"]);
  assert.deepEqual(list(blocks[3].children).map((li) => textOf(li)), ["first", "second"]);
  assert.equal(textOf(blocks[4]), "quoted line");
  assert.equal(textOf(blocks[5]), "const a = 1;");
}

// Pipe tables with alignment row.
{
  const blocks = flatten(markdownBlocks("| 口径 | 结论 |\n| --- | --- |\n| 全费用化 | 待确认 |\n| 两套并列 | 建议 |", "k"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  const [thead, tbody] = blocks[0].children;
  assert.deepEqual(list(thead.children[0].children).map(textOf), ["口径", "结论"]);
  assert.equal(tbody.children.length, 2);
  assert.deepEqual(list(tbody.children[1].children).map(textOf), ["两套并列", "建议"]);
}

// A paragraph interrupted by a heading must not swallow the heading.
{
  const blocks = flatten(markdownBlocks("paragraph line\n## Heading", "k"));
  assert.deepEqual(list(blocks).map((node) => node.type), ["p", "h3"]);
  assert.equal(textOf(blocks[0]), "paragraph line");
}

// Malformed input never throws.
{
  assert.equal(markdownBlocks("", "k").length, 0);
  assert.equal(markdownBlocks(null, "k").length, 0);
  const blocks = flatten(markdownBlocks("```\nunclosed fence", "k"));
  assert.equal(blocks[0].type, "pre");
}

// Resource addresses must survive Windows paths, drive letters and spaces.
{
  const { fileAddressFor, baseNameOf } = plugin.internal;
  const prefix = "dsh-resource://file/session/";

  assert.equal(fileAddressFor("s1", undefined, "docs/a.md"), prefix + "s1/docs/a.md");
  assert.equal(fileAddressFor("s1", undefined, "docs\\a.md"), prefix + "s1/docs/a.md");
  assert.equal(fileAddressFor("s1", undefined, "./out/a.docx"), prefix + "s1/out/a.docx");
  assert.equal(
    fileAddressFor("s1", undefined, "C:\\Users\\me\\\u62a5\u544a\u7ec8\u7a3f.docx"),
    prefix + "s1/C:/Users/me/" + encodeURIComponent("\u62a5\u544a\u7ec8\u7a3f.docx"),
  );
  assert.equal(fileAddressFor("s1", "C:\\work", "C:\\work\\out\\a.docx"), prefix + "s1/out/a.docx");
  assert.equal(fileAddressFor("s1", "/home/me/proj", "/home/me/proj/x/y.md"), prefix + "s1/x/y.md");
  assert.equal(fileAddressFor("s1", "/home/me/proj", "/tmp/other.md"), prefix + "s1//tmp/other.md");
  assert.equal(fileAddressFor("s 1", undefined, "a b.md"), prefix + "s%201/a%20b.md");

  // Whatever the platform, the address still parses as a file resource.
  const url = new URL(fileAddressFor("s1", undefined, "C:\\Users\\me\\a.docx"));
  assert.equal(url.hostname, "file");
  assert.equal(url.pathname, "/session/s1/C:/Users/me/a.docx");

  assert.equal(baseNameOf("C:\\a\\b.docx"), "b.docx");
  assert.equal(baseNameOf("/a/b.md"), "b.md");
  assert.equal(baseNameOf("b.md"), "b.md");
}

console.log("client: all assertions passed");
