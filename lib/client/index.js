/**
 * dsh-prompt-inject —— 浏览器半区：设置页里的一张「提示词注入」卡片。
 *
 * 手写 ModuleLoader bundle（零构建、零依赖），宿主 baseline 的 require 白名单里
 * 只用到 react。数据面只有三个 HTTP 端点（见 CONTRACT.md §4），不碰 cordis.patch.yml。
 *
 * 维度语义是**严格三态**（CONTRACT.md §2.1）：'all' | 非空 string[] | 未设。
 * 未设 ⇒ 该规则当前不注入，UI 打「未完成」徽标，但仍允许保存成草稿。
 */
window.__ModuleLoader__.load({
  id: "dsh-prompt-inject",
  factory: (require) => {
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    /** 平台 seed 白名单里的 UI 基元（Modal 从这里来，与 react 同级可 require）。 */
    const primitives = safeRequire("@deepseek-ai/dsh-client-ui-primitives");

    /** 插件短名（与 profile 行 id 一致）。 */
    const name = "prompt-inject";

    /** 样式标签的 data-plugin-css 值，与官方 CSS module 注入协议同形。 */
    const CSS_TAG = "dsh-prompt-inject/settings.css";

    /** 同源接口前缀。 */
    const API = "/api/prompt-inject";

    /** 单个请求的超时（毫秒）。 */
    const TIMEOUT_MS = 8000;

    /** 三个匹配维度，顺序即渲染顺序。 */
    const DIMENSIONS = [
      { key: "presets", label: "模式", note: "agentPreset id" },
      { key: "efforts", label: "推理等级", note: "reasoningEffort" },
      { key: "permissions", label: "权限", note: "permission preset" },
    ];

    /**
     * /options 拿不到（请求失败、返回空数组、老宿主不给 label）时的保底候选。
     * 候选永远非空：界面不再有「没有候选值」这种空态。
     */
    const FALLBACK_OPTIONS = {
      presets: [
        { id: "standard", label: "标准模式" },
        { id: "ptc", label: "PTC 模式" },
        { id: "minimal", label: "极简模式" },
        { id: "cordis", label: "创造模式" },
      ],
      efforts: [
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" },
      ],
      permissions: [
        { id: "read-only", label: "仅可查看" },
        { id: "workspace-write", label: "工作区内修改" },
        { id: "danger-full-access", label: "完全权限" },
        { id: "auto", label: "自动审查" },
      ],
    };

    /** 三个维度都取 "all" 才等于「所有会话」。 */
    const ALL_DIMS = { presets: "all", efforts: "all", permissions: "all" };

    const CSS = [
      ".pin{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}",
      ".pin-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}",
      ".pin-head-text{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".pin-head-actions{display:inline-flex;align-items:center;gap:8px;flex-shrink:0;padding-top:2px}",
      ".pin-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}",
      ".pin-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".pin-dirty{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}",
      ".pin-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary)}",
      ".pin-group{display:flex;flex-direction:column;padding:14px 16px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:16px;background:var(--dsw-alias-settings-card-fill)}",
      ".pin-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}",
      ".pin-row:last-child{border-bottom:none}",
      ".pin-row-text{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".pin-row-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}",
      ".pin-rule{display:flex;flex-direction:column;border-bottom:0.5px solid var(--dsw-alias-border-l2)}",
      ".pin-rule:last-child{border-bottom:none}",
      ".pin-rule-row{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:0 -8px;padding:12px 8px;border-radius:12px;cursor:pointer;color:inherit}",
      ".pin-rule-row:focus-visible{outline:none;border-radius:12px;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}",
      ".pin-rule-text{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".pin-rule-title-row{display:flex;align-items:center;gap:6px;min-width:0}",
      ".pin-rule-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px}",
      ".pin-rule-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".pin-rule-summary-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".pin-rule-end{display:inline-flex;align-items:center;gap:12px;flex-shrink:0}",
      ".pin-chevron{width:7px;height:7px;margin-top:-3px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .15s ease}",
      ".pin-chevron-open{margin-top:3px;transform:rotate(-135deg)}",
      ".pin-editor{display:flex;flex-direction:column;gap:14px;margin:0 0 16px;padding:14px 16px;border-radius:16px;background:var(--dsw-alias-bg-module-platform)}",
      ".pin-field{display:flex;flex-direction:column;gap:6px}",
      ".pin-field-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".pin-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;outline:none}",
      ".pin-textarea{box-sizing:border-box;width:100%;min-height:88px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;outline:none;resize:vertical}",
      ".pin-input:focus,.pin-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}",
      ".pin-input::placeholder,.pin-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".pin-dims{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}",
      ".pin-dim{display:flex;flex-direction:column;gap:6px;flex:1 1 180px;min-width:0}",
      ".pin-dim-head{display:flex;align-items:center;justify-content:space-between;gap:6px}",
      ".pin-dim-head-main{display:inline-flex;align-items:center;gap:6px;min-width:0}",
      ".pin-dim-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".pin-dot-warn{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);flex-shrink:0}",
      ".pin-link-btn{height:22px;padding:0 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
      ".pin-link-btn:hover:not(:disabled){color:var(--dsw-alias-brand-primary)}",
      ".pin-link-btn:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}",
      ".pin-opts{display:flex;flex-wrap:wrap;gap:6px}",
      ".pin-opt{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}",
      ".pin-opt-on{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}",
      ".pin-opt-check{width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex-shrink:0}",
      ".pin-rule-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".pin-spacer{flex:1;min-width:8px}",
      ".pin-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer}",
      ".pin-btn:disabled{opacity:.4;cursor:default}",
      ".pin-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}",
      ".pin-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}",
      ".pin-btn-sm{height:28px;padding:0 10px;border-radius:8px;font-size:12px;line-height:18px}",
      ".pin-switch-slot{display:inline-flex;align-items:center;flex-shrink:0}",
      ".pin-switch{position:relative;display:inline-flex;align-items:center;flex-shrink:0;cursor:pointer}",
      ".pin-switch-input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}",
      ".pin-switch-track{box-sizing:border-box;position:relative;display:block;width:36px;height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;transition:background .15s ease,border-color .15s ease}",
      ".pin-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s ease,background .15s ease}",
      ".pin-switch-on{border-color:transparent;background:var(--dsw-alias-button-primary-fill)}",
      ".pin-switch-on .pin-switch-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}",
      ".pin-switch:focus-within .pin-switch-track{box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}",
      ".pin-badge{display:inline-flex;align-items:center;flex-shrink:0;padding:1px 7px;border-radius:999px;font-size:11px;line-height:16px}",
      ".pin-badge-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}",
      ".pin-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}",
      ".pin-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".pin-notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".pin-foot{display:inline-flex;align-items:center;gap:8px;flex-shrink:0}",
      ".pin-empty{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}",
      "@media (hover:hover){.pin-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.pin-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.pin-rule-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.pin-rule-row:hover .pin-rule-title{color:var(--dsw-alias-state-business-primary)}}",
      ".pinin-launcher{display:flex;align-items:center;gap:8px;padding:2px 0 0}",
      ".pinin-launcher-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:18px;cursor:pointer}",
      ".pinin-launcher-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".pinin-launcher-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".pinin-panel{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
      ".pinin-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
      ".pinin-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer}",
      ".pinin-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".pinin-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pinin-check{flex-shrink:0;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}",
      ".pinin-off{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".pinin-tag{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px}",
      ".pinin-field{display:flex;flex-direction:column;gap:6px}",
      ".pinin-field-label{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}",
      ".pinin-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".pinin-empty{padding:8px 0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px}",
      ".pinin-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.36)}",
      ".pinin-dialog{display:flex;flex-direction:column;gap:12px;width:min(560px,100%);max-height:80vh;overflow:auto;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
      ".pinin-dialog-head{display:flex;align-items:center;gap:8px}",
      ".pinin-dialog-head span{flex:1;font-size:15px;line-height:24px;font-weight:500}",
      ".pinin-dialog-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ].join("\n");

    // ── 纯函数：数据整备 ────────────────────────────────────────────────

    /** require 失败只降级，不抛：宿主版本里没有这个包时退回内置替代品。 */
    function safeRequire(id) {
      try {
        return require(id);
      } catch {
        return null;
      }
    }

    function messageOf(error) {
      if (error === null || error === undefined) return "未知错误";
      const text = typeof error === "string"
        ? error
        : error.message === undefined ? String(error) : String(error.message);
      return text.trim() === "" ? "未知错误" : text;
    }

    function isPlainObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** 该维度是否真的生效：CONTRACT.md §2.1 —— 'all' 或非空数组，[]/缺失都不算。 */
    function dimActive(spec) {
      return spec === "all" || (Array.isArray(spec) && spec.length > 0);
    }

    /** 三个维度都生效，规则才可能命中。 */
    function ruleComplete(rule) {
      const when = rule && isPlainObject(rule.when) ? rule.when : {};
      for (const dim of DIMENSIONS) if (!dimActive(when[dim.key])) return false;
      return true;
    }

    /** 未完成规则缺了哪几个维度（拼成一句话）。 */
    function missingLabels(rule) {
      const when = rule && isPlainObject(rule.when) ? rule.when : {};
      const missing = [];
      for (const dim of DIMENSIONS) if (!dimActive(when[dim.key])) missing.push(dim.label);
      return missing.join("、");
    }

    function uniqueStrings(values) {
      const out = [];
      for (const value of values) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed === "" || out.includes(trimmed)) continue;
        out.push(trimmed);
      }
      return out;
    }

    /** 一条规则 → 编辑器状态（when 只保留合法维度，其它一律当成「未设」）。 */
    function adoptRule(raw, index) {
      const rule = isPlainObject(raw) ? raw : {};
      const when = isPlainObject(rule.when) ? rule.when : {};
      const next = {};
      for (const dim of DIMENSIONS) {
        const value = when[dim.key];
        if (value === "all") next[dim.key] = "all";
        else if (Array.isArray(value)) {
          const list = uniqueStrings(value);
          if (list.length > 0) next[dim.key] = list;
        }
      }
      const id = typeof rule.id === "string" && rule.id.trim() !== "" ? rule.id.trim() : "r-" + (index + 1);
      return {
        id,
        name: typeof rule.name === "string" ? rule.name : "",
        enabled: rule.enabled !== false,
        text: typeof rule.text === "string" ? rule.text : "",
        when: next,
      };
    }

    /** 宿主返回的 config → 编辑器状态；宿主缺字段时给可编辑的默认值。 */
    function adoptConfig(raw) {
      const source = isPlainObject(raw) ? raw : {};
      const rules = Array.isArray(source.rules) ? source.rules : [];
      return {
        version: typeof source.version === "number" && Number.isFinite(source.version) ? source.version : 1,
        enabled: source.enabled !== false,
        rules: rules.map(adoptRule),
      };
    }

    /**
     * 编辑器状态 → 提交给宿主的 config（CONTRACT.md §2.1）。
     * 没设置过的维度（undefined）丢掉这个键；显式的空数组照样写 [] —— 它与缺键同为「不注入」，
     * 但只有原样送出去，界面上「一个都没勾」这个动作才是可观测的。
     */
    function serializeConfig(config) {
      const source = isPlainObject(config) ? config : {};
      const rules = Array.isArray(source.rules) ? source.rules : [];
      const outRules = [];
      for (const raw of rules) {
        const rule = isPlainObject(raw) ? raw : {};
        const when = isPlainObject(rule.when) ? rule.when : {};
        const nextWhen = {};
        for (const dim of DIMENSIONS) {
          const value = when[dim.key];
          if (value === "all") nextWhen[dim.key] = "all";
          else if (Array.isArray(value)) nextWhen[dim.key] = uniqueStrings(value);
        }
        outRules.push({
          id: String(rule.id === undefined || rule.id === null ? "" : rule.id),
          name: typeof rule.name === "string" ? rule.name : "",
          enabled: rule.enabled !== false,
          text: typeof rule.text === "string" ? rule.text : "",
          when: nextWhen,
        });
      }
      return {
        version: typeof source.version === "number" && Number.isFinite(source.version) ? source.version : 1,
        enabled: source.enabled !== false,
        rules: outRules,
      };
    }

    /** 稳定的 JSON 指纹，用来算脏标记。 */
    function fingerprint(config) {
      try {
        return JSON.stringify(serializeConfig(config));
      } catch {
        return "";
      }
    }

    function newRuleId(taken) {
      const used = taken || [];
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const random = Math.random().toString(36).slice(2, 8);
        const id = "r-" + (random === "" ? Math.floor(Math.random() * 1e6).toString(36) : random);
        if (!used.includes(id)) return id;
      }
      return "r-" + Date.now().toString(36);
    }

    // ── 纯函数：请求 / 环境 ────────────────────────────────────────────

    function settle(promise) {
      return Promise.resolve(promise).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    }

    async function readPayload(response) {
      if (typeof response.json === "function") return await response.json();
      if (typeof response.text === "function") {
        const text = await response.text();
        return text === "" ? null : JSON.parse(text);
      }
      return null;
    }

    function isOk(response) {
      if (!response) return false;
      if (response.ok === false) return false;
      const status = typeof response.status === "number" ? response.status : 0;
      if (status === 0) return response.ok !== false;
      return status >= 200 && status < 300;
    }

    /**
     * 同源 JSON 请求：超时、非 2xx、非 JSON 全部转成带人话的 Error。
     * 400/403 的 body 里宿主会带 { ok:false, error }，这条 error 就是 UI 要显示的东西。
     */
    function requestJson(url, init) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const fail = (error) => finish(reject, error instanceof Error ? error : new Error(messageOf(error)));
        const timer = setTimeout(() => {
          try {
            if (controller !== null) controller.abort();
          } catch {
            /* abort 只是顺手，超时本身已经判负 */
          }
          fail(new Error("请求超时（" + Math.round(TIMEOUT_MS / 1000) + " 秒）"));
        }, TIMEOUT_MS);
        const controller = typeof AbortController === "function" ? new AbortController() : null;

        let pending;
        try {
          if (typeof fetch !== "function") throw new Error("当前环境没有 fetch");
          const request = init === undefined ? {} : Object.assign({}, init);
          if (controller !== null) request.signal = controller.signal;
          pending = fetch(url, request);
        } catch (error) {
          fail(error);
          return;
        }

        Promise.resolve(pending)
          .then(async (response) => {
            if (!response) {
              fail(new Error("空响应"));
              return;
            }
            let payload = null;
            let parseError = null;
            try {
              payload = await readPayload(response);
            } catch (error) {
              parseError = error;
            }
            const status = typeof response.status === "number" ? response.status : 0;
            if (!isOk(response)) {
              const detail = isPlainObject(payload) && typeof payload.error === "string" ? payload.error : "";
              fail(new Error(detail !== "" ? detail : "HTTP " + status));
              return;
            }
            if (payload === null) {
              fail(parseError === null ? new Error("响应不是合法 JSON") : parseError);
              return;
            }
            finish(resolve, payload);
          })
          .catch(fail);
      });
    }

    function askConfirm(message) {
      try {
        const fn = typeof confirm === "function"
          ? confirm
          : typeof globalThis === "undefined" ? undefined : globalThis.confirm;
        if (typeof fn !== "function") return true;
        return fn(message) === true;
      } catch {
        return true;
      }
    }

    /** 设置外壳的关闭按钮：类名 token 以 _close 结尾（CSS module 哈希）或 aria-label。 */
    function looksLikeClose(button) {
      try {
        const raw = button.className;
        if (typeof raw === "string" && raw !== "") {
          for (const token of raw.split(/\s+/)) if (token !== "" && (token === "close" || /_close$/.test(token))) return true;
        }
        const label = typeof button.getAttribute === "function" ? button.getAttribute("aria-label") : null;
        return typeof label === "string" && /^(关闭|close)$/i.test(label.trim());
      } catch {
        return false;
      }
    }

    /**
     * 样式注入：与官方 CSS module 同一协议（style[data-plugin-css]）。
     * 由 ctx.effect 管生命周期——卸载时把标签摘掉。
     */
    function installStyle() {
      const doc = typeof document === "undefined" ? null : document;
      if (!doc || typeof doc.createElement !== "function" || !doc.head || typeof doc.head.appendChild !== "function") {
        return () => {};
      }
      const selector = "style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]";
      const existing = typeof doc.querySelector === "function" ? doc.querySelector(selector) : null;
      if (existing) return () => {};
      const tag = doc.createElement("style");
      if (typeof tag.setAttribute === "function") {
        tag.setAttribute("data-plugin", "dsh-prompt-inject");
        tag.setAttribute("data-plugin-css", CSS_TAG);
      } else {
        tag.dataset = { plugin: "dsh-prompt-inject", pluginCss: CSS_TAG };
      }
      tag.textContent = CSS;
      doc.head.appendChild(tag);
      return () => {
        try {
          if (typeof tag.remove === "function") tag.remove();
          else if (tag.parentNode && typeof tag.parentNode.removeChild === "function") tag.parentNode.removeChild(tag);
        } catch {
          /* 卸载期摘样式失败不值得再抛 */
        }
      };
    }

    // ── 卡片组件 ──────────────────────────────────────────────────────

    const EMPTY_OPTIONS = { presets: [], permissions: [], efforts: [] };

    /** /options 的一个维度 → [{ id, label }]：缺 label / 空 label 都用 id，id 去重。 */
    function readOptionList(value) {
      const out = [];
      for (const item of Array.isArray(value) ? value : []) {
        const entry = typeof item === "string" ? { id: item } : isPlainObject(item) ? item : null;
        if (entry === null) continue;
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (id === "" || out.some((known) => known.id === id)) continue;
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        out.push({ id, label: label === "" ? id : label });
      }
      return out;
    }

    function readOptions(payload) {
      const source = isPlainObject(payload) ? payload : {};
      const out = {};
      for (const dim of DIMENSIONS) out[dim.key] = readOptionList(source[dim.key]);
      return out;
    }

    /** 候选值 → 每个维度的 { id: label } 表，摘要与触发框里把 id 说成人话。 */
    function labelIndex(options) {
      const out = {};
      for (const dim of DIMENSIONS) {
        const map = {};
        const list = options !== null && options !== undefined && Array.isArray(options[dim.key]) ? options[dim.key] : [];
        for (const entry of list) if (entry !== null && entry !== undefined && typeof entry.id === "string") map[entry.id] = entry.label;
        out[dim.key] = map;
      }
      return out;
    }

    /** 平台 primitives 的 Switch；这一版拿不到就自绘（36×20 轨道 + 14px 滑块）。 */
    const PrimitiveSwitch = isPlainObject(primitives) && typeof primitives.Switch === "function" ? primitives.Switch : null;

    /** 折叠行摘要里的短标签（控件本身仍用 DIMENSIONS 的完整标签）。 */
    const DIM_SHORT = { presets: "模式", efforts: "等级", permissions: "权限" };

    /** 维度标题的悬停提示：原理说明放 title，正文里不再写整句。 */
    const DIM_HINTS = {
      presets: "限制这条提示词在哪些 agentPreset 上生效",
      efforts: "限制这条提示词在哪些推理等级上生效",
      permissions: "限制这条提示词在哪些权限预设上生效",
    };

    /** 一个维度的值 → 显示名，以「、」连接；/options 里没有的 id 原样露出。 */
    function dimValueText(spec, labels) {
      const list = Array.isArray(spec) ? uniqueStrings(spec) : [];
      return list.map((id) => (labels !== undefined && labels[id] !== undefined ? labels[id] : id)).join("、");
    }

    /**
     * 折叠行的一行条件摘要：所有会话 / 仅 梁神模式 / 仅 梁神模式 · 等级 中。
     * 只列被限定的维度，一律用 /options 的 label（拿不到才退回 id）。
     * 正文为空或任一维度没选时整句转 warn —— 界面上唯一保留的「当前不会注入」警告。
     */
    function ruleSummary(rule, index) {
      const when = isPlainObject(rule && rule.when) ? rule.when : {};
      const labels = isPlainObject(index) ? index : {};
      const parts = [];
      let allThree = true;
      for (const dim of DIMENSIONS) {
        if (when[dim.key] !== "all") allThree = false;
        const text = dimValueText(when[dim.key], labels[dim.key]);
        if (text === "") continue;
        parts.push(dim.key === "presets" ? text : DIM_SHORT[dim.key] + " " + text);
      }
      const base = allThree ? "所有会话" : parts.length === 0 ? "" : "仅 " + parts.join(" · ");
      const warns = [];
      const textEmpty = String(rule && typeof rule.text === "string" ? rule.text : "").trim() === "";
      if (textEmpty) warns.push("正文为空");
      const missing = missingLabels(rule);
      if (missing !== "") warns.push(missing + " 未设");
      if (warns.length > 0) {
        return { text: (base === "" ? "" : base + " · ") + warns.join(" · ") + " —— 当前不会注入", warn: true };
      }
      return { text: base, warn: false };
    }

    /** 默认展开的规则：条件没补全，或正文还空着。 */
    function needsAttention(rule) {
      if (!ruleComplete(rule)) return true;
      return String(rule && typeof rule.text === "string" ? rule.text : "").trim() === "";
    }

    /**
     * owner props 只有 { close }（另有若干 useXxx hook props，本卡片不用）。
     * 关闭时的「未保存」拦截不走 props.close —— 外壳自己按那个按钮，接不住；
     * 这里改成 dirty 期间在 document 捕获阶段拦关闭按钮 / Esc（见下面的 effect）。
     */
    function Card(props) {
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState("");
      const [options, setOptions] = useState(EMPTY_OPTIONS);
      const [loadError, setLoadError] = useState("");
      const [saveError, setSaveError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState("");
      const [loadFailed, setLoadFailed] = useState(false);
      /** 折叠态：只记用户显式拨过的那几条，没记过的按 needsAttention 默认，不落盘。 */
      const [expanded, setExpanded] = useState({});
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      // 并发拉 config 与 options：任一失败都只降级，不白屏。
      const load = useCallback(async () => {
        setBusy("load");
        setLoadError("");
        setSaveError("");
        setNotice("");
        const started = [settle(requestJson(API + "/config", { headers: { accept: "application/json" } })), settle(requestJson(API + "/options", { headers: { accept: "application/json" } }))];
        const [configResult, optionsResult] = await Promise.all(started);
        if (!alive.current) return;
        const problems = [];
        if (optionsResult.ok) setOptions(readOptions(optionsResult.value));
        else {
          setOptions(EMPTY_OPTIONS);
          problems.push("候选值读取失败：" + messageOf(optionsResult.error));
        }
        if (configResult.ok) {
          const next = adoptConfig(isPlainObject(configResult.value) ? configResult.value.config : undefined);
          setDraft(next);
          setBaseline(fingerprint(next));
          setLoadFailed(false);
        } else {
          const next = adoptConfig(undefined);
          setDraft(next);
          setBaseline(fingerprint(next));
          setLoadFailed(true);
          problems.push("配置读取失败：" + messageOf(configResult.error));
        }
        setLoadError(problems.join(" · "));
        setBusy("");
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const rules = draft !== null && Array.isArray(draft.rules) ? draft.rules : [];
      const serialized = useMemo(() => (draft === null ? "" : fingerprint(draft)), [draft]);
      const dirty = draft !== null && serialized !== baseline;

      const ruleKey = (rule, index) => (typeof rule.id === "string" && rule.id !== "" ? rule.id : "#" + index);

      const isExpanded = (rule, index) => {
        const key = ruleKey(rule, index);
        if (Object.prototype.hasOwnProperty.call(expanded, key)) return expanded[key] === true;
        return needsAttention(rule);
      };

      const toggleExpanded = (rule, index) => {
        const key = ruleKey(rule, index);
        setExpanded((current) => {
          const open = Object.prototype.hasOwnProperty.call(current, key) ? current[key] === true : needsAttention(rule);
          return Object.assign({}, current, { [key]: !open });
        });
      };

      /** 动过一条规则就把它钉成展开，免得补完条件后编辑器突然折回去。 */
      const markOpen = (index) => {
        const rule = rules[index];
        if (!rule) return;
        const key = ruleKey(rule, index);
        setExpanded((current) => (Object.prototype.hasOwnProperty.call(current, key) ? current : Object.assign({}, current, { [key]: true })));
      };

      const patchRule = (index, patch) => {
        markOpen(index);
        setDraft((current) => {
          if (current === null) return current;
          return Object.assign({}, current, {
            rules: current.rules.map((rule, at) => (at === index ? Object.assign({}, rule, patch) : rule)),
          });
        });
      };

      const setDimension = (index, dimension, value) => {
        markOpen(index);
        setDraft((current) => {
          if (current === null) return current;
          return Object.assign({}, current, {
            rules: current.rules.map((rule, at) => {
              if (at !== index) return rule;
              const when = Object.assign({}, isPlainObject(rule.when) ? rule.when : {});
              if (value === undefined) delete when[dimension];
              else when[dimension] = value;
              return Object.assign({}, rule, { when });
            }),
          });
        });
      };

      /**
       * 勾选 / 取消一个候选：全勾写 "all"，清空写 []（不删键），否则按候选顺序落成数组。
       * 候选表来自 candidateValues（/options + 草稿里用到的旧值），所以老 id 也能逐个取消。
       */
      const toggleChip = (index, dimension, value) => {
        const rule = rules[index];
        if (!rule) return;
        const when = isPlainObject(rule.when) ? rule.when : {};
        const current = when[dimension];
        const known = (candidateValues[dimension] || []).map((entry) => entry.id);
        const base = current === "all" ? known.slice() : Array.isArray(current) ? uniqueStrings(current) : [];
        const at = base.indexOf(value);
        if (at >= 0) base.splice(at, 1);
        else base.push(value);
        const extras = base.filter((id) => !known.includes(id));
        const ordered = known.filter((id) => base.includes(id)).concat(extras);
        const full = known.length > 0 && known.every((id) => base.includes(id));
        setDimension(index, dimension, full && extras.length === 0 ? "all" : ordered);
      };

      /** 一个维度的「全选 / 全不选」：全选写 "all"，全不选写 []（不删键）。 */
      const toggleAllChips = (index, dimension) => {
        const rule = rules[index];
        if (!rule) return;
        const when = isPlainObject(rule.when) ? rule.when : {};
        const current = when[dimension];
        const known = (candidateValues[dimension] || []).map((entry) => entry.id);
        const stored = Array.isArray(current) ? uniqueStrings(current) : [];
        const allOn = current === "all" || (known.length > 0 && known.every((id) => stored.includes(id)));
        setDimension(index, dimension, allOn ? [] : "all");
      };

      const makeAllForAll = (index) => {
        markOpen(index);
        setDraft((current) => {
          if (current === null) return current;
          return Object.assign({}, current, {
            rules: current.rules.map((rule, at) => (at === index ? Object.assign({}, rule, { when: Object.assign({}, ALL_DIMS) }) : rule)),
          });
        });
      };

      const moveRule = (index, delta) => {
        setDraft((current) => {
          if (current === null) return current;
          const target = index + delta;
          if (target < 0 || target >= current.rules.length) return current;
          const next = current.rules.slice();
          const [moved] = next.splice(index, 1);
          next.splice(target, 0, moved);
          return Object.assign({}, current, { rules: next });
        });
      };

      const removeRule = (index) => {
        setDraft((current) => {
          if (current === null) return current;
          return Object.assign({}, current, { rules: current.rules.filter((rule, at) => at !== index) });
        });
      };

      const addRule = () => {
        const id = newRuleId(rules.map((rule) => rule.id));
        const rule = { id, name: "新规则 " + (rules.length + 1), enabled: true, text: "", when: {} };
        setDraft((current) => (current === null ? current : Object.assign({}, current, { rules: current.rules.concat([rule]) })));
        setExpanded((current) => Object.assign({}, current, { [id]: true }));
      };

      const setEnabled = (value) => {
        setDraft((current) => (current === null ? current : Object.assign({}, current, { enabled: value === true })));
      };

      const save = useCallback(async () => {
        if (draft === null) return;
        const config = serializeConfig(draft);
        setBusy("save");
        setSaveError("");
        setNotice("");
        try {
          const payload = await requestJson(API + "/config", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ config }),
          });
          if (!alive.current) return;
          // 契约保证回 { ok:true, config }；万一没带 config，就按刚提交的那份回填，别把草稿清空。
          const returned = isPlainObject(payload) && isPlainObject(payload.config) ? payload.config : config;
          const next = adoptConfig(returned);
          setDraft(next);
          setBaseline(fingerprint(next));
          setLoadFailed(false);
          setNotice("已保存：" + next.rules.length + " 条规则");
        } catch (error) {
          if (!alive.current) return;
          setSaveError("保存失败：" + messageOf(error));
        } finally {
          if (alive.current) setBusy("");
        }
      }, [draft]);

      const discard = useCallback(() => {
        setDraft((current) => {
          if (current === null) return current;
          try {
            return adoptConfig(JSON.parse(baseline));
          } catch {
            return current;
          }
        });
        setSaveError("");
        setNotice("");
      }, [baseline]);

      // 未保存就关闭：拦设置外壳的关闭按钮 / Esc / 页面卸载，别静默丢改动。
      useEffect(() => {
        if (!dirty) return undefined;
        const doc = typeof document === "undefined" ? null : document;
        const win = typeof window === "undefined" ? null : window;
        if (!doc || typeof doc.addEventListener !== "function") return undefined;
        const confirmLeave = () => askConfirm("还有未保存的改动，关闭后会丢失。确定关闭吗？");
        const onClick = (event) => {
          try {
            const target = event && event.target;
            if (!target || typeof target.closest !== "function") return;
            if (target.closest('[data-pin="card"]') !== null) return;
            const button = target.closest("button");
            if (button === null || button === undefined || !looksLikeClose(button)) return;
            if (confirmLeave()) return;
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            if (typeof event.stopPropagation === "function") event.stopPropagation();
            if (typeof event.preventDefault === "function") event.preventDefault();
          } catch {
            /* 拦截失败也不能连累关闭流程 */
          }
        };
        const onKeyDown = (event) => {
          try {
            if (!event) return;
            const escape = event.key === "Escape" || event.key === "Esc" || event.keyCode === 27;
            if (!escape) return;
            if (confirmLeave()) return;
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            if (typeof event.stopPropagation === "function") event.stopPropagation();
            if (typeof event.preventDefault === "function") event.preventDefault();
          } catch {
            /* 同上 */
          }
        };
        const onBeforeUnload = (event) => {
          try {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (event) event.returnValue = "";
            return "";
          } catch {
            return undefined;
          }
        };
        try {
          doc.addEventListener("click", onClick, true);
          doc.addEventListener("keydown", onKeyDown, true);
          if (win && typeof win.addEventListener === "function") win.addEventListener("beforeunload", onBeforeUnload);
        } catch {
          /* 装不上就不能拦，但不该影响编辑 */
        }
        return () => {
          try {
            doc.removeEventListener("click", onClick, true);
            doc.removeEventListener("keydown", onKeyDown, true);
            if (win && typeof win.removeEventListener === "function") win.removeEventListener("beforeunload", onBeforeUnload);
          } catch {
            /* 摘监听失败同样不该抛 */
          }
        };
      }, [dirty]);

      // 候选值 = /options 给的（带 label）→ 内置保底 → 草稿里已经用到的（老值也要看得见、能取消）。
      // 按 id 去重、先到先得 label，所以 /options 的中文名永远压过保底表；三段合并后必然非空。
      const candidateValues = useMemo(() => {
        const out = {};
        for (const dim of DIMENSIONS) {
          const list = [];
          const add = (id, label) => {
            const key = typeof id === "string" ? id.trim() : "";
            if (key === "" || list.some((entry) => entry.id === key)) return;
            const text = typeof label === "string" ? label.trim() : "";
            list.push({ id: key, label: text === "" ? key : text });
          };
          const fromOptions = options && Array.isArray(options[dim.key]) ? options[dim.key] : [];
          for (const entry of fromOptions) {
            if (typeof entry === "string") add(entry, "");
            else if (entry !== null && typeof entry === "object") add(entry.id, entry.label);
          }
          for (const entry of FALLBACK_OPTIONS[dim.key] || []) add(entry.id, entry.label);
          for (const rule of rules) {
            const when = isPlainObject(rule.when) ? rule.when : {};
            const value = when[dim.key];
            if (Array.isArray(value)) for (const entry of uniqueStrings(value)) add(entry, "");
          }
          out[dim.key] = list;
        }
        return out;
      }, [options, rules]);

      const labelValues = useMemo(() => labelIndex(options), [options]);

      /** 启用开关：平台给了 Switch 就用，拿不到就自绘轨道（36×20，滑块 14）。 */
      const renderSwitch = (checked, onChange, label, pin, stopClick) => {
        const on = checked === true;
        if (PrimitiveSwitch !== null) {
          return h(
            "span",
            { key: pin, className: "pin-switch-slot", "data-pin": pin },
            h(PrimitiveSwitch, { checked: on, onChange: (value) => onChange(value === true), label }),
          );
        }
        return h(
          "label",
          {
            key: pin,
            className: "pin-switch",
            title: label,
            onClick: stopClick
              ? (event) => {
                if (event && typeof event.stopPropagation === "function") event.stopPropagation();
              }
              : undefined,
          },
          h("input", {
            type: "checkbox",
            className: "pin-switch-input",
            "data-pin": pin,
            "aria-label": label,
            checked: on,
            onChange: (event) => onChange(event && event.target ? event.target.checked === true : false),
          }),
          h(
            "span",
            { className: "pin-switch-track" + (on ? " pin-switch-on" : ""), "aria-hidden": "true" },
            h("span", { className: "pin-switch-knob" }),
          ),
        );
      };

      const renderDimension = (rule, index, dim) => {
        const when = isPlainObject(rule.when) ? rule.when : {};
        const value = when[dim.key];
        const selected = Array.isArray(value) ? uniqueStrings(value) : [];
        const candidates = candidateValues[dim.key] || [];
        const known = candidates.map((entry) => entry.id);
        const checked = value === "all" ? known : selected;
        const full = candidates.length > 0 && (value === "all" ? true : known.every((id) => selected.includes(id)));

        // 候选表由 candidateValues 兜底，理论上不会空；真空了就整列不出（不写任何提示文案）。
        if (candidates.length === 0) return null;

        const body = candidates.map((candidate) => {
          const on = checked.includes(candidate.id);
          return h(
            "label",
            {
              key: candidate.id,
              className: "pin-opt" + (on ? " pin-opt-on" : ""),
              "data-pin": "opt",
              "data-value": candidate.id,
            },
            h("input", {
              type: "checkbox",
              className: "pin-opt-check",
              "data-pin": "opt-check",
              "data-value": candidate.id,
              checked: on,
              onChange: () => toggleChip(index, dim.key, candidate.id),
            }),
            h("span", { className: "pin-opt-label", "data-pin": "opt-label" }, candidate.label),
          );
        });

        return h(
          "div",
          { className: "pin-dim", key: dim.key, "data-pin": "dim", "data-dim": dim.key },
          h(
            "div",
            { className: "pin-dim-head" },
            h(
              "span",
              { className: "pin-dim-head-main" },
              h("span", { className: "pin-dim-label", title: DIM_HINTS[dim.key] }, dim.label),
              dimActive(value)
                ? null
                : h("span", {
                  className: "pin-dot-warn",
                  "data-pin": "dim-inactive",
                  title: "该维度未选择，规则不会注入",
                }),
            ),
            h(
              "button",
              {
                type: "button",
                className: "pin-link-btn",
                "data-pin": "dim-all",
                "data-dim": dim.key,
                onClick: () => toggleAllChips(index, dim.key),
              },
              full ? "全不选" : "全选",
            ),
          ),
          h("div", { className: "pin-opts", "data-pin": "opts", "data-dim": dim.key, role: "group" }, body),
        );
      };
      const renderRule = (rule, index) => {
        const open = isExpanded(rule, index);
        const summary = ruleSummary(rule, labelValues);
        const complete = ruleComplete(rule);
        const displayName = String(rule.name).trim() === "" ? "未命名规则" : rule.name;
        const enabled = rule.enabled !== false;
        const toggle = () => toggleExpanded(rule, index);

        const head = h(
          "div",
          {
            className: "pin-rule-row",
            "data-pin": "rule-toggle",
            role: "button",
            tabIndex: 0,
            "aria-expanded": open ? "true" : "false",
            onClick: toggle,
            onKeyDown: (event) => {
              if (!event) return;
              const enter = event.key === "Enter" || event.key === " " || event.key === "Spacebar" || event.keyCode === 13 || event.keyCode === 32;
              if (!enter) return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              toggle();
            },
          },
          h(
            "div",
            { className: "pin-rule-text" },
            h("div", { className: "pin-rule-title-row" }, h("span", { className: "pin-rule-title" }, displayName)),
            h("span", { className: "pin-rule-summary" + (summary.warn ? " pin-rule-summary-warn" : ""), "data-pin": "rule-summary" }, summary.text),
          ),
          h(
            "div",
            { className: "pin-rule-end" },
            complete ? null : h("span", { className: "pin-badge pin-badge-warn", "data-pin": "incomplete" }, "未完成"),
            renderSwitch(enabled, (value) => patchRule(index, { enabled: value }), (enabled ? "停用" : "启用") + "「" + displayName + "」", "rule-enabled", true),
            h("span", { className: "pin-chevron" + (open ? " pin-chevron-open" : ""), "aria-hidden": "true" }),
          ),
        );

        const editor = open
          ? h(
            "div",
            { className: "pin-editor", "data-pin": "editor" },
            h(
              "label",
              { className: "pin-field" },
              h("span", { className: "pin-field-label" }, "名称"),
              h("input", {
                type: "text",
                className: "pin-input",
                "data-pin": "rule-name",
                placeholder: "规则名称",
                value: rule.name,
                onChange: (event) => patchRule(index, { name: event && event.target ? event.target.value : "" }),
              }),
            ),
            h(
              "label",
              { className: "pin-field" },
              h("span", { className: "pin-field-label" }, "正文"),
              h("textarea", {
                className: "pin-input pin-textarea",
                "data-pin": "rule-text",
                rows: 4,
                placeholder: "追加到系统提示词末尾的正文",
                value: rule.text,
                onChange: (event) => patchRule(index, { text: event && event.target ? event.target.value : "" }),
              }),
            ),
            h("div", { className: "pin-dims" }, DIMENSIONS.map((dim) => renderDimension(rule, index, dim))),
            h(
              "div",
              { className: "pin-rule-actions" },
              h("button", { type: "button", className: "pin-btn pin-btn-sm", "data-pin": "rule-move-up", disabled: index === 0, onClick: () => moveRule(index, -1) }, "上移"),
              h("button", { type: "button", className: "pin-btn pin-btn-sm", "data-pin": "rule-move-down", disabled: index === rules.length - 1, onClick: () => moveRule(index, 1) }, "下移"),
              h("button", { type: "button", className: "pin-btn pin-btn-sm", "data-pin": "rule-delete", onClick: () => removeRule(index) }, "删除"),
              h("span", { className: "pin-spacer" }),
              h("button", { type: "button", className: "pin-btn pin-btn-sm", "data-pin": "all-dims", title: "把三个维度都置为全部", onClick: () => makeAllForAll(index) }, "所有维度·所有会话"),
            ),
          )
          : null;

        return h(
          "div",
          { className: "pin-rule", key: String(rule.id) + "#" + index, "data-pin": "rule", "data-rule-id": String(rule.id) },
          head,
          editor,
        );
      };

      const saveButton = h("button", {
        type: "button",
        className: "pin-btn pin-btn-primary",
        "data-pin": "save",
        disabled: draft === null || busy !== "",
        onClick: save,
      }, busy === "save" ? "保存中…" : "保存");

      const discardButton = h("button", {
        type: "button",
        className: "pin-btn",
        "data-pin": "discard",
        disabled: draft === null || busy !== "" || !dirty,
        onClick: discard,
      }, "放弃");

      const reloadButton = h("button", {
        type: "button",
        className: "pin-btn pin-btn-sm",
        "data-pin": "reload",
        disabled: busy !== "",
        onClick: load,
      }, busy === "load" ? "读取中…" : "重新读取");

      const addButton = h("button", {
        type: "button",
        className: "pin-btn pin-btn-sm",
        "data-pin": "add-rule",
        onClick: addRule,
      }, "＋ 新增规则");

      return h(
        "div",
        { className: "pin", "data-pin": "card" },
        h(
          "div",
          { className: "pin-head" },
          h(
            "div",
            { className: "pin-head-text" },
            h("h3", { className: "pin-title" }, "提示词注入"),
          ),
          h(
            "div",
            { className: "pin-head-actions" },
            dirty ? h("span", { className: "pin-dirty", "data-pin": "dirty" }, h("span", { className: "pin-dot", "aria-hidden": "true" }), "未保存") : null,
            reloadButton,
            addButton,
          ),
        ),
        loadError === "" ? null : h("div", { className: "pin-err", "data-pin": "load-error" }, loadError),
        loadFailed ? h("div", { className: "pin-warn", "data-pin": "load-warning" }, "配置没读到：现在显示的是空白默认值，保存会覆盖宿主上的原有配置。") : null,
        saveError === "" ? null : h("div", { className: "pin-err", "data-pin": "save-error" }, saveError),
        notice === "" ? null : h("div", { className: "pin-notice", "data-pin": "notice" }, notice),
        h(
          "div",
          { className: "pin-group" },
          h(
            "div",
            { className: "pin-row" },
            h(
              "div",
              { className: "pin-row-text" },
              h("span", { className: "pin-row-title" }, "启用提示词注入"),
              h("span", { className: "pin-sub" }, draft !== null && draft.enabled === false ? "不启用" : "启用"),
            ),
            renderSwitch(draft !== null && draft.enabled !== false, setEnabled, "启用提示词注入", "enabled", false),
          ),
        ),
        h(
          "div",
          { className: "pin-group", "data-pin": "rules" },
          draft === null
            ? h("div", { className: "pin-empty", "data-pin": "loading" }, "读取中…")
            : rules.length === 0
              ? h("div", { className: "pin-empty", "data-pin": "no-rules" }, "还没有规则，点右上角「新增规则」加一条。")
              : rules.map(renderRule),
        ),
        h(
          "div",
          { className: "pin-group" },
          h(
            "div",
            { className: "pin-row" },
            h(
              "div",
              { className: "pin-row-text" },
              h("span", { className: "pin-row-title" }, "保存"),
            ),
            h("div", { className: "pin-foot" }, discardButton, saveButton),
          ),
        ),
      );
    }

    // ── 会话级注入：入口按钮 + 覆盖面板 ────────────────────────────────
    //
    // 入口有两个：conversation.composer.dock（输入框上方那颗按钮，正常会话）、
    // conversation.hero.options（新会话空状态：输入框上方没有可用宿主，hero 兜底）、
    // 加上 shell.overlay（Modal 外壳）。面板内容只有一份（useSessionPanel），共用。
    // 两个 slot 的组件之间没有共同 props，所以「打开面板」与「sessionId 出现」
    // 都走这张模块级小桥；桥不落盘，宿主重启 / 页面刷新即回到条件命中。

    const bridge = { open: false, sessionId: undefined, pending: null, listeners: new Set() };

    function bridgeEmit() {
      for (const listener of Array.from(bridge.listeners)) {
        try {
          listener();
        } catch {
          /* 单个订阅者炸掉不连坐其它 */
        }
      }
    }

    function subscribeBridge(listener) {
      bridge.listeners.add(listener);
      return () => {
        bridge.listeners.delete(listener);
      };
    }

    /** sessionId 可能在首句发送后从 undefined 变成真值（inject 面会以新 id 重跑）。 */
    function noteSession(sessionId) {
      const next = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
      if (next === bridge.sessionId) return;
      bridge.sessionId = next;
      bridgeEmit();
    }

    function openPanel() {
      if (bridge.open) return;
      bridge.open = true;
      bridgeEmit();
    }

    function closePanel() {
      if (!bridge.open) return;
      bridge.open = false;
      bridgeEmit();
    }

    /** session 作用域 slot 的 inject 面：入参就是 sessionId，返回值并进组件 props。 */
    function sessionInject(sessionId) {
      return { sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined };
    }

    /**
     * 组件拿 sessionId 的唯一来源是 inject 面；props 读崩了也不能连累会话。
     * known=true 表示 inject 面确实给了这个键 —— 值是 undefined 也算「确知没有会话」，
     * 只有完全没给（老版本 slot 不带 inject）时才回落到桥。
     */
    function sessionFromProps(props) {
      try {
        if (isPlainObject(props) && "sessionId" in props) {
          const raw = props.sessionId;
          return { known: true, value: typeof raw === "string" && raw !== "" ? raw : undefined };
        }
      } catch {
        /* props 可能是带 getter 的奇怪对象 */
      }
      return { known: false, value: undefined };
    }

    /** inject 面明确给过的值优先（含 undefined），否则桥里的值兜底。 */
    function currentSessionId(props) {
      const fromProps = sessionFromProps(props);
      return fromProps.known ? fromProps.value : bridge.sessionId;
    }

    /** 桥是非 React 的模块级对象，订阅它并在每次变化时重渲染。 */
    function useBridgeState() {
      const [version, setVersion] = useState(0);
      useEffect(() => subscribeBridge(() => setVersion((current) => current + 1)), []);
      return { version, open: bridge.open, sessionId: bridge.sessionId, pending: bridge.pending };
    }

    /**
     * 入口按钮：正常会话挂在输入框上方（composer.dock），新会话空状态挂在 hero.options。
     * 渲染期异常一律返回 null —— 按钮消失好过整个会话白屏。
     */
    function InjectButton(props) {
      const state = useBridgeState();
      const sessionId = currentSessionId(props);
      useEffect(() => {
        noteSession(sessionId);
      }, [sessionId]);
      let view = null;
      try {
        view = h(
          "div",
          { className: "pinin-launcher", "data-pin": "inject-launcher" },
          h("button", {
            type: "button",
            className: "pinin-launcher-btn",
            "data-pin": "inject-button",
            "data-session": sessionId === undefined ? "" : sessionId,
            "data-open": state.open ? "1" : "0",
            title: "为本次会话挑选要注入的系统提示词",
            onClick: () => openPanel(),
          }, "系统提示词注入"),
        );
      } catch {
        view = null;
      }
      return view;
    }

    /** primitives 的 Modal 拿不到时的兜底：同一份内容，样式自管。 */
    function FallbackModal(props) {
      if (!isPlainObject(props) || props.open !== true) return null;
      const onClose = typeof props.onClose === "function" ? props.onClose : () => {};
      return h(
        "div",
        { className: "pinin-mask", "data-pin": "inject-mask" },
        h(
          "div",
          { className: "pinin-dialog", role: "dialog", "aria-label": props.title === undefined ? "系统提示词注入" : props.title },
          h(
            "div",
            { className: "pinin-dialog-head" },
            h("span", null, props.title === undefined ? "系统提示词注入" : props.title),
            h("button", { type: "button", className: "pin-btn", "data-pin": "inject-fallback-close", onClick: () => onClose() }, "关闭"),
          ),
          h("div", { className: "pinin-dialog-body" }, props.children),
          props.footer === undefined || props.footer === null ? null : h("div", { className: "pinin-dialog-foot" }, props.footer),
        ),
      );
    }

    /** 平台 seed 白名单里的 Modal；拿不到时退回 FallbackModal。 */
    const Modal = isPlainObject(primitives) && typeof primitives.Modal === "function" ? primitives.Modal : FallbackModal;

    /** 列表一行：name 为空就退回 id。 */
    function ruleLabel(rule) {
      const raw = isPlainObject(rule) && typeof rule.name === "string" ? rule.name.trim() : "";
      if (raw !== "") return raw;
      return isPlainObject(rule) && typeof rule.id === "string" && rule.id !== "" ? rule.id : "（无 id）";
    }

    function enabledIds(rules) {
      const out = [];
      for (const rule of rules) {
        if (isPlainObject(rule) && rule.enabled !== false && typeof rule.id === "string" && rule.id !== "") out.push(rule.id);
      }
      return out;
    }

    /** 服务端 override 的 ruleIds；没有覆盖返回 null（注意空数组是「有覆盖但一条都不勾」）。 */
    function overrideIds(payload) {
      if (!isPlainObject(payload)) return null;
      const override = payload.override;
      if (!isPlainObject(override) || !Array.isArray(override.ruleIds)) return null;
      return uniqueStrings(override.ruleIds.filter((id) => typeof id === "string"));
    }

    /**
     * 预勾选口径：
     * · 有覆盖 → 覆盖里的 ruleIds；
     * · 有 sessionId、无覆盖 → 宿主算出来的 defaultRuleIds（条件命中）；
     * · 还没有 sessionId → 「所有 enabled 规则」（近似口径，面板里有一行小字说明）。
     */
    function initialChecks(payload, sessionId) {
      const fromOverride = overrideIds(payload);
      if (fromOverride !== null) return fromOverride;
      const defaults = isPlainObject(payload) && Array.isArray(payload.defaultRuleIds) ? uniqueStrings(payload.defaultRuleIds) : [];
      if (sessionId === undefined && defaults.length === 0) {
        return enabledIds(isPlainObject(payload) && Array.isArray(payload.rules) ? payload.rules : []);
      }
      return defaults;
    }

    function sessionUrl(sessionId) {
      const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
      return id === undefined ? API + "/session" : API + "/session?sessionId=" + encodeURIComponent(id);
    }

    /** 按规则表顺序收口勾选结果（宿主按配置顺序注入，这里也保持一致）。 */
    function orderedChecks(rules, checked) {
      const out = [];
      for (const rule of rules) {
        if (!isPlainObject(rule) || typeof rule.id !== "string") continue;
        if (checked.includes(rule.id)) out.push(rule.id);
      }
      return out;
    }

    /**
     * 覆盖面板的状态机与内容。覆盖层 Modal（shell.overlay）用它，返回元素而不是组件。
     */
    function useSessionPanel(options) {
      const source = isPlainObject(options) ? options : {};
      const sessionId = typeof source.sessionId === "string" && source.sessionId !== "" ? source.sessionId : undefined;
      const open = source.open === true;
      const onClose = typeof source.onClose === "function" ? source.onClose : null;
      const [data, setData] = useState(null);
      const [checked, setChecked] = useState([]);
      const [customText, setCustomText] = useState("");
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = useCallback(async (targetId) => {
        setBusy("load");
        setError("");
        try {
          const result = await settle(requestJson(sessionUrl(targetId), { headers: { accept: "application/json" } }));
          if (!alive.current) return;
          setBusy("");
          if (!result.ok) {
            setError("读取失败：" + messageOf(result.error));
            return;
          }
          const payload = isPlainObject(result.value) ? result.value : {};
          setData(payload);
          setChecked(initialChecks(payload, targetId));
        } catch (thrown) {
          if (!alive.current) return;
          setBusy("");
          setError("读取失败：" + messageOf(thrown));
        }
      }, []);

      useEffect(() => {
        if (!open) return;
        load(sessionId);
      }, [open, sessionId, load]);

      const save = useCallback(async (ruleIds, text, done) => {
        const targetId = sessionId;
        const trimmed = typeof text === "string" ? text.trim() : "";
        if (targetId === undefined) {
          bridge.pending = { ruleIds: uniqueStrings(ruleIds), customText: trimmed };
          bridgeEmit();
          setError("");
          setNotice("已暂存：会话建好后自动写入（现在还没有 sessionId）。");
          return;
        }
        setBusy("save");
        setError("");
        setNotice("");
        try {
          const body = { sessionId: targetId, ruleIds: uniqueStrings(ruleIds) };
          if (trimmed !== "") body.customText = trimmed;
          const result = await settle(requestJson(API + "/session", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
          }));
          if (!alive.current) return;
          if (!result.ok) {
            setBusy("");
            setError("保存失败：" + messageOf(result.error));
            return;
          }
          const saved = isPlainObject(result.value) && isPlainObject(result.value.session) ? result.value.session : null;
          if (saved !== null) {
            setData(saved);
            setChecked(initialChecks(saved, targetId));
          }
          setCustomText("");
          await load(targetId);
          if (!alive.current) return;
          setNotice(done === undefined ? "已保存：只对当前会话生效。" : done);
        } catch (thrown) {
          if (!alive.current) return;
          setBusy("");
          setError("保存失败：" + messageOf(thrown));
        }
      }, [load, sessionId]);

      const reset = useCallback(async () => {
        const targetId = sessionId;
        if (targetId === undefined) {
          bridge.pending = null;
          bridgeEmit();
          setError("");
          setNotice("已清空暂存：会话建好后不会写入。");
          return;
        }
        setBusy("reset");
        setError("");
        setNotice("");
        try {
          const result = await settle(requestJson(sessionUrl(targetId), { method: "DELETE", headers: { accept: "application/json" } }));
          if (!alive.current) return;
          if (!result.ok) {
            setBusy("");
            setError("清除失败：" + messageOf(result.error));
            return;
          }
          await load(targetId);
          if (!alive.current) return;
          setBusy("");
          setNotice("已清除会话覆盖：回到按条件命中。");
        } catch (thrown) {
          if (!alive.current) return;
          setBusy("");
          setError("清除失败：" + messageOf(thrown));
        }
      }, [load, sessionId]);

      // 会话 id 出现（首句发送后 inject 面重跑）时补发暂存的选择。
      const pendingToken = bridge.pending === null ? "none" : JSON.stringify(bridge.pending);
      useEffect(() => {
        if (!open || sessionId === undefined) return;
        const pending = bridge.pending;
        if (pending === null) return;
        bridge.pending = null;
        save(pending.ruleIds, pending.customText, "已写入暂存的选择：只对当前会话生效。");
      }, [open, sessionId, pendingToken, save]);

      const toggleRule = (id) => {
        setChecked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : current.concat([id])));
      };

      let panelBody = null;
      let panelFooter = null;
      try {
        const rules = isPlainObject(data) && Array.isArray(data.rules) ? data.rules : [];
        const hasOverride = overrideIds(data) !== null;
        const preSession = sessionId === undefined;
        const hasPending = bridge.pending !== null;
        const rows = rules.map((rule) => {
          const id = isPlainObject(rule) && typeof rule.id === "string" ? rule.id : "";
          const chips = [];
          if (isPlainObject(rule) && rule.enabled === false) chips.push(h("span", { className: "pinin-off", "data-pin": "inject-off" }, "已停用"));
          if (isPlainObject(rule) && rule.sessionOnly === true) chips.push(h("span", { className: "pinin-tag", "data-pin": "inject-session-only" }, "会话专用"));
          if (isPlainObject(rule) && rule.truncated === true) chips.push(h("span", { className: "pinin-tag", "data-pin": "inject-truncated" }, "正文过长已截断"));
          return h(
            "label",
            { className: "pinin-row", "data-pin": "inject-row", "data-rule-id": id },
            h("input", {
              type: "checkbox",
              className: "pinin-check",
              "data-pin": "inject-rule",
              "data-rule-id": id,
              checked: checked.includes(id),
              onChange: () => toggleRule(id),
            }),
            h("span", { className: "pinin-name", "data-pin": "inject-name" }, ruleLabel(rule)),
            chips,
          );
        });
        const body = [
          busy === "load" ? h("div", { className: "pinin-empty", "data-pin": "inject-loading" }, "读取中…") : null,
          error === "" ? null : h("div", { className: "pin-err", "data-pin": "inject-error" }, error),
          notice === "" ? null : h("div", { className: "pin-notice", "data-pin": "inject-notice" }, notice),
          data !== null && hasOverride ? h("p", { className: "pin-sub", "data-pin": "inject-override-note" }, "当前会话已有覆盖：没勾中的规则一条都不注入。") : null,
          data === null
            ? null
            : rules.length === 0
              ? h("div", { className: "pinin-empty", "data-pin": "inject-no-rules" }, "配置里还没有规则。")
              : h("div", { className: "pinin-list", "data-pin": "inject-list" }, rows),
          h(
            "label",
            { className: "pinin-field", "data-pin": "inject-custom-field" },
            h("span", { className: "pinin-field-label" }, "自定义文本（可选）"),
            h("textarea", {
              className: "pin-textarea",
              "data-pin": "inject-custom",
              rows: 4,
              value: customText,
              placeholder: "保存时落成一条「会话专用」规则，只对本会话注入。留空则不新建。",
              onChange: (event) => setCustomText(event && event.target ? String(event.target.value) : ""),
            }),
          ),
        ];
        const footer = h(
          "div",
          { className: "pinin-foot", "data-pin": "inject-foot" },
          h("button", {
            type: "button",
            className: "pin-btn pin-btn-primary",
            "data-pin": "inject-save",
            disabled: busy !== "" || data === null,
            onClick: () => { save(orderedChecks(rules, checked), customText); },
          }, busy === "save" ? "保存中…" : "保存"),
          h("button", {
            type: "button",
            className: "pin-btn",
            "data-pin": "inject-reset",
            disabled: busy !== "" || (data === null) || (!hasOverride && !hasPending),
            onClick: () => { reset(); },
          }, busy === "reset" ? "清除中…" : "清除本会话覆盖"),
          onClose === null ? null : h("button", { type: "button", className: "pin-btn", "data-pin": "inject-close", onClick: () => onClose() }, "关闭"),
          h("span", { className: "pin-spacer" }),
          h("span", { className: "pin-sub" }, preSession ? "会话未创建：保存会先暂存" : "只对当前会话生效，宿主重启即失效"),
        );
        panelBody = body;
        panelFooter = footer;
      } catch {
        panelBody = null;
        panelFooter = null;
      }
      return { body: panelBody, footer: panelFooter };
    }

    /** 覆盖层 Modal（shell.overlay，root scope）：sessionId 与开关都来自模块级桥。 */
    function InjectPanel() {
      const state = useBridgeState();
      const panel = useSessionPanel({ sessionId: state.sessionId, open: state.open, onClose: closePanel });
      if (panel.body === null) return null;
      return h(
        Modal,
        {
          open: state.open,
          onClose: () => closePanel(),
          title: "系统提示词注入",
          closeLabel: "关闭",
          footer: panel.footer,
          className: "pinin-modal",
        },
        h("div", { className: "pinin-panel", "data-pin": "inject-panel" }, panel.body),
      );
    }

    // ── 插件接线 ──────────────────────────────────────────────────────

    const inject = ["slots"];

    /** 某个 slot 在宿主上不存在（版本差异）时不得连坐其它注册：按钮少个入口好过会话崩掉。 */
    function safeInject(ctx, slotName, make) {
      try {
        ctx.slots.inject(slotName, make);
        return true;
      } catch {
        return false;
      }
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
      const register = () => {
        safeInject(ctx, "settings.section", () => ctx.slots.register(
          { name: "settings.section", id: "prompt-inject", order: 60, label: "提示词注入" },
          Card,
        ));
        safeInject(ctx, "conversation.composer.dock", () => ctx.slots.register(
          { name: "conversation.composer.dock", id: "prompt-inject-composer", order: 900, inject: sessionInject },
          InjectButton,
        ));
        safeInject(ctx, "conversation.hero.options", () => ctx.slots.register(
          { name: "conversation.hero.options", id: "prompt-inject-hero", order: 900, inject: sessionInject },
          InjectButton,
        ));
        safeInject(ctx, "shell.overlay", () => ctx.slots.register(
          { name: "shell.overlay", id: "prompt-inject-panel", order: 900 },
          InjectPanel,
        ));
      };
      if (typeof ctx.effect === "function") {
        ctx.effect(() => installStyle(), "prompt-inject: settings style");
        ctx.effect(register, "prompt-inject: slots");
        return;
      }
      installStyle();
      register();
    }

    return { name, apply, inject };
  },
});
