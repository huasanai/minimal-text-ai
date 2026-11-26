export interface Model {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Action {
  id: string;
  name: string;
  prompt: string;
  clean: boolean;
  selectionOnly: boolean;
}

export interface Config {
  presetVersion?: number;
  models: Model[];
  actions: Action[];
  activeId: string;
}

export function defaults(): Config {
  const models = [
    ["deepseek-chat", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
    ["gemini-flash", "Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"],
    ["local-ollama", "Local Ollama", "http://localhost:11434/v1", "qwen2.5:latest"]
  ].map(([id, name, baseUrl, model]) => ({id, name, baseUrl, model, apiKey: ""}));
  return {
    presetVersion: 2,
    activeId: models[0].id,
    models,
    actions: [
      {
        id: "format-clean", name: "智能排版与清理", clean: true, selectionOnly: false,
        prompt: "还原 Markdown 结构，按原文识别标题层级、有序与无序列表、引用块、代码块和重点加粗，规范中英文混排空格。只允许调整排版格式与标点空格，严禁删减、改写、总结或遗漏原文的任何一句话。保留段落顺序、代码内容、链接、Obsidian 双链和 YAML 属性。直接输出最终 Markdown，不要用 ```markdown 代码块包裹整篇输出，不加任何说明。"
      },
      {
        id: "translate-selection", name: "选词/段落翻译", clean: false, selectionOnly: true,
        prompt: "自动识别原文语言。中文译为地道自然的英文，外文译为流畅准确的中文。完整保留 Markdown 语法符号、换行结构、代码和链接地址。直接输出译文，不添加说明或外层代码围栏。"
      },
      {
        id: "polish-selection", name: "局部润色优化", clean: false, selectionOnly: true,
        prompt: "保留原意与作者语气，删除冗余废话，增强表达清晰度与专业感。保留原有 Markdown 格式、链接与代码，直接输出修改后的文本，不添加说明或外层代码围栏。"
      }
    ]
  };
}

export function migratePresets(saved: Config): Config {
  if ((saved.presetVersion ?? 1) >= 2) return saved;
  const models = saved.models.filter(m => !(
    m.id === "deepseek-reasoner" && m.name === "DeepSeek Reasoner" &&
    m.model === "deepseek-reasoner" && m.baseUrl === "https://api.deepseek.com/v1" &&
    !m.apiKey && m.id !== saved.activeId
  )).map(m => {
    if (m.id === "deepseek-chat" && m.name === "DeepSeek Chat") return {...m, name: "DeepSeek"};
    if (m.id === "gemini-flash" && m.name === "Gemini Flash") return {...m, name: "Gemini"};
    return m;
  });
  return {...saved, presetVersion: 2, models};
}

export function endpoint(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new Error("请输入完整的 Base URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Base URL 需为 HTTP(S) 地址，不含账号、查询参数或片段");
  return {
    url: url.href.replace(/\/+$/, "") + "/chat/completions",
    local: ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  };
}

export function preprocess(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}
