/**
 * dsh-prompt-inject —— 浏览器半区的离线验收。
 *
 * 不装 React、不开浏览器：在纯 node 里伪造 window.__ModuleLoader__ / document /
 * fetch / 一个最小 React（只有 createElement + 5 个 hook），把 lib/client/index.js
 * 当真正的手写 bundle 加载，然后
 *   1. apply(假 ctx) → 断言 slots.register 收到契约里的那份声明；
 *   2. 真渲染卡片 → 断言输出非空、三态控件/脏标记/错误条都在；
 *   3. 走一遍「改总开关 → 保存」→ 断言 POST body 符合 CONTRACT.md §2.1/§4；
 *   4. GET 全失败 → 卡片照样渲染并给出错误条；
 *   5. 卸载后迟到的响应不得 setState。
 *
 * 跑法：node test/client-bundle.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "lib", "client", "index.js");
const CSS_TAG = "dsh-prompt-inject/settings.css";

let checks = 0;

function ok(label, extra) {
  checks += 1;
  console.log("  ok " + label + (extra === undefined ? "" : "  [" + extra + "]"));
}

function section(title) {
  console.log("\n" + title);
}

// ── 最小 React 桩 ─────────────────────────────────────────────────────
const ELEMENT = Symbol("element");

function isElement(value) {
  return value !== null && typeof value === "object" && value[ELEMENT] === true;
}

function flatten(list, out) {
  for (const item of list) {
    if (item === null || item === undefined || item === false || item === true) continue;
    if (Array.isArray(item)) {
      flatten(item, out);
      continue;
    }
    out.push(item);
  }
  return out;
}

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return false;
  return true;
}

/** hook 调用转发到「当前正在渲染的 harness」。 */
const reactFacade = (() => {
  let active = null;
  const createElement = (type, config, ...children) => {
    const props = Object.assign({}, config === null || config === undefined ? {} : config);
    const own = [];
    if (Object.prototype.hasOwnProperty.call(props, "children")) {
      flatten([props.children], own);
      delete props.children;
    }
    flatten(children, own);
    return { [ELEMENT]: true, type, props, children: own };
  };
  return {
    activate(harness) {
      active = harness;
    },
    api: {
      createElement,
      useState: (initial) => active.useState(initial),
      useEffect: (fn, deps) => active.useEffect(fn, deps),
      useMemo: (factory, deps) => active.useMemo(factory, deps),
      useCallback: (fn, deps) => active.useCallback(fn, deps),
      useRef: (initial) => active.useRef(initial),
    },
  };
})();

// ── primitives 桩（Modal 真实现走 ReactDOM.createPortal，这里只按 props 出元素） ──
function createPrimitives() {
  const e = reactFacade.api.createElement;
  function Modal(props) {
    if (props.open !== true) return null;
    return e(
      "div",
      { className: "primitives-modal", "data-pin": "primitives-modal", role: "dialog", "aria-label": props.title },
      e("h2", null, props.title),
      props.description === undefined ? null : e("p", { "data-pin": "primitives-description" }, props.description),
      e("div", { "data-pin": "primitives-body" }, props.children),
      props.footer === undefined ? null : e("div", { "data-pin": "primitives-foot" }, props.footer),
    );
  }
  return { api: { Modal }, Modal };
}

// ── 最小 document 桩 ──────────────────────────────────────────────────
function createDocument() {
  const styles = [];
  const listeners = new Map();
  const head = {
    tagName: "HEAD",
    appendChild(node) {
      styles.push(node);
      node.parentNode = head;
      return node;
    },
    removeChild(node) {
      const at = styles.indexOf(node);
      if (at >= 0) styles.splice(at, 1);
      node.parentNode = null;
      return node;
    },
  };
  const doc = {
    head,
    createElement(tag) {
      const attributes = {};
      const node = {
        tagName: String(tag).toUpperCase(),
        textContent: "",
        parentNode: null,
        getAttribute(name) {
          return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        setAttribute(name, value) {
          attributes[name] = String(value);
        },
        removeAttribute(name) {
          delete attributes[name];
        },
        remove() {
          if (node.parentNode !== null) node.parentNode.removeChild(node);
        },
      };
      return node;
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.*)"\]$/.exec(String(selector));
      if (match === null) return null;
      return styles.find((node) => node.getAttribute("data-plugin-css") === match[1]) || null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const bucket = listeners.get(type);
      if (!bucket) return;
      const at = bucket.indexOf(fn);
      if (at >= 0) bucket.splice(at, 1);
    },
  };
  return { doc, styles, listeners };
}

// ── 渲染 harness ──────────────────────────────────────────────────────
function createHarness() {
  const { doc, styles, listeners } = createDocument();
  let component = null;
  let props = null;
  let cells = [];
  let cursor = 0;
  let scheduled = false;
  let mounted = false;
  let tree = null;
  let renderCount = 0;

  const errors = [];
  const violations = [];

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      if (!mounted) return;
      try {
        paint();
      } catch (error) {
        errors.push(error);
      }
    });
  }

  function commit() {
    for (const cell of cells) {
      if (!cell || cell.kind !== "effect" || cell.dirty !== true) continue;
      cell.dirty = false;
      if (typeof cell.cleanup === "function") {
        const cleanup = cell.cleanup;
        cell.cleanup = undefined;
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      const run = cell.next;
      cell.next = undefined;
      if (typeof run !== "function") continue;
      try {
        const returned = run();
        cell.cleanup = typeof returned === "function" ? returned : undefined;
      } catch (error) {
        errors.push(error);
      }
    }
  }

  function paint() {
    reactFacade.activate(harness);
    cursor = 0;
    tree = component(props);
    renderCount += 1;
    commit();
  }

  const harness = {
    doc,
    styles,
    listeners,
    errors,
    violations,
    get tree() {
      return tree;
    },
    get renderCount() {
      return renderCount;
    },
    mount(nextComponent, nextProps) {
      component = nextComponent;
      props = nextProps === undefined ? {} : nextProps;
      cells = [];
      mounted = true;
      paint();
      return tree;
    },
    unmount() {
      mounted = false;
      for (const cell of cells) {
        if (!cell || cell.kind !== "effect") continue;
        const cleanup = cell.cleanup;
        cell.cleanup = undefined;
        if (typeof cleanup !== "function") continue;
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
    },
    useState(initial) {
      const at = cursor;
      cursor += 1;
      if (!(at in cells) || cells[at].kind !== "state") {
        cells[at] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
      }
      const cell = cells[at];
      const set = (next) => {
        if (!mounted) {
          violations.push("setState after unmount");
          return;
        }
        const value = typeof next === "function" ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        scheduleRender();
      };
      return [cell.value, set];
    },
    useEffect(fn, deps) {
      const at = cursor;
      cursor += 1;
      const previous = cells[at];
      const unchanged = previous !== undefined && previous.kind === "effect" && sameDeps(previous.deps, deps);
      if (unchanged) return;
      const cell = previous !== undefined && previous.kind === "effect" ? previous : { kind: "effect" };
      cell.deps = deps;
      cell.next = fn;
      cell.dirty = true;
      cells[at] = cell;
    },
    useMemo(factory, deps) {
      const at = cursor;
      cursor += 1;
      const previous = cells[at];
      if (previous !== undefined && previous.kind === "memo" && sameDeps(previous.deps, deps)) return previous.value;
      const value = factory();
      cells[at] = { kind: "memo", deps, value };
      return value;
    },
    useCallback(fn, deps) {
      const at = cursor;
      cursor += 1;
      const previous = cells[at];
      if (previous !== undefined && previous.kind === "callback" && sameDeps(previous.deps, deps)) return previous.value;
      cells[at] = { kind: "callback", deps, value: fn };
      return fn;
    },
    useRef(initial) {
      const at = cursor;
      cursor += 1;
      if (!(at in cells) || cells[at].kind !== "ref") cells[at] = { kind: "ref", current: initial };
      return cells[at];
    },
  };

  return harness;
}

// ── 树查询 ────────────────────────────────────────────────────────────
function walk(node, visit) {
  if (!isElement(node)) return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(tree, predicate) {
  const out = [];
  walk(tree, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!isElement(node)) return "";
  return node.children.map(textOf).join("");
}

function byPin(tree, pin) {
  return findAll(tree, (node) => node.props["data-pin"] === pin);
}

function classOf(node) {
  return typeof node.props.className === "string" ? node.props.className : "";
}

function chipsOf(dimNode) {
  return findAll(dimNode, (node) => node.props["data-pin"] === "opt");
}

function chipOf(dimNode, value) {
  const node = chipsOf(dimNode).filter((item) => item.props["data-value"] === value)[0];
  assert.ok(node, "候选里应有 " + value + " 这个 chip");
  return node;
}

function checkedChips(dimNode) {
  return chipsOf(dimNode).filter((node) => classOf(node).includes("pin-opt-on")).map((node) => node.props["data-value"]);
}

function chipBox(dimNode, value) {
  const chip = chipOf(dimNode, value);
  const box = findAll(chip, (node) => node.props["data-pin"] === "opt-check")[0];
  assert.ok(box, value + " 这个 chip 里应有一个复选框");
  assert.equal(box.props.type, "checkbox", value + " 的复选框要 type=checkbox");
  return box;
}

function chipLabels(dimNode) {
  return chipsOf(dimNode).map((node) => textOf(findAll(node, (item) => item.props["data-pin"] === "opt-label")[0]));
}

function dimAllButton(dimNode) {
  const node = findAll(dimNode, (item) => item.props["data-pin"] === "dim-all")[0];
  assert.ok(node, "每个维度都该有一个全选/全不选按钮");
  return node;
}

function dimOf(ruleNode, key) {
  const node = findAll(ruleNode, (item) => item.props["data-pin"] === "dim" && item.props["data-dim"] === key)[0];
  assert.ok(node, "规则里应有 " + key + " 维度");
  return node;
}

function ruleNodes(tree) {
  return byPin(tree, "rule");
}

function fire(node, propName, event) {
  const fn = node && node.props ? node.props[propName] : undefined;
  assert.equal(typeof fn, "function", "节点应带 " + propName);
  return fn(event === undefined ? { target: {}, preventDefault() {}, stopPropagation() {} } : event);
}

function toggleEvent(value) {
  return { target: { checked: value }, preventDefault() {}, stopPropagation() {} };
}

function inputEvent(value) {
  return { target: { value }, preventDefault() {}, stopPropagation() {} };
}

async function flush(rounds) {
  const rounds1 = rounds === undefined ? 10 : rounds;
  for (let i = 0; i < rounds1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ── fetch 桩 ──────────────────────────────────────────────────────────
function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** CONTRACT.md §4 的结构校验：只管结构，不管完整性。 */
function validateLikeHost(config) {
  const problems = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) return ["config must be a JSON object"];
  if (typeof config.version !== "number") problems.push("version must be a number");
  if (typeof config.enabled !== "boolean") problems.push("enabled must be a boolean");
  if (!Array.isArray(config.rules)) problems.push("rules must be an array");
  else {
    config.rules.forEach((rule, index) => {
      const at = "rules[" + index + "]";
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
        problems.push(at + " must be an object");
        return;
      }
      if (typeof rule.id !== "string" || rule.id === "") problems.push(at + ".id must be a string");
      if (typeof rule.name !== "string") problems.push(at + ".name must be a string");
      if (typeof rule.text !== "string" || rule.text.trim() === "") problems.push(at + ".text must not be empty");
      if (typeof rule.enabled !== "boolean") problems.push(at + ".enabled must be a boolean");
      if (rule.when === null || typeof rule.when !== "object" || Array.isArray(rule.when)) {
        problems.push(at + ".when must be an object");
        return;
      }
      for (const key of ["presets", "efforts", "permissions"]) {
        if (!Object.prototype.hasOwnProperty.call(rule.when, key)) continue;
        const value = rule.when[key];
        const legal = value === "all"
          || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== ""));
        if (!legal) problems.push(at + ".when." + key + ' must be "all" or an array of strings');
      }
    });
  }
  return problems;
}

