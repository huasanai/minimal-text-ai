import {
  Editor, FuzzySuggestModal, MarkdownFileInfo, Menu, Notice, Platform, Plugin,
  Modal, type TFile, type EditorPosition
} from "obsidian";
import { defaults, migratePresets, type Action, type Config, type Model } from "./config";
import { complete } from "./client";
import { formattingSignature } from "./formatting";
import { InlineReview, differences } from "./review";
import { History, appliedText, type Revision } from "./history";
import { Preferences } from "./settings";

function samePosition(a: EditorPosition, b: EditorPosition) {
  return a.line === b.line && a.ch === b.ch;
}

class ModelPicker extends FuzzySuggestModal<Model> {
  constructor(private plugin: MinimalTextAI) {
    super(plugin.app);
    this.setPlaceholder("输入模型名称或 Model ID");
  }
  getItems() { return this.plugin.config.models; }
  getItemText(model: Model) {
    return (this.plugin.config.activeId === model.id ? "✓ " : "") + model.name + " · " + model.model;
  }
  onChooseItem(model: Model) { this.plugin.select(model.id); }
}

class HistoryPicker extends FuzzySuggestModal<string> {
  constructor(app: MinimalTextAI["app"], private entries: string[], private pick: (entry: string) => void, private closed: () => void) {
    super(app);
    this.setPlaceholder("查看 AI 修改历史（最近的在前）");
  }
  onClose() { super.onClose(); this.closed(); }
  getItems() { return this.entries; }
  getItemText(entry: string) { return new Date(Number(entry.split("/").pop()!.slice(0, 13))).toLocaleString(); }
  onChooseItem(entry: string) { this.pick(entry); }
}

export default class MinimalTextAI extends Plugin {
  config!: Config;
  private status?: HTMLElement;
  private history!: History;
  private inline = new InlineReview();
  private reviews = new Set<Modal>();
  private writes = Promise.resolve();
  private running = new Map<Editor, Notice>();
  private waiting = new Set<Editor>();
  private unloaded = false;