const CONFIG_URL = "/api/prompt-inject/config";
const OPTIONS_URL = "/api/prompt-inject/options";

const CONFIG_FIXTURE = {
  version: 1,
  enabled: true,
  rules: [
    {
      id: "r-ls-abundance",
      name: "梁神模式暴富提醒",
      enabled: true,
      text: "切记：你的用量是 unlimited 的，随意花费。",
      when: { presets: ["liangshen"], efforts: "all", permissions: "all" },
    },
    {
      id: "r-draft",
      name: "草稿规则（缺 permissions）",
      enabled: true,
      text: "草稿正文。",
      when: { presets: ["liangshen"], efforts: "all" },
    },
  ],
};

const OPTIONS_FIXTURE = {
  ok: true,
  presets: [
    { id: "liangshen", label: "梁神模式" },
    { id: "default", label: "默认模式" },
  ],
  permissions: [
    { id: "read-only", label: "仅可查看" },
    { id: "danger-full-access", label: "完全权限" },
  ],
  efforts: [
    { id: "high", label: "高" },
    { id: "low", label: "低" },
  ],
};

function createFetch(plan) {
  const calls = [];
  const stub = async (url, init) => {
    const method = (init && init.method) || "GET";
    calls.push({ url, method, init: init || {} });
    const key = method + " " + url;
    const handler = plan[key];
    if (typeof handler !== "function") throw new Error("unexpected request " + key);
    const response = handler(init);
    if (response instanceof Error) throw response;
    return response;
  };
  stub.calls = calls;
  stub.posts = () => calls.filter((call) => call.method === "POST");
  return stub;
}

// ── 全局环境 ──────────────────────────────────────────────────────────
const consoleErrors = [];
const unhandled = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
};
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec);
    },
  },
};

await import(pathToFileURL(BUNDLE).href);

// ══ 1. bundle 外壳 + apply ════════════════════════════════════════════
section("1. bundle 外壳与 slots 注册");
assert.equal(loaded.length, 1, "bundle 只应调用一次 __ModuleLoader__.load");
const spec = loaded[0];
assert.equal(spec.id, "dsh-prompt-inject");
assert.equal(typeof spec.factory, "function");
ok("__ModuleLoader__.load 收到 id=dsh-prompt-inject");

const required = [];
const primitives = createPrimitives();
const module = spec.factory((id) => {
  required.push(id);
  if (id === "react") return reactFacade.api;
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives.api;
  throw new Error("模块不在 baseline 白名单：" + id);
});
assert.deepEqual(Object.keys(module).sort(), ["apply", "inject", "name"]);
assert.deepEqual(module.inject, ["slots"], "inject 必须是 ['slots']");
assert.deepEqual(required, ["react", "@deepseek-ai/dsh-client-ui-primitives"], "只 require react 与 primitives（都在平台 seed 白名单里）");
ok("factory(require) 只 require react + primitives，返回 { name, apply, inject }");

const effects = [];
const registrations = [];
const injections = [];
const fakeCtx = {
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return () => {};
  },
  slots: {
    inject(name, factory) {
      injections.push(name);
      return factory();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

const firstDoc = createDocument();
globalThis.document = firstDoc.doc;
globalThis.fetch = async () => jsonResponse(200, { ok: true });
module.apply(fakeCtx);

assert.equal(registrations.length, 4, "apply 后应注册四个 slot：设置卡片 + 输入框上方按钮 + 开场区按钮 + 覆盖层面板");
assert.deepEqual(injections, [
  "settings.section",
  "conversation.composer.dock",
  "conversation.hero.options",
  "shell.overlay",
]);
const registrationOf = (slotName) => registrations.find((item) => item.options.name === slotName);
const settingsReg = registrationOf("settings.section");
assert.equal(settingsReg.options.id, "prompt-inject");
assert.equal(settingsReg.options.order, 60);
assert.equal(settingsReg.options.label, "提示词注入");
assert.equal(typeof settingsReg.component, "function");
ok("slots.register 收到 { name:'settings.section', id:'prompt-inject', order:60, label:'提示词注入' }");

const dockReg = registrationOf("conversation.composer.dock");
const heroReg = registrationOf("conversation.hero.options");
const overlayReg = registrationOf("shell.overlay");
assert.equal(registrationOf("conversation.view"), undefined, "会话顶部标签视图必须已经下线");
assert.equal(dockReg.options.id, "prompt-inject-composer");
assert.equal(dockReg.options.order, 900);
assert.equal(dockReg.options.label, undefined, "dock 里不显示文字标签");
assert.deepEqual(dockReg.options.inject("sess-1"), { sessionId: "sess-1" }, "composer.dock 的 inject 面把 sessionId 送进 props");
assert.equal(heroReg.options.id, "prompt-inject-hero");
assert.equal(overlayReg.options.id, "prompt-inject-panel");
assert.equal(heroReg.options.order, 900);
assert.equal(overlayReg.options.order, 900);
// id 只需在同一个 slot 内唯一（标签视图故意沿用插件 id 'prompt-inject'，与设置卡片同名不同 slot）
for (const slotName of ["settings.section", "conversation.composer.dock", "conversation.hero.options", "shell.overlay"]) {
  const ids = registrations.filter((item) => item.options.name === slotName).map((item) => item.options.id);
  assert.equal(ids.length, 1, slotName + " 只注册一次");
}
assert.equal(new Set(registrations.map((item) => item.options.name)).size, registrations.length, "四个注册落在四个不同 slot 上");
assert.equal(typeof dockReg.options.inject, "function", "composer.dock 必须带 inject 面才能拿到 sessionId");
assert.equal(typeof heroReg.options.inject, "function", "hero.options 必须带 inject 面才能拿到 sessionId");
assert.equal(overlayReg.options.inject, undefined, "shell.overlay 是 root scope，不该有 sessionId 注入面");
assert.equal(dockReg.component, heroReg.component, "两个入口复用同一颗按钮组件");
assert.equal(typeof overlayReg.component, "function");
ok("四个 slot 注册且 id 唯一：composer.dock / hero.options（都带 inject 面）+ shell.overlay 面板，conversation.view 已下线");
assert.equal(effects.length, 2, "apply 应挂两个 effect：样式 + 卡片注册");
assert.equal(firstDoc.styles.length, 1, "样式标签应已注入");
assert.equal(firstDoc.styles[0].getAttribute("data-plugin-css"), CSS_TAG);
assert.ok(firstDoc.styles[0].textContent.includes("--dsw-alias-border-l2"));
ok("style[data-plugin-css='" + CSS_TAG + "'] 由 ctx.effect 装载", firstDoc.styles[0].textContent.length + " 字节 CSS");

const Card = registrations[0].component;

// ══ 2. 首次渲染 ═══════════════════════════════════════════════════════
section("2. 渲染：加载成功");
const app = createHarness();
globalThis.document = app.doc;
globalThis.window = {
  __ModuleLoader__: globalThis.window.__ModuleLoader__,
  addEventListener() {},
  removeEventListener() {},
};

const fetchStub = createFetch({
  ["GET " + CONFIG_URL]: () => jsonResponse(200, { ok: true, config: CONFIG_FIXTURE }),
  ["GET " + OPTIONS_URL]: () => jsonResponse(200, OPTIONS_FIXTURE),
  ["POST " + CONFIG_URL]: (init) => {
    const payload = JSON.parse(init.body);
    const problems = validateLikeHost(payload.config);
    if (problems.length > 0) return jsonResponse(400, { ok: false, error: problems[0], errors: problems });
    return jsonResponse(200, { ok: true, config: payload.config });
  },
});
globalThis.fetch = fetchStub;

let closeCalls = 0;
const tree0 = app.mount(Card, { close: () => { closeCalls += 1; } });
assert.ok(isElement(tree0), "卡片必须渲染出元素树");
assert.equal(byPin(tree0, "card").length, 1, "根节点应带 data-pin=card");
assert.ok(textOf(tree0).includes("提示词注入"), "卡片标题应可见");
assert.equal(byPin(tree0, "save").length, 1, "加载中就应有保存按钮");
ok("首帧（loading）非空：" + classOf(tree0) + " / loading 占位 " + byPin(tree0, "loading").length + " 个");

await flush();
const tree1 = app.tree;
assert.equal(byPin(tree1, "rules").length, 1, "规则容器应出现");
assert.equal(ruleNodes(tree1).length, 2, "fixture 有两条规则");
assert.equal(app.errors.length, 0, "渲染不得抛错：" + app.errors.map(String).join("; "));
const getCalls = fetchStub.calls.filter((call) => call.method === "GET").map((call) => call.url).sort();
assert.deepEqual(getCalls, [CONFIG_URL, OPTIONS_URL].sort(), "挂载时应并发 GET config 与 options");
ok("挂载并发 GET config + options，两条规则渲染出来");

// 折叠行：一条规则只占一行，行头是 role=button 的展开器
const rulePair = ruleNodes(tree1);
const heads = rulePair.map((rule) => byPin(rule, "rule-toggle")[0]);
assert.ok(heads.every((node) => node !== undefined), "每条规则都应有可点的行头");
assert.ok(heads.every((node) => node.props.role === "button" && node.props.tabIndex === 0), "行头可点、可聚焦");
assert.equal(heads[0].props["aria-expanded"], "false", "完整规则默认折叠");
assert.equal(heads[1].props["aria-expanded"], "true", "缺维度规则默认展开");
assert.equal(byPin(rulePair[0], "editor").length, 0, "折叠态不渲染编辑器");
assert.equal(byPin(rulePair[1], "editor").length, 1, "展开态才渲染编辑器");
assert.ok(classOf(heads[0]).includes("pin-rule-row"), "行头用折叠行样式：" + classOf(heads[0]));
ok("折叠态：完整规则折叠 / 缺维度规则默认展开（aria-expanded=false/true）");

// 摘要语：一行自然语言说完生效条件，取代原来的整段原理小字
const summaries = rulePair.map((rule) => byPin(rule, "rule-summary")[0]);
assert.equal(textOf(summaries[0]), "仅 梁神模式", "摘要只列被限定的维度，并用 /options 的 label，实际：" + textOf(summaries[0]));
assert.equal(textOf(summaries[0]).includes("全部"), false, "「全部」不再作为占位出现：" + textOf(summaries[0]));
assert.equal(textOf(summaries[0]).includes("liangshen"), false, "摘要里不得出现原始 id：" + textOf(summaries[0]));
assert.ok(!classOf(summaries[0]).includes("warn"), "完整规则的摘要不告警");
assert.ok(textOf(summaries[1]).includes("权限 未设"), "未设的维度要单独点名：" + textOf(summaries[1]));
assert.ok(textOf(summaries[1]).includes("当前不会注入"), "未设要给出后果：" + textOf(summaries[1]));
assert.ok(classOf(summaries[1]).includes("pin-rule-summary-warn"), "未设的摘要转 warn 色：" + classOf(summaries[1]));
ok("摘要一行读完：" + textOf(summaries[0]) + " ｜ " + textOf(summaries[1]));

fire(heads[0], "onClick");
await flush();
const opened = app.tree;
assert.equal(byPin(opened, "rule-toggle")[0].props["aria-expanded"], "true", "点行头展开这条规则");
assert.equal(byPin(opened, "rule-name")[0].props.value, "梁神模式暴富提醒", "规则名回填到名称输入框");
assert.equal(byPin(opened, "rule-text")[0].props.value, CONFIG_FIXTURE.rules[0].text, "正文回填到 textarea");
ok("展开后才出现名称/正文输入框，值来自 config");

// 行头键盘可达 + 所有可点元素都是 type=button
fire(byPin(app.tree, "rule-toggle")[0], "onKeyDown", { key: "Enter", preventDefault() {}, stopPropagation() {}, target: {} });
await flush();
assert.equal(byPin(app.tree, "rule-toggle")[0].props["aria-expanded"], "false", "Enter 也能收起");
fire(byPin(app.tree, "rule-toggle")[0], "onClick");
await flush();
assert.equal(byPin(app.tree, "rule-toggle")[0].props["aria-expanded"], "true", "再点一下重新展开");
const cardButtons = findAll(app.tree, (node) => node.type === "button");
assert.ok(cardButtons.length > 0, "卡片里应有按钮");
assert.ok(cardButtons.every((node) => node.props.type === "button"), "所有按钮都要显式 type=button");
ok("行头 Enter 可收/可展；卡片里 " + cardButtons.length + " 个按钮都带 type=button");
const openPair = ruleNodes(app.tree);
assert.deepEqual(checkedChips(dimOf(openPair[0], "efforts")), ["high", "low", "medium"], "efforts:'all' ⇒ 所有候选（含内置保底补进来的 medium）都显示为勾选");
assert.equal(textOf(dimAllButton(dimOf(openPair[0], "efforts"))), "全不选", "全选状态下按钮是「全不选」");
assert.deepEqual(checkedChips(dimOf(openPair[1], "permissions")), [], "缺 permissions ⇒ 一个 chip 都没勾");
assert.equal(textOf(dimAllButton(dimOf(openPair[1], "permissions"))), "全选", "没勾任何候选时按钮是「全选」");
assert.equal(findAll(openPair[1], (node) => node.props["data-pin"] === "opts").length, 3, "一条展开的规则里有三个候选列表容器");
assert.equal(byPin(openPair[1], "dim-inactive").length, 1, "没选的维度带 warn 点");
assert.equal(byPin(openPair[0], "dim-inactive").length, 0, "三个维度都在的规则没有 warn 点");
assert.equal(findAll(openPair[0], (node) => node.props["data-pin"] === "incomplete").length, 0, "完整规则不应有未完成徽标");
assert.equal(findAll(openPair[1], (node) => node.props["data-pin"] === "incomplete").length, 1, "缺维度规则应有未完成徽标");
ok("勾选回显：全选维度的 chip 全亮、未选维度零勾选、按钮文案随状态翻转");

// ══ 3. 改总开关 → 保存 ═══════════════════════════════════════════════
section("3. 改总开关 → 保存 → POST body");
const enabledInput = byPin(tree1, "enabled")[0];
assert.equal(enabledInput.props.checked, true);
fire(enabledInput, "onChange", toggleEvent(false));
await flush();
const tree2 = app.tree;
assert.equal(byPin(tree2, "dirty").length, 1, "改过之后要出现脏标记");
assert.ok(textOf(byPin(tree2, "dirty")[0]).includes("未保存"), "脏标记要写明未保存");
assert.equal(byPin(tree2, "discard")[0].props.disabled, false, "脏状态下放弃可用");
ok("改总开关 → 脏标记出现");

fire(byPin(tree2, "save")[0], "onClick");
await flush();
const posts = fetchStub.posts();
assert.equal(posts.length, 1, "保存应发一次 POST");
assert.equal(posts[0].url, CONFIG_URL);
assert.ok(String(posts[0].init.headers["content-type"]).includes("application/json"));
const body = JSON.parse(posts[0].init.body);
assert.deepEqual(body, {
  config: {
    version: 1,
    enabled: false,
    rules: [
      {
        id: "r-ls-abundance",
        name: "梁神模式暴富提醒",
        enabled: true,
        text: "切记：你的用量是 unlimited 的，随意花费。",
        when: { presets: ["liangshen"], efforts: "all", permissions: "all" },
      },
      {
        id: "r-draft",
        name: "草稿规则（缺 permissions）",
        enabled: true,
        text: "草稿正文。",
        when: { presets: ["liangshen"], efforts: "all" },
      },
    ],
  },
}, "POST body 必须符合 CONTRACT.md §2.1/§4");
assert.equal(body.config.rules[0].when.efforts, "all", "样例里应有一条 efforts:'all'");
assert.equal(Object.prototype.hasOwnProperty.call(body.config.rules[1].when, "permissions"), false, "草稿规则必须省略 permissions 键");
ok("POST body 结构正确（含 efforts:'all' + 缺 permissions 的草稿）");
console.log("     body = " + JSON.stringify(body));

const tree3 = app.tree;
assert.equal(byPin(tree3, "dirty").length, 0, "保存成功后脏标记应清掉");
assert.equal(byPin(tree3, "notice").length, 1, "保存成功后要有提示行");
assert.ok(textOf(byPin(tree3, "notice")[0]).includes("已保存"), "保存成功后要有提示");
ok("保存成功 → 脏标记清除 + 回填宿主返回的 config");

// ══ 4. 新增规则 → 400 错误 → 补正文后保存成功 ═════════════════════════
section("4. 新增规则 / 400 报错 / 补正文");
const tree4 = app.tree;
fire(byPin(tree4, "add-rule")[0], "onClick");
await flush();
const tree5 = app.tree;
assert.equal(ruleNodes(tree5).length, 3, "新增后应有 3 条规则");
const added = ruleNodes(tree5)[2];
const addedId = added.props["data-rule-id"];
assert.match(String(addedId), /^r-[a-z0-9]+$/, "新规则 id 应形如 r-<随机>，实际：" + addedId);
assert.equal(byPin(tree5, "incomplete").length, 2, "新规则三维度都未设 ⇒ 未完成");
ok("新增规则 id=" + addedId + "，初始三个维度都没勾任何候选");

fire(byPin(tree5, "save")[0], "onClick");
await flush();
const tree6 = app.tree;
const saveError = byPin(tree6, "save-error")[0];
assert.ok(saveError, "400 后应显示错误条");
assert.ok(textOf(saveError).includes("must not be empty"), "错误条应展示宿主返回的 error，实际：" + textOf(saveError));
ok("400 → 错误条展示宿主 error：'" + textOf(saveError) + "'");

const textareas = byPin(app.tree, "rule-text");
fire(textareas[textareas.length - 1], "onChange", inputEvent("第三条规则的正文。"));
await flush();
fire(byPin(app.tree, "save")[0], "onClick");
await flush();
assert.equal(byPin(app.tree, "save-error").length, 0, "补好正文后不应再有错误条");
assert.ok(textOf(app.tree).includes("已保存"));
const postList = fetchStub.posts();
const lastBody = JSON.parse(postList[postList.length - 1].init.body);
assert.equal(lastBody.config.rules.length, 3);
assert.deepEqual(lastBody.config.rules[2].when, {}, "未设维度的 when 是空对象");
assert.deepEqual(validateLikeHost(lastBody.config), [], "草稿（when 全空）也应能提交成功");
ok("补正文后保存成功，when:{} 的草稿也被宿主接受");

// ══ 5. 勾选候选 + 全选/全不选 + 一键全维度 ════════════════════════════
section("5. 勾选候选 / 全选·全不选 / 一键按钮");
let tree = app.tree;
let rules = ruleNodes(tree);
// 折叠行：维度控件只在展开态里，先确保这条规则展开
if (byPin(rules[1], "rule-delete").length === 0) {
  fire(byPin(rules[1], "rule-toggle")[0], "onClick");
  await flush();
  tree = app.tree;
  rules = ruleNodes(tree);
}

// ① 每个维度都是「一个候选列表 + 一个全选/全不选文本按钮」，三段控件与下拉都没有了
for (const key of ["presets", "efforts", "permissions"]) {
  const dimNode = dimOf(rules[1], key);
  assert.equal(byPin(dimNode, "opts").length, 1, key + " 维度应有一个候选列表容器");
  assert.ok(chipsOf(dimNode).length > 0, key + " 维度应把候选平铺成 chip");
  const allButton = dimAllButton(dimNode);
  assert.equal(allButton.type, "button", key + " 的全选按钮要显式 type=button");
  assert.ok(classOf(allButton).includes("pin-link-btn"), key + " 的全选按钮用 .pin-link-btn");
  assert.equal(findAll(dimNode, (node) => node.props["data-pin"] === "tri").length, 0, "三段控件已删除");
  assert.equal(byPin(dimNode, "dd").length + byPin(dimNode, "dd-trigger").length, 0, "下拉多选已删除");
  assert.ok(byPin(dimNode, "dim-inactive").length <= 1);
}
ok("三个维度都是候选 chip 列表 + 一个全选/全不选按钮，三段控件与下拉都没了");

// ⑥ chip 上用 /options 的中文显示名，不是原始 id
assert.deepEqual(chipLabels(dimOf(rules[1], "presets")), ["梁神模式", "默认模式", "标准模式", "PTC 模式", "极简模式", "创造模式"], "chip 显示 /options 的 label，缺的由内置保底补齐");
assert.equal(textOf(dimOf(rules[1], "presets")).includes("liangshen"), false, "chip 上不得出现原始 id");
ok("chip 文案 = /options 的中文 label（梁神模式 / 默认模式）");

// ④ 「全不选」⇒ 存空数组（不删键）+ warn 点回来 + 摘要转「当前不会注入」
fire(dimAllButton(dimOf(rules[1], "efforts")), "onClick");
await flush();
rules = ruleNodes(app.tree);
const effortsDim = dimOf(rules[1], "efforts");
assert.deepEqual(checkedChips(effortsDim), [], "全不选后一个 chip 都不勾");
assert.equal(textOf(dimAllButton(effortsDim)), "全选", "全不选之后按钮翻回「全选」");
assert.equal(byPin(rules[1], "dim-inactive").length, 2, "efforts 与 permissions 都没选 ⇒ 两个 warn 点");
assert.ok(textOf(byPin(rules[1], "rule-summary")[0]).includes("当前不会注入"), "摘要要写明当前不会注入：" + textOf(byPin(rules[1], "rule-summary")[0]));
fire(byPin(app.tree, "save")[0], "onClick");
await flush();
const postNone = fetchStub.posts();
const bodyNone = JSON.parse(postNone[postNone.length - 1].init.body);
assert.equal(Object.prototype.hasOwnProperty.call(bodyNone.config.rules[1].when, "efforts"), true, "全不选要把键留着");
assert.deepEqual(bodyNone.config.rules[1].when.efforts, [], "全不选存空数组，不是删键");
assert.deepEqual(validateLikeHost(bodyNone.config), [], "空数组是合法配置，宿主不该 400");
ok("全不选 ⇒ when.efforts = []（键保留）+ warn 点 + 摘要「当前不会注入」");

// ⑤ 「全选」⇒ 存 "all"，warn 点消失，所有 chip 亮起
fire(dimAllButton(dimOf(ruleNodes(app.tree)[1], "efforts")), "onClick");
await flush();
rules = ruleNodes(app.tree);
assert.deepEqual(checkedChips(dimOf(rules[1], "efforts")), ["high", "low", "medium"], "全选后所有 chip 都勾上");
assert.equal(textOf(dimAllButton(dimOf(rules[1], "efforts"))), "全不选", "全选状态下按钮显示「全不选」");
assert.equal(byPin(rules[1], "dim-inactive").length, 1, "efforts 恢复后只剩 permissions 的 warn 点");
ok("点「全选」⇒ chip 全亮、按钮翻成「全不选」、warn 点消失");

// ③ 取消其中一个候选 ⇒ 存数组（按候选顺序）
fire(chipBox(dimOf(rules[1], "efforts"), "high"), "onChange", toggleEvent(false));
await flush();
rules = ruleNodes(app.tree);
assert.deepEqual(checkedChips(dimOf(rules[1], "efforts")), ["low", "medium"], "取消 high 后剩 low 与内置保底的 medium");
assert.equal(textOf(dimAllButton(dimOf(rules[1], "efforts"))), "全选", "不是全勾了，按钮回到「全选」");
fire(byPin(app.tree, "save")[0], "onClick");
await flush();
const postPart = fetchStub.posts();
const bodyPart = JSON.parse(postPart[postPart.length - 1].init.body);
assert.deepEqual(bodyPart.config.rules[1].when.efforts, ["low", "medium"], "勾一部分存成数组");
ok("勾一部分 ⇒ when.efforts = [\"low\",\"medium\"]（数组，不用 \"all\"）");

// ② 把最后一个候选也勾上 ⇒ 全员勾选折回 "all"（不是数组）
fire(chipBox(dimOf(ruleNodes(app.tree)[1], "efforts"), "high"), "onChange", toggleEvent(true));
await flush();
rules = ruleNodes(app.tree);
assert.deepEqual(checkedChips(dimOf(rules[1], "efforts")), ["high", "low", "medium"], "补上 high 后三个候选都勾上");
assert.equal(textOf(dimAllButton(dimOf(rules[1], "efforts"))), "全不选", "勾满后按钮变「全不选」");
fire(byPin(app.tree, "save")[0], "onClick");
await flush();
const postFull = fetchStub.posts();
const bodyFull = JSON.parse(postFull[postFull.length - 1].init.body);
assert.equal(bodyFull.config.rules[1].when.efforts, "all", "勾满所有候选要存字符串 all，而不是数组");
ok("勾满所有候选 ⇒ when.efforts = \"all\"（不是 [\"high\",\"low\"]）");

// 一键按钮：三个维度全部置成 "all"
fire(byPin(ruleNodes(app.tree)[1], "all-dims")[0], "onClick");
await flush();
const allRule = ruleNodes(app.tree)[1];
for (const key of ["presets", "efforts", "permissions"]) {
  assert.equal(textOf(dimAllButton(dimOf(allRule, key))), "全不选", key + " 应被置成全选");
  assert.ok(checkedChips(dimOf(allRule, key)).length > 0, key + " 的 chip 应全亮");
}
ok("一键按钮把三个维度都置成全选");

fire(byPin(app.tree, "save")[0], "onClick");
await flush();
const postList2 = fetchStub.posts();
const body2 = JSON.parse(postList2[postList2.length - 1].init.body);
assert.deepEqual(body2.config.rules[1].when, { presets: "all", efforts: "all", permissions: "all" });
ok("三维全选序列化为 \"all\"（不是数组、不是通配数组）");


// ══ 6. 顺序与删除 ═════════════════════════════════════════════════════
section("6. 上移 / 下移 / 删除 / 放弃改动");
tree = app.tree;
rules = ruleNodes(tree);
const beforeIds = rules.map((rule) => rule.props["data-rule-id"]);
const ensureOpen = async (node) => {
  if (byPin(node, "rule-delete").length > 0) return node;
  fire(byPin(node, "rule-toggle")[0], "onClick");
  await flush();
  return ruleNodes(app.tree).filter((item) => item.props["data-rule-id"] === node.props["data-rule-id"])[0];
};
const second = await ensureOpen(rules[1]);
fire(byPin(second, "rule-move-up")[0], "onClick");
await flush();
const afterIds = ruleNodes(app.tree).map((rule) => rule.props["data-rule-id"]);
assert.deepEqual(afterIds.slice(0, 2), [beforeIds[1], beforeIds[0]], "上移应交换前两条");
ok("上移交换顺序：" + beforeIds.slice(0, 2).join(",") + " → " + afterIds.slice(0, 2).join(","));

const third = ruleNodes(app.tree)[2];
const thirdOpen = await ensureOpen(third);
fire(byPin(thirdOpen, "rule-delete")[0], "onClick");
await flush();
assert.equal(ruleNodes(app.tree).length, 2, "删除后剩 2 条");
assert.equal(byPin(app.tree, "dirty").length, 1, "删除也是改动 ⇒ 脏标记");
fire(byPin(app.tree, "discard")[0], "onClick");
await flush();
assert.equal(ruleNodes(app.tree).length, 3, "放弃改动应回到保存时的 3 条");
assert.equal(byPin(app.tree, "dirty").length, 0);
ok("删除 → 脏标记；放弃改动 → 回到基线");

// ══ 7. 关卡片时的未保存提示 ═══════════════════════════════════════════
section("7. 未保存就关闭 → confirm 拦截");
tree = app.tree;
// 总开关在上一阶段已经存成 false，这里拨回 true 才是「有改动」
fire(byPin(tree, "enabled")[0], "onChange", toggleEvent(true));
await flush();
assert.equal(byPin(app.tree, "dirty").length, 1, "拨回总开关后应处于脏状态");
const clickHandlers = app.listeners.get("click") || [];
assert.equal(clickHandlers.length, 1, "脏状态下应挂 1 个捕获期 click 监听");
const fakeButton = { className: "Xy9Jkq_close", getAttribute: () => null };
let prevented = 0;
const asked = [];
globalThis.confirm = (message) => {
  asked.push(message);
  return false;
};
clickHandlers[0]({
  target: {
    closest(selector) {
      if (selector === "button") return fakeButton;
      return null;
    },
  },
  preventDefault() {
    prevented += 1;
  },
  stopPropagation() {},
  stopImmediatePropagation() {},
});
assert.equal(prevented, 1, "用户选「留下」时必须挡掉关闭按钮");
assert.equal(asked.length, 1);
assert.ok(asked[0].includes("未保存"), "confirm 文案应说明未保存，实际：" + asked[0]);
ok("dirty + 点外壳关闭按钮 + 用户拒绝 ⇒ 关闭被拦住：'" + asked[0] + "'");

globalThis.confirm = () => true;
clickHandlers[0]({
  target: { closest: (selector) => (selector === "button" ? fakeButton : null) },
  preventDefault() {
    prevented += 1;
  },
  stopPropagation() {},
  stopImmediatePropagation() {},
});
assert.equal(prevented, 1, "用户确认离开时不应 preventDefault");
ok("用户确认 ⇒ 关闭照常进行");
delete globalThis.confirm;

clickHandlers[0]({
  target: { closest: (selector) => (selector === '[data-pin="card"]' ? {} : null) },
  preventDefault() {
    prevented += 1;
  },
  stopPropagation() {},
  stopImmediatePropagation() {},
});
assert.equal(prevented, 1, "卡片内部点击不得被当成关闭");
ok("卡片内部点击不触发拦截");

// ══ 8. GET 全失败：卡片仍可用 ═════════════════════════════════════════
section("8. GET 失败 → 错误条 + 卡片仍可用");
const failingApp = createHarness();
const failingFetch = createFetch({
  ["GET " + CONFIG_URL]: () => new TypeError("Failed to fetch"),
  ["GET " + OPTIONS_URL]: () => jsonResponse(500, { ok: false, error: "options exploded" }),
  ["POST " + CONFIG_URL]: (init) => jsonResponse(200, { ok: true, config: JSON.parse(init.body).config }),
});
globalThis.fetch = failingFetch;
globalThis.document = failingApp.doc;
const failed0 = failingApp.mount(Card, { close() {} });
assert.ok(isElement(failed0));
await flush();
const failedTree = failingApp.tree;
assert.equal(failingApp.errors.length, 0, "GET 失败也不得抛：" + failingApp.errors.map(String).join("; "));
assert.equal(byPin(failedTree, "load-error").length, 1, "应有错误条");
const loadErrorText = textOf(byPin(failedTree, "load-error")[0]);
assert.ok(loadErrorText.includes("配置读取失败"), "错误条应写明哪一步失败：" + loadErrorText);
assert.ok(loadErrorText.includes("候选值读取失败"), "两个 GET 的失败都要报：" + loadErrorText);
assert.equal(byPin(failedTree, "load-warning").length, 1, "配置没读到时要有覆盖风险提示");
assert.equal(byPin(failedTree, "no-rules").length, 1, "默认配置 = 空规则表");
assert.equal(byPin(failedTree, "save").length, 1);
assert.equal(byPin(failedTree, "add-rule").length, 1);
assert.ok(textOf(failedTree).includes("提示词注入"));
ok("GET 全失败：错误条 + 覆盖风险提示 + 空规则表 + 保存/新增可用");

fire(byPin(failedTree, "add-rule")[0], "onClick");
await flush();
assert.equal(ruleNodes(failingApp.tree).length, 1, "失败态下也能新增规则");
ok("失败态下仍能新增规则（卡片不白屏）");
failingApp.unmount();

// ══ 9. 卸载后不得 setState ════════════════════════════════════════════
section("9. 卸载后迟到的响应不得 setState");
const lateApp = createHarness();
globalThis.fetch = (url) => new Promise((resolve) => {
  setTimeout(() => {
    if (url === CONFIG_URL) resolve(jsonResponse(200, { ok: true, config: CONFIG_FIXTURE }));
    else resolve(jsonResponse(200, OPTIONS_FIXTURE));
  }, 30);
});
globalThis.document = lateApp.doc;
lateApp.mount(Card, { close() {} });
await flush(1);
const rendersBeforeUnmount = lateApp.renderCount;
lateApp.unmount();
await flush(12);
assert.deepEqual(lateApp.violations, [], "卸载后不得 setState");
assert.equal(lateApp.renderCount, rendersBeforeUnmount, "卸载后不得再渲染");
assert.equal(lateApp.errors.length, 0, "卸载不得抛错：" + lateApp.errors.map(String).join("; "));
ok("卸载 30ms 后响应到达：0 次 setState、0 次渲染、0 个异常");

// ══ 10. sessionId 从 inject 面进入 props ═══════════════════════════════
section("10. inject 面给组件 props 带 sessionId");

/** 每个场景一份新的模块实例：桥是模块级状态，跨场景会串味。 */
function freshModule() {
  const record = { registrations: [], injections: [], effects: [] };
  const instance = spec.factory((id) => {
    if (id === "react") return reactFacade.api;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives.api;
    throw new Error("模块不在 baseline 白名单：" + id);
  });
  instance.apply({
    effect(fn, label) {
      record.effects.push({ label, dispose: fn() });
      return () => {};
    },
    slots: {
      inject(name, factory) {
        record.injections.push(name);
        return factory();
      },
      register(options, component) {
        record.registrations.push({ options, component });
        return () => {};
      },
    },
  });
  const slot = (name) => record.registrations.find((item) => item.options.name === name);
  return { instance, record, slot };
}

const SESSION_ID = "sess-1";
const SESSION_URL = "/api/prompt-inject/session?sessionId=" + SESSION_ID;
const SESSION_PRE_URL = "/api/prompt-inject/session";
const SESSION_POST = "/api/prompt-inject/session";
const SESSION_RULES = [
  { id: "r-a", name: "规则甲", enabled: true, sessionOnly: false },
  { id: "r-b", name: "", enabled: true, sessionOnly: false },
  { id: "r-off", name: "停用规则", enabled: false, sessionOnly: false },
];
function sessionFixture(store, sessionId) {
  return {
    ok: true,
    sessionId: sessionId === undefined ? null : sessionId,
    override: store.override,
    defaultRuleIds: store.defaultRuleIds,
    rules: store.rules,
  };
}

globalThis.fetch = async () => jsonResponse(200, { ok: true });
const m10 = freshModule();
const dockReg10 = m10.slot("conversation.composer.dock");
const heroReg10 = m10.slot("conversation.hero.options");
assert.equal(m10.slot("conversation.view"), undefined, "conversation.view 不再注册");
assert.deepEqual(dockReg10.options.inject("sess-42"), { sessionId: "sess-42" }, "composer.dock 靠 inject 面拿 sessionId");
assert.deepEqual(heroReg10.options.inject("sess-42"), { sessionId: "sess-42" }, "hero.options 同样靠 inject 面拿 sessionId");
assert.deepEqual(heroReg10.options.inject(undefined), { sessionId: undefined });
assert.equal(m10.slot("shell.overlay").options.inject, undefined, "shell.overlay 没有 sessionId 注入面");
ok("inject 面：inject(sessionId) → { sessionId }；composer.dock 与 hero 按钮同源，conversation.view 已下线");

const buttonApp = createHarness();
globalThis.document = buttonApp.doc;
const buttonTree = buttonApp.mount(heroReg10.component, heroReg10.options.inject("sess-42"));
await flush(2);
assert.equal(buttonApp.errors.length, 0, "按钮渲染不得抛错：" + buttonApp.errors.map(String).join("; "));
const buttonNode = byPin(buttonTree, "inject-button")[0];
assert.equal(textOf(buttonNode), "系统提示词注入", "按钮文案");
assert.equal(buttonNode.props["data-session"], "sess-42", "sessionId 从 inject 面进入 props");
assert.equal(buttonNode.props["data-open"], "0", "初始未打开");
ok("hero 按钮：文案「系统提示词注入」，data-session 来自 inject 面");

buttonApp.unmount();
const noSessionTree = buttonApp.mount(heroReg10.component, heroReg10.options.inject(undefined));
await flush(2);
assert.ok(isElement(noSessionTree), "没有 sessionId 时按钮仍要渲染");
assert.equal(byPin(noSessionTree, "inject-button")[0].props["data-session"], "");
ok("hero.options + inject(undefined)：会话未创建也渲染按钮（data-session 为空）");
buttonApp.unmount();

// ══ 11. 面板：打开 / 预勾选 / 停用标注 / 关闭 ══════════════════════════
section("11. 面板：打开 → 预勾选 → 停用标注 → 关闭");
const store11 = { override: null, rules: SESSION_RULES, defaultRuleIds: ["r-a"], posts: [] };
const fetchStub11 = createFetch({
  ["GET " + SESSION_URL]: () => jsonResponse(200, sessionFixture(store11, SESSION_ID)),
  ["POST " + SESSION_POST]: (init) => {
    const body = JSON.parse(init.body);
    store11.posts.push(body);
    store11.override = { ruleIds: body.ruleIds.slice() };
    return jsonResponse(200, { ok: true, session: sessionFixture(store11, SESSION_ID) });
  },
  ["DELETE " + SESSION_URL]: () => {
    store11.override = null;
    return jsonResponse(200, { ok: true, sessionId: SESSION_ID });
  },
});
globalThis.fetch = fetchStub11;
const m11 = freshModule();
const panelReg11 = m11.slot("shell.overlay");
const buttonReg11 = m11.slot("conversation.hero.options");
const panelApp = createHarness();
const buttonApp11 = createHarness();
globalThis.document = panelApp.doc;
const closedTree = panelApp.mount(panelReg11.component, {});
await flush(2);
assert.equal(closedTree.type, primitives.api.Modal, "面板必须用 primitives 的 Modal（不是自造遮罩）");
assert.equal(closedTree.props.open, false, "关闭态 open=false");
assert.equal(closedTree.props.title, "系统提示词注入");
assert.equal(closedTree.props.closeLabel, "关闭");
assert.equal(closedTree.children[0].props["data-pin"], "inject-panel", "内容随 Modal 构建，显隐由 open 控制");
ok("shell.overlay 面板：primitives Modal、open=false、内容 data-pin=inject-panel");

globalThis.document = buttonApp11.doc;
const buttonTree11 = buttonApp11.mount(buttonReg11.component, buttonReg11.options.inject(SESSION_ID));
await flush(2);
fire(byPin(buttonTree11, "inject-button")[0], "onClick");
await flush(30);
const openTree = panelApp.tree;
assert.equal(openTree.props.open, true, "点开场区按钮 → Modal open 变 true");
const openBody = openTree.children[0];
const rows11 = byPin(openBody, "inject-row");
assert.equal(rows11.length, 3, "三条规则全部列出（停用的也列）");
const checkedIds = () => findAll(panelApp.tree, (node) => node.props["data-pin"] === "inject-rule" && node.props.checked === true)
  .map((node) => node.props["data-rule-id"]);
assert.deepEqual(checkedIds(), ["r-a"], "无覆盖时按服务端 defaultRuleIds 预勾选");
assert.deepEqual(byPin(openBody, "inject-name").map((node) => textOf(node)), ["规则甲", "r-b", "停用规则"], "name 为空时显示 id");
const offRow = rows11.filter((node) => node.props["data-rule-id"] === "r-off")[0];
assert.equal(textOf(byPin(offRow, "inject-off")[0]), "已停用", "停用规则要有「已停用」标注");
assert.equal(byPin(offRow, "inject-rule")[0].props.checked, false, "停用规则默认不勾选");
assert.ok(classOf(byPin(offRow, "inject-rule")[0]).split(/\s+/).includes("pinin-check"), "面板勾选框用面板自己的类名：" + classOf(byPin(offRow, "inject-rule")[0]));
assert.equal(byPin(openBody, "inject-hint").length, 0, "面板顶部不再有说明小字");
assert.equal(openTree.props.description, undefined, "Modal 自己也不再带 description（标题下方没有第二段说明）");
ok("Modal 收到的 props 里没有非空 description：弹窗顶部只有标题与「关闭」按钮");
const gets11 = fetchStub11.calls.filter((call) => call.method === "GET");
assert.equal(gets11.length, 1, "打开面板拉一次会话状态");
assert.equal(gets11[0].url, SESSION_URL, "GET 带 sessionId 查询参数");
ok("打开面板：GET " + SESSION_URL + " → 3 行（含「已停用」）、默认勾选 defaultRuleIds、name 空回退 id、顶部无说明小字");

fire(byPin(panelApp.tree.props.footer, "inject-close")[0], "onClick");
await flush(6);
assert.equal(panelApp.tree.props.open, false, "「关闭」把 Modal 的 open 改回 false");
ok("关闭按钮 → Modal open=false（同一次驱动里可反复开关）");

// ══ 12. 勾选 → 自定义文本 → 保存 → 重拉 ════════════════════════════════
section("12. 勾选 → 自定义文本 → 保存 → 重拉");
fire(byPin(buttonApp11.tree, "inject-button")[0], "onClick");
await flush(30);
assert.equal(panelApp.tree.props.open, true, "再次打开面板");
const ruleBox = (id) => findAll(panelApp.tree, (node) => node.props["data-pin"] === "inject-rule" && node.props["data-rule-id"] === id)[0];
const getsBefore12 = fetchStub11.calls.filter((call) => call.method === "GET").length;
fire(ruleBox("r-b"), "onChange", toggleEvent(true));
await flush(4);
fire(byPin(panelApp.tree, "inject-custom")[0], "onChange", inputEvent("  这是本次会话专用的补充说明。  "));
await flush(4);
assert.equal(byPin(panelApp.tree, "inject-custom")[0].props.value, "  这是本次会话专用的补充说明。  ", "textarea 是受控的");
fire(byPin(panelApp.tree.props.footer, "inject-save")[0], "onClick");
await flush(40);
assert.equal(store11.posts.length, 1, "保存只 POST 一次");
assert.deepEqual(store11.posts[0], {
  sessionId: SESSION_ID,
  ruleIds: ["r-a", "r-b"],
  customText: "这是本次会话专用的补充说明。",
}, "POST body：sessionId + 按配置顺序的 ruleIds + trim 后的 customText");
assert.equal(fetchStub11.calls.filter((call) => call.method === "GET").length, getsBefore12 + 1, "保存后重新拉一次会话状态");
assert.deepEqual(checkedIds(), ["r-a", "r-b"], "重拉后勾选来自 override");
assert.equal(byPin(panelApp.tree, "inject-custom")[0].props.value, "", "保存成功清空自定义文本");
assert.ok(textOf(byPin(panelApp.tree, "inject-notice")[0]).includes("已保存"), "保存成功要有提示");
assert.equal(byPin(panelApp.tree, "inject-override-note").length, 1, "有覆盖时显示覆盖说明");
ok("勾选 r-b + 自定义文本 → POST {sessionId, ruleIds:[r-a,r-b], customText} → 重拉 GET，override 生效");

// ══ 13. 清除覆盖（DELETE）与错误行 ═════════════════════════════════════
section("13. 清除覆盖（DELETE）与错误行");
fire(byPin(panelApp.tree.props.footer, "inject-reset")[0], "onClick");
await flush(40);
const deleteCalls = fetchStub11.calls.filter((call) => call.method === "DELETE");
assert.equal(deleteCalls.length, 1, "清除覆盖只发一次 DELETE");
assert.equal(deleteCalls[0].url, SESSION_URL, "DELETE 带 sessionId");
assert.equal(deleteCalls[0].init.body, undefined, "DELETE 不带 body");
assert.equal(store11.override, null, "宿主侧覆盖已清空");
assert.ok(textOf(byPin(panelApp.tree, "inject-notice")[0]).includes("已清除"), "清除成功要有提示");
assert.equal(byPin(panelApp.tree, "inject-override-note").length, 0, "清除后不再显示覆盖说明");
ok("「清除本会话覆盖」→ DELETE " + SESSION_URL + " → 重拉回到条件命中");

globalThis.fetch = createFetch({
  ["GET " + SESSION_URL]: () => jsonResponse(200, sessionFixture(store11, SESSION_ID)),
  ["POST " + SESSION_POST]: () => jsonResponse(400, { ok: false, error: "unknown rule id" }),
});
fire(byPin(panelApp.tree.props.footer, "inject-save")[0], "onClick");
await flush(30);
const errorRow = byPin(panelApp.tree, "inject-error")[0];
assert.ok(errorRow, "保存失败必须在面板里显示错误行");
assert.ok(textOf(errorRow).includes("unknown rule id"), "错误行要带宿主原文：" + textOf(errorRow));
assert.equal(panelApp.tree.props.open, true, "出错不得把面板关掉");
ok("POST 400 { error:'unknown rule id' } → 面板内错误行（不吞异常、不关面板）");

// ══ 14. 无 sessionId：近似口径 + 暂存后补发 ═══════════════════════════
section("14. 无 sessionId：近似口径预勾选 + 暂存后补发");
const store14 = { override: null, rules: SESSION_RULES, defaultRuleIds: ["r-a"], posts: [] };
let preDefaults14 = ["r-a", "r-b"];
const fetchStub14 = createFetch({
  ["GET " + SESSION_PRE_URL]: () => jsonResponse(200, {
    ok: true,
    sessionId: null,
    override: null,
    defaultRuleIds: preDefaults14,
    rules: SESSION_RULES,
  }),
  ["GET " + SESSION_URL]: () => jsonResponse(200, sessionFixture(store14, SESSION_ID)),
  ["POST " + SESSION_POST]: (init) => {
    const body = JSON.parse(init.body);
    store14.posts.push(body);
    store14.override = { ruleIds: body.ruleIds.slice() };
    return jsonResponse(200, { ok: true, session: sessionFixture(store14, SESSION_ID) });
  },
});
globalThis.fetch = fetchStub14;
const m14 = freshModule();
const panelApp14 = createHarness();
const heroApp14 = createHarness();
globalThis.document = panelApp14.doc;
panelApp14.mount(m14.slot("shell.overlay").component, {});
await flush(2);
const heroReg14 = m14.slot("conversation.hero.options");
globalThis.document = heroApp14.doc;
heroApp14.mount(heroReg14.component, heroReg14.options.inject(undefined));
await flush(2);
fire(byPin(heroApp14.tree, "inject-button")[0], "onClick");
await flush(30);
assert.equal(panelApp14.tree.props.open, true, "新会话空状态（hero）也能打开面板");
const gets14 = fetchStub14.calls.filter((call) => call.method === "GET");
assert.equal(gets14.length, 1);
assert.equal(gets14[0].url, SESSION_PRE_URL, "没有 sessionId 时不带查询参数");
const checked14 = () => findAll(panelApp14.tree, (node) => node.props["data-pin"] === "inject-rule" && node.props.checked === true)
  .map((node) => node.props["data-rule-id"]);
const box14 = (id) => findAll(panelApp14.tree, (node) => node.props["data-pin"] === "inject-rule" && node.props["data-rule-id"] === id)[0];
assert.deepEqual(checked14(), ["r-a", "r-b"], "无 sessionId 时按所有 enabled 规则预勾选");
assert.equal(box14("r-off").props.checked, false, "停用规则仍不预勾");
assert.equal(byPin(panelApp14.tree, "inject-hint").length, 0, "会话创建前也不再挂那行说明小字");
assert.ok(textOf(byPin(panelApp14.tree.props.footer, "inject-foot")[0]).includes("会话未创建：保存会先暂存"), "近似口径只剩页脚那一句状态话");
ok("hero 态打开面板：GET 不带 query、按 enabled 规则预勾选、近似口径只在页脚「暂存」那一句里");

preDefaults14 = [];
fire(byPin(panelApp14.tree.props.footer, "inject-close")[0], "onClick");
await flush(6);
fire(byPin(heroApp14.tree, "inject-button")[0], "onClick");
await flush(30);
assert.deepEqual(checked14(), ["r-a", "r-b"], "宿主没给 defaultRuleIds 时本地兜底为所有 enabled 规则");
assert.equal(box14("r-off").props.checked, false, "兜底也不勾停用规则");
ok("defaultRuleIds 为空时本地兜底：所有 enabled 规则预勾选，停用规则仍不勾");

fire(box14("r-off"), "onChange", toggleEvent(true));
await flush(4);
fire(byPin(panelApp14.tree.props.footer, "inject-save")[0], "onClick");
await flush(12);
assert.equal(fetchStub14.posts().length, 0, "没有 sessionId 时不得 POST");
assert.ok(textOf(byPin(panelApp14.tree, "inject-notice")[0]).includes("已暂存"), "先暂存并提示");
ok("没有 sessionId：保存只暂存（0 次 POST）并提示「已暂存」");

heroApp14.unmount();
heroApp14.mount(heroReg14.component, heroReg14.options.inject(SESSION_ID));
await flush(60);
assert.equal(fetchStub14.posts().length, 1, "sessionId 出现后把暂存的选择补发一次");
assert.deepEqual(JSON.parse(fetchStub14.posts()[0].init.body), {
  sessionId: SESSION_ID,
  ruleIds: ["r-a", "r-b", "r-off"],
}, "补发的 body 用新 sessionId + 暂存的选择");
assert.deepEqual(checked14(), ["r-a", "r-b", "r-off"], "补发后勾选落到宿主返回的 override");
ok("首句发送后 sessionId 出现 → 暂存的选择自动 POST 一次给宿主");

// ══ 15. 渲染期异常兜底与卸载安全 ══════════════════════════════════════
section("15. 渲染期异常兜底与卸载安全");
const m15 = freshModule();
const crashApp = createHarness();
globalThis.document = crashApp.doc;
globalThis.fetch = async () => jsonResponse(200, { ok: true, sessionId: null, override: null, defaultRuleIds: [], rules: [] });
const poisonedProps = {};
Object.defineProperty(poisonedProps, "sessionId", {
  enumerable: true,
  get() {
    throw new Error("props 读崩了");
  },
});
const crashTree = crashApp.mount(m15.slot("conversation.hero.options").component, poisonedProps);
await flush(2);
assert.equal(crashApp.errors.length, 0, "props getter 抛错不得冒到渲染外：" + crashApp.errors.map(String).join("; "));
assert.ok(isElement(crashTree), "props 异常时按钮仍然渲染");
assert.equal(byPin(crashTree, "inject-button")[0].props["data-session"], "");
ok("props.sessionId 的 getter 抛错：兜底为 undefined，按钮照常渲染（0 异常）");
crashApp.unmount();

const m15b = freshModule();
const latePanelApp = createHarness();
const lateButtonApp = createHarness();
globalThis.document = latePanelApp.doc;
globalThis.fetch = () => new Promise((resolve) => {
  setTimeout(() => {
    resolve(jsonResponse(200, { ok: true, sessionId: null, override: null, defaultRuleIds: ["r-a"], rules: SESSION_RULES }));
  }, 30);
});
latePanelApp.mount(m15b.slot("shell.overlay").component, {});
const lateButtonReg = m15b.slot("conversation.hero.options");
globalThis.document = lateButtonApp.doc;
lateButtonApp.mount(lateButtonReg.component, lateButtonReg.options.inject("sess-late"));
await flush(2);
fire(byPin(lateButtonApp.tree, "inject-button")[0], "onClick");
await flush(1);
const rendersBefore15 = latePanelApp.renderCount;
latePanelApp.unmount();
await flush(20);
assert.deepEqual(latePanelApp.violations, [], "面板卸载后不得 setState");
assert.equal(latePanelApp.renderCount, rendersBefore15, "面板卸载后不得再渲染");
ok("面板卸载后 30ms 的 GET 到达：0 次 setState、0 次渲染");
lateButtonApp.unmount();

// ══ 15.5 候选值兜底：/options 缺列 → 内置保底 ══════════════════════════
section("15.5 /options 缺列：内置保底补满，老 id 照样成 chip");
const orphanConfig = () => ({
  ok: true,
  config: {
    version: 1,
    enabled: true,
    rules: [{
      id: "r-orphan",
      name: "老数据",
      enabled: true,
      text: "正文。",
      when: { presets: ["liangshen"], efforts: [], permissions: ["gone-id"] },
    }],
  },
});
const openFirstRule = async (app) => {
  if (byPin(ruleNodes(app.tree)[0], "rule-delete").length === 0) {
    fire(byPin(ruleNodes(app.tree)[0], "rule-toggle")[0], "onClick");
    await flush();
  }
  return ruleNodes(app.tree)[0];
};

const emptyApp = createHarness();
globalThis.document = emptyApp.doc;
globalThis.fetch = createFetch({
  ["GET " + CONFIG_URL]: () => jsonResponse(200, orphanConfig()),
  ["GET " + OPTIONS_URL]: () => jsonResponse(200, { ok: true, presets: OPTIONS_FIXTURE.presets, efforts: [], permissions: [] }),
});
emptyApp.mount(Card, { close() {} });
await flush(2);
const orphan = await openFirstRule(emptyApp);

const emptyDim = dimOf(orphan, "efforts");
assert.deepEqual(chipLabels(emptyDim), ["低", "中", "高"], "efforts 返回空数组 ⇒ 内置三档补满，显示中文");
assert.ok(chipsOf(emptyDim).length >= 3, "候选永远非空：efforts 至少 3 个 chip");
assert.equal(byPin(emptyDim, "opts-empty").length, 0, "不再有空态提示节点");
assert.equal(dimAllButton(emptyDim).props.disabled, undefined, "候选非空时全选按钮不再 disabled");
assert.equal(textOf(emptyDim).includes("宿主没有提供候选值"), false, "维度里不得出现空态文案");

const orphanDim = dimOf(orphan, "permissions");
assert.deepEqual(chipLabels(orphanDim), ["仅可查看", "工作区内修改", "完全权限", "自动审查", "gone-id"], "内置保底在前，候选表外的老 id 排在最后照样成 chip");
assert.deepEqual(checkedChips(orphanDim), ["gone-id"], "老 id 显示为勾选");
assert.equal(textOf(dimAllButton(orphanDim)), "全选", "只勾了老 id ⇒ 按钮是「全选」");
assert.deepEqual(emptyApp.errors, [], "空候选下渲染不得抛错");
ok("/options 缺 efforts / permissions ⇒ 内置保底补满（3 与 5 个 chip），老 id 仍在且勾选，0 空态文案");
emptyApp.unmount();

// ══ 15.6 /options 整体不可用 → 三个维度照样有 chip ═══════════════════════
section("15.6 /options 请求失败：三个维度都还有保底候选");
const noOptApp = createHarness();
globalThis.document = noOptApp.doc;
globalThis.fetch = createFetch({
  ["GET " + CONFIG_URL]: () => jsonResponse(200, orphanConfig()),
  ["GET " + OPTIONS_URL]: () => jsonResponse(500, { ok: false, error: "options 挂了" }),
});
noOptApp.mount(Card, { close() {} });
await flush(2);
const noOptRule = await openFirstRule(noOptApp);
for (const key of ["presets", "efforts", "permissions"]) {
  const dimNode = dimOf(noOptRule, key);
  assert.ok(chipsOf(dimNode).length >= 3, key + " 在 /options 失败时也必须 ≥3 个 chip，实际 " + chipsOf(dimNode).length);
  assert.equal(byPin(dimNode, "opts-empty").length, 0, key + " 不该再有空态节点");
  assert.equal(textOf(dimAllButton(dimNode)).length > 0, true, key + " 的全选按钮正常渲染");
}
assert.deepEqual(chipLabels(dimOf(noOptRule, "presets")), ["标准模式", "PTC 模式", "极简模式", "创造模式", "liangshen"], "全部保底 + 草稿里的老 id，老 id 的 label 回落 id");
assert.ok(textOf(byPin(noOptApp.tree, "load-error")[0]).includes("候选值读取失败"), "/options 失败仍要有错误条（不静默）");
assert.deepEqual(noOptApp.errors, [], "options 失败下渲染不得抛错");
ok("/options 500 ⇒ 三个维度各有 ≥3 个 chip，配置照常可编辑，错误条说明候选值读取失败");
noOptApp.unmount();

// ══ 15.7 顶部总开关的文案：启用 / 不启用 ═════════════════════════════════
section("15.7 顶部总开关小字：启用 / 不启用");
const toggleApp = createHarness();
globalThis.document = toggleApp.doc;
globalThis.fetch = createFetch({
  ["GET " + CONFIG_URL]: () => jsonResponse(200, orphanConfig()),
  ["GET " + OPTIONS_URL]: () => jsonResponse(200, OPTIONS_FIXTURE),
});
toggleApp.mount(Card, { close() {} });
await flush(2);
const subSpans = () => findAll(toggleApp.tree, (node) => node.type === "span" && classOf(node) === "pin-sub");
assert.equal(subSpans().length, 1, "卡片里只剩总开关这一处小字，实际 " + subSpans().length);
assert.equal(textOf(subSpans()[0]), "启用", "enabled:true ⇒ 「启用」");
fire(byPin(toggleApp.tree, "enabled")[0], "onChange", toggleEvent(false));
await flush(4);
assert.equal(textOf(subSpans()[0]), "不启用", "关掉开关 ⇒ 「不启用」");
fire(byPin(toggleApp.tree, "enabled")[0], "onChange", toggleEvent(true));
await flush(4);
assert.equal(textOf(subSpans()[0]), "启用", "再打开 ⇒ 回到「启用」");
ok("总开关小字随 draft.enabled 在「启用 / 不启用」间切换，卡片内只此一处小字");
toggleApp.unmount();

// ══ 15.8 输入框上方按钮：dock 注册与它打开的面板 ═══════════════════════
section("15.8 输入框上方按钮：conversation.composer.dock");
const storeView15 = { override: null, rules: SESSION_RULES, defaultRuleIds: ["r-a"] };
const fetchView15 = createFetch({
  ["GET " + SESSION_URL]: () => jsonResponse(200, sessionFixture(storeView15, SESSION_ID)),
  ["POST " + SESSION_POST]: (init) => {
    const body = JSON.parse(init.body);
    storeView15.override = { ruleIds: body.ruleIds.slice() };
    return jsonResponse(200, { ok: true, session: sessionFixture(storeView15, SESSION_ID) });
  },
});
globalThis.fetch = fetchView15;
const mView15 = freshModule();
const dockReg15 = mView15.slot("conversation.composer.dock");
assert.ok(dockReg15, "composer.dock 必须已注册");
const dockApp15 = createHarness();
globalThis.document = dockApp15.doc;
const dockTree15 = dockApp15.mount(dockReg15.component, dockReg15.options.inject(SESSION_ID));
await flush(6);
assert.equal(dockApp15.errors.length, 0, "按钮渲染不得抛错：" + dockApp15.errors.map(String).join("; "));
const dockBtn15 = byPin(dockTree15, "inject-button")[0];
assert.ok(dockBtn15, "按钮必须带 data-pin=inject-button");
assert.equal(textOf(dockBtn15), "系统提示词注入");
assert.equal(dockBtn15.props["data-session"], SESSION_ID, "按钮记下会话 id");
assert.ok(classOf(byPin(dockTree15, "inject-launcher")[0]).split(/\s+/).includes("pinin-launcher"), "外壳用 .pinin-launcher");
fire(dockBtn15, "onClick");
await flush(4);
assert.equal(dockApp15.errors.length, 0, "点击不得抛错：" + dockApp15.errors.map(String).join("; "));
ok("dock 按钮：data-session 正确、外壳 .pinin-launcher、点击打开桥");

const overlayReg15 = mView15.slot("shell.overlay");
const panelApp15 = createHarness();
globalThis.document = panelApp15.doc;
panelApp15.mount(overlayReg15.component, {});
await flush(30);
assert.equal(panelApp15.errors.length, 0, "面板渲染不得抛错：" + panelApp15.errors.map(String).join("; "));
assert.ok(byPin(panelApp15.tree, "inject-list")[0], "面板里是同一套 inject-list");
assert.equal(byPin(panelApp15.tree, "inject-row").length, 3, "三条规则全部列出");
const panelChecked15 = () => findAll(panelApp15.tree, (node) => node.props["data-pin"] === "inject-rule" && node.props.checked === true)
  .map((node) => node.props["data-rule-id"]);
assert.deepEqual(panelChecked15(), ["r-a"], "预勾选跟着宿主的 defaultRuleIds");
assert.ok(byPin(panelApp15.tree, "inject-custom")[0], "自定义文本域在面板里");
assert.equal(byPin(panelApp15.tree, "inject-hint").length, 0, "面板没有说明小字");
const getsView15 = fetchView15.calls.filter((call) => call.method === "GET");
assert.equal(getsView15.length, 1, "面板挂载拉一次会话状态");
assert.equal(getsView15[0].url, SESSION_URL, "GET 带 sessionId —— 来自按钮写进桥的会话 id");
ok("面板：三行勾选 + 自定义文本域 + 只拉一次 /session");

fire(byPin(panelApp15.tree, "inject-rule")[1], "onChange", toggleEvent(true));
await flush(4);
fire(byPin(panelApp15.tree.props.footer, "inject-save")[0], "onClick");
await flush(12);
assert.equal(fetchView15.posts().length, 1, "保存直接 POST 给宿主");
assert.deepEqual(JSON.parse(fetchView15.posts()[0].init.body), {
  sessionId: SESSION_ID,
  ruleIds: ["r-a", "r-b"],
}, "POST 用桥里的 sessionId");
ok("面板保存：POST /session（sessionId 来自桥）");
panelApp15.unmount();
dockApp15.unmount();

const bareDockApp15 = createHarness();
globalThis.document = bareDockApp15.doc;
globalThis.fetch = async () => jsonResponse(200, { ok: true, sessionId: null, override: null, defaultRuleIds: [], rules: SESSION_RULES });
const mBare15 = freshModule();
const bareReg15 = mBare15.slot("conversation.composer.dock");
const bareTree15 = bareDockApp15.mount(bareReg15.component, {});
await flush(6);
assert.equal(bareDockApp15.errors.length, 0, "没有 sessionId 时按钮不得抛错");
assert.ok(byPin(bareTree15, "inject-button")[0], "没有 sessionId 时按钮照旧渲染");
assert.equal(byPin(bareTree15, "inject-button")[0].props["data-session"], "", "没有会话时 data-session 是空串");
ok("无 sessionId：按钮仍然渲染（data-session 空）");
bareDockApp15.unmount();

// ══ 16. 全局清洁 ══════════════════════════════════════════════════════
section("16. 全局清洁");
assert.deepEqual(consoleErrors, [], "整个过程不得 console.error：" + consoleErrors.join(" | "));
assert.deepEqual(unhandled, [], "不得有未处理的 Promise 拒绝：" + unhandled.map(String).join(" | "));
const bundleText = readFileSync(BUNDLE, "utf8");
assert.equal(/["']pin-check["']/.test(bundleText), false, "全文件不得再出现已删除的 pin-check 类名");
for (const gone of ["pin-chip-input", "pin-chip-on", "pin-custom", "effort-custom", "effort-add", '"chip"']) {
  assert.equal(bundleText.includes(gone), false, "已删除的类名 / data-pin 不该再出现：" + gone);
}
ok("删除干净的旧类名：" + ["pin-chip-input", "pin-chip-on", "pin-custom", "effort-custom", "effort-add", "data-pin=chip"].join(" / "));
// 本轮删掉的三处装饰小字、空态文案、旧开关文案：全文件一个都不许留
for (const gone of ["规则按顺序追加到系统提示词末尾", "未保存的改动只在本页有效", "先按「所有启用规则」预勾选", "勾选只影响当前会话", "宿主没有提供候选值", "已开启", "已关闭", "会话还没创建：先选好", "勾选本次会话要注入的提示词"]) {
  assert.equal(bundleText.includes(gone), false, "不该再出现：" + gone);
}
ok("三处装饰小字 + 「宿主没有提供候选值」+ 已开启/已关闭 全部清干净");
const cssText = firstDoc.styles[0].textContent;
// 反向断言：三段控件与下拉的痕迹（类名 / data-pin / 文案）必须清干净
for (const gone of ["pin-tri", "pin-dd", 'data-pin="tri"', "不设", "指定", "选择…"]) {
  assert.equal(bundleText.includes(gone), false, "旧三段/下拉的痕迹必须清干净：" + gone);
}
assert.equal(cssText.includes(".pin-tri"), false, "样式表里不该再有 .pin-tri");
assert.equal(cssText.includes(".pin-dd"), false, "样式表里不该再有 .pin-dd");
// 新 chip 样式在，且只用 var(--dsw-alias-*) 取色、不带 !important
assert.equal(cssText.includes(".pin-opts-empty"), false, "样式表里不该再有 .pin-opts-empty");
assert.equal(cssText.includes(".pin-desc"), false, "样式表里不该再有 .pin-desc（副标题已删）");
assert.ok(cssText.includes(".pin-sub{"), ".pin-sub 仍被会话面板的覆盖说明使用，样式保留");
for (const rule of [".pin-opts{", ".pin-opt{", ".pin-opt-on{", ".pin-opt-check{", ".pin-link-btn{", ".pin-link-btn:hover:not(:disabled){", ".pin-link-btn:disabled{"]) {
  const at = cssText.indexOf(rule);
  assert.ok(at >= 0, "缺少样式：" + rule);
  const body = cssText.slice(at, cssText.indexOf("}", at) + 1);
  assert.equal(/rgba?\(|#[0-9a-fA-F]{3,8}/.test(body), false, "新样式只能用 var() 取色：" + rule);
  assert.equal(body.includes("!important"), false, "新样式不许用 !important：" + rule);
}
assert.equal(/#[0-9a-fA-F]{3,8}/.test(cssText), false, "样式表里不得出现 hex 颜色");
assert.ok(cssText.includes(".pin-dim-head{display:flex;align-items:center;justify-content:space-between;gap:6px}"), "维度头用 space-between 把全选按钮推到右侧");
assert.ok(cssText.includes(".pin-chevron"), "折叠行的 chevron 样式保留");
assert.ok(cssText.includes(".pin-rule-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}"), "折叠行整条有 hover 底色");
assert.ok(cssText.includes(".pin-rule-title") && /\.pin-rule-title\{[^}]*font-weight:500/.test(cssText), "规则名 14/22 且字重 500");
ok("chip 样式齐全且只用 var() 取色；三段/下拉的痕迹全部消失：" + cssText.length + " 字节 CSS");
ok("0 次 console.error，0 个 unhandledRejection");

console.error = originalConsoleError;
console.log("\n全部通过：client-bundle.mjs " + checks + "/" + checks + " 检查（0 失败）");