  async onload() {
    this.registerEditorExtension(this.inline.extension);
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.inline.cancel()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.inline.cancel()));
    this.history = new History(this.app);
    const saved: Config | null = await this.loadData();
    this.config = saved ? migratePresets(saved) : defaults();
    if (this.config !== saved) await this.saveData(this.config);
    this.unloaded = false;
    this.addCommand({id: "switch-model", name: "切换模型 (Switch Model)", callback: () => {
      if (this.config.models.length) new ModelPicker(this).open();
      else new Notice("请先在设置中添加模型");
    }});
    this.addCommand({id: "review-history", name: "查看 AI 修改历史", editorCallback: (editor, info) => {
      if (info.file) void this.openHistory(editor, info.file);
    }});
    if (Platform.isDesktop) {
      const status = this.status = this.addStatusBarItem();
      status.addClass("minimal-text-ai-status");
      status.tabIndex = 0;
      status.setAttribute("role", "button");
      status.setAttribute("aria-label", "切换模型");
      this.registerDomEvent(status, "click", e => this.modelMenu().showAtMouseEvent(e));
      this.registerDomEvent(status, "keydown", e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        const rect = status.getBoundingClientRect();
        this.modelMenu().showAtPosition({x: rect.left, y: rect.top}, status.ownerDocument);
      });
    }
    this.renderStatus();
    for (const action of this.config.actions) this.registerAction(action);
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      if (info.file) {
        const file = info.file;
        menu.addItem(item => item.setTitle("查看 AI 修改历史").setIcon("history")
          .setSection("minimal-text-ai").onClick(() => this.openHistory(editor, file)));
      }
      for (const action of this.config.actions)
        menu.addItem(item => item.setTitle(action.name).setIcon("sparkles")
          .setSection("minimal-text-ai").onClick(() => this.run(action, editor, info)));
    }));
    this.addSettingTab(new Preferences(this.app, this));
  }

  private registerAction(action: Action) {
    this.addCommand({id: action.id, name: action.name, editorCallback: (editor, info) => {
      const current = this.config.actions.find(a => a.id === action.id);
      if (current) void this.run(current, editor, info);
    }});
  }

  private modelMenu() {
    const menu = new Menu();
    if (!this.config.models.length)
      menu.addItem(item => item.setTitle("请先在设置中添加模型").setDisabled(true));
    for (const model of this.config.models)
      menu.addItem(item => item.setTitle(model.name).setChecked(this.config.activeId === model.id)
        .onClick(() => this.select(model.id)));
    return menu;
  }

  select(id: string) {
    if (this.config.models.some(m => m.id === id)) this.update({...this.config, activeId: id});
  }

  private renderStatus() {
    const model = this.config.models.find(m => m.id === this.config.activeId);
    if (!this.status) return;
    const busy = this.waiting.size > 0;
    this.status.classList.toggle("minimal-text-ai-busy", busy);
    this.status.setText((busy ? "处理中 · " : "✦ ") + (model?.name ?? "未配置模型"));
  }

  update(next: Config) {
    const previous = this.config;
    if (!next.models.some(m => m.id === next.activeId)) next.activeId = next.models[0]?.id ?? "";
    this.config = next;
    for (const old of previous.actions) {
      if (!next.actions.some(a => a.id === old.id && a.name === old.name)) this.removeCommand(old.id);
    }
    for (const action of next.actions) {
      if (!previous.actions.some(a => a.id === action.id && a.name === action.name)) this.registerAction(action);
    }
    this.renderStatus();
    this.writes = this.writes.then(() => this.saveData(next)).catch(() => {
      new Notice("配置保存失败，请检查 vault 的写入权限");
    });
  }

  private showHistory(record: Revision, editor: Editor, file: TFile) {
    try {
      const active = this.app.workspace.activeEditor;
      if (active?.editor !== editor || active.file !== file) throw new Error("请在原笔记中打开修改历史");
      this.inline.history(editor, record, differences(record), () => this.undo(record, editor, file));
    } catch (error) { new Notice(error instanceof Error ? error.message : "无法显示修改历史"); }
  }

  private undo(record: Revision, editor: Editor, file: TFile) {
    const active = this.app.workspace.activeEditor;
    if (this.unloaded || active?.editor !== editor || active.file !== file || file.path !== record.path ||
        editor.getValue() !== appliedText(record)) {
      new Notice("笔记已变化。可从修改历史复制原文，保留后续编辑。");
      return;
    }
    editor.replaceRange(record.before.slice(record.start, record.end),
      editor.offsetToPos(record.start), editor.offsetToPos(record.start + record.output.length));
    new Notice("已撤回本次 AI 修改");
  }

  private async openHistory(editor: Editor, file: TFile) {
    try {
      const path = file.path;
      const entries = await this.history.entries(path);
      if (this.unloaded) return;
      if (!entries.length) { new Notice("此笔记还没有 AI 修改记录"); return; }
      const picker = new HistoryPicker(this.app, entries, async entry => {
        try {
          const record = await this.history.read(entry, path);
          if (!this.unloaded) this.showHistory(record, editor, file);
        } catch { new Notice("读取修改记录失败"); }
      }, () => this.reviews.delete(picker));
      this.reviews.add(picker);
      picker.open();
    } catch { new Notice("无法打开此笔记的 AI 修改历史"); }
  }

  async run(action: Action, editor: Editor, info: MarkdownFileInfo) {
    if (this.running.has(editor)) { new Notice("此编辑器已有请求正在处理"); return; }
    if (editor.listSelections().length !== 1) { new Notice("请只保留一个选区后重试"); return; }
    const selection = editor.getSelection();
    if (action.selectionOnly && !selection) {
      new Notice(action.id === "translate-selection" ? "请先选中需要翻译的文本" : "请先选中需要处理的文本");
      return;
    }
    const model = this.config.models.find(m => m.id === this.config.activeId);
    if (!model) { new Notice("请先在插件设置中添加模型"); return; }
    const file = info.file;
    if (!file) { new Notice("请在笔记编辑器中执行"); return; }
    const before = editor.getValue();
    const input = selection || before;
    if (!input.trim()) { new Notice("没有可处理的文本"); return; }
    const from = editor.getCursor("from"), to = editor.getCursor("to");
    const message = document.createDocumentFragment();
    message.createSpan({cls: "minimal-text-ai-spinner", attr: {"aria-hidden": "true"}});
    message.createSpan({text: model.name + " 正在处理 · " + action.name});
    const progress = new Notice(message, 0);
    this.running.set(editor, progress);
    this.waiting.add(editor);
    this.renderStatus();
    const path = file.path;
    const start = selection ? editor.posToOffset(from) : 0;
    const validate = (checkSelection = true) => {
      const active = this.app.workspace.activeEditor;
      if (this.unloaded || active?.file !== file || file.path !== path || active.editor !== editor || editor.getValue() !== before)
        throw new Error("笔记已切换或内容已变化，已保留当前文本");
      if (checkSelection && (editor.listSelections().length !== 1 || editor.getSelection() !== selection ||
          (selection && !(samePosition(from, editor.getCursor("from")) && samePosition(to, editor.getCursor("to"))))))
        throw new Error("选区已变化，已保留当前文本");
    };
    try {
      const output = (await complete(model, action, input)).replace(/\r\n?/g, "\n");
      progress.hide();
      this.waiting.delete(editor);
      this.renderStatus();
      if (this.unloaded) return;
      validate();
      if (input === output) { new Notice("文本没有变化"); return; }
      const record: Revision = {path, action: action.name, model: model.name, time: Date.now(),
        translate: action.id === "translate-selection", before, start, end: start + input.length, output};
      const onlyFormat = formattingSignature(before) === formattingSignature(appliedText(record));
      if (!onlyFormat && !await this.inline.preview(editor, record, differences(record))) return;
      validate(onlyFormat);
      let entry: string;
      try { entry = await this.history.save(record); }
      catch { throw new Error("无法保存修改前原文，已停止写入笔记"); }
      let nativeFailed = false;
      try { await this.history.nativeSnapshot(path, before); }
      catch { nativeFailed = true; }
      try {
        validate(onlyFormat);
        editor.replaceRange(output, editor.offsetToPos(record.start), editor.offsetToPos(record.end));
      } catch (error) {
        // A record that never reached the editor must not appear as an applied change.
        if (editor.getValue() !== appliedText(record)) await this.app.vault.adapter.remove(entry);
        throw error;
      }
      new Notice("已应用修改（Cmd/Ctrl + Z 可撤回）", 5000);
      if (nativeFailed) new Notice("系统文件恢复快照失败，原文已保存到 AI 修改历史");
    } catch (error) {
      if (!this.unloaded) new Notice(error instanceof Error ? error.message : "模型请求失败");
    } finally {
      progress.hide();
      this.running.delete(editor);
      this.waiting.delete(editor);
      if (!this.unloaded) this.renderStatus();
    }
  }

  onunload() {
    this.unloaded = true;
    this.inline.cancel();
    for (const modal of this.reviews) modal.close();
    for (const notice of this.running.values()) notice.hide();
  }
}
