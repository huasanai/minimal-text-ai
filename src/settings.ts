import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { endpoint, type Action, type Model } from "./config";
import type MinimalTextAI from "./main";

class Form extends Modal {
  constructor(app: App, private title: string, private draw: (form: Form) => void) { super(app); }

  onOpen() {
    this.setTitle(this.title);
    this.contentEl.addClass("minimal-text-ai-form");
    this.draw(this);
  }
  onClose() { this.contentEl.empty(); }

  field(label: string, value: string, change: (value: string) => void, password = false) {
    new Setting(this.contentEl).setName(label).addText(text => {
      if (password) text.inputEl.type = "password";
      text.setValue(value).onChange(change);
    });
  }

  buttons(label: string, submit: () => void, destructive = false) {
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b => {
        if (destructive) b.setWarning(); else b.setCta();
        b.setButtonText(label).onClick(() => {
          try { submit(); this.close(); }
          catch (error) { new Notice(error instanceof Error ? error.message : "保存失败"); }
        });
      });
  }
}

export class Preferences extends PluginSettingTab {
  constructor(app: App, private plugin: MinimalTextAI) { super(app, plugin); }

  display() {
    const el = this.containerEl;
    el.empty();
    el.addClass("minimal-text-ai-settings");
    const cfg = this.plugin.config;
    new Setting(el).setName("模型").setHeading();
    for (const m of cfg.models) {
      const active = m.id === cfg.activeId;
      new Setting(el).setName(m.name).setDesc(m.model + " · " + m.baseUrl)
        .addButton(b => b.setButtonText(active ? "当前模型" : "设为当前").setDisabled(active)
          .onClick(() => { this.plugin.select(m.id); this.display(); }))
        .addExtraButton(b => b.setIcon("pencil").setTooltip("编辑模型").onClick(() => this.editModel(m)))
        .addExtraButton(b => b.setIcon("trash").setTooltip("删除模型").onClick(() => this.confirmDelete(m.name, () => {
          const now = this.plugin.config;
          this.plugin.update({...now, models: now.models.filter(x => x.id !== m.id)});
        })));
    }
    new Setting(el).addButton(b => b.setButtonText("+ 添加新模型").onClick(() => this.editModel()));
    new Setting(el).setName("文本处理指令").setHeading();
    for (const a of cfg.actions) {
      new Setting(el).setName(a.name).setDesc(a.selectionOnly ? "仅处理选区" : "优先处理选区，否则处理整篇笔记")
        .addExtraButton(b => b.setIcon("keyboard").setTooltip("配置快捷键").onClick(() => this.openHotkeys(a)))
        .addExtraButton(b => b.setIcon("pencil").setTooltip("编辑指令").onClick(() => this.editAction(a)))
        .addExtraButton(b => b.setIcon("trash").setTooltip("删除指令").onClick(() => this.confirmDelete(a.name, () => {
          const now = this.plugin.config;
          this.plugin.update({...now, actions: now.actions.filter(x => x.id !== a.id)});
        })));
    }
    new Setting(el).addButton(b => b.setButtonText("+ 添加自定义指令").onClick(() => this.editAction()));
  }

  private openHotkeys(action: Action) {
    // Obsidian exposes the Hotkeys tab at runtime, outside the public typings.
    const app = this.app as App & {
      setting?: {openTabById?(id: string): {setQuery?(query: string): void} | null};
    };
    const tab = app.setting?.openTabById?.("hotkeys");
    if (tab?.setQuery) tab.setQuery(this.plugin.manifest.id + ":" + action.id);
    else new Notice("在设置 → 快捷键中搜索「" + action.name + "」即可绑定");
  }

  private confirmDelete(name: string, remove: () => void) {
    new Form(this.app, "删除「" + name + "」？", form =>
      form.buttons("删除", () => { remove(); this.display(); }, true)).open();
  }

  private editModel(existing?: Model) {
    const draft: Model = existing ? {...existing} : {id: crypto.randomUUID(), name: "", baseUrl: "", apiKey: "", model: ""};
    new Form(this.app, existing ? "编辑模型" : "添加模型", form => {
      form.field("显示名称", draft.name, v => draft.name = v);
      form.field("Base URL", draft.baseUrl, v => draft.baseUrl = v);
      form.field("Model ID", draft.model, v => draft.model = v);
      form.field("API Key（本地可留空）", draft.apiKey, v => draft.apiKey = v, true);
      form.buttons("保存", () => {
        draft.name = draft.name.trim();
        draft.model = draft.model.trim();
        draft.baseUrl = draft.baseUrl.trim();
        draft.apiKey = draft.apiKey.trim();
        if (!draft.name || !draft.model) throw new Error("请填写显示名称和 Model ID");
        endpoint(draft.baseUrl);
        const cfg = this.plugin.config;
        this.plugin.update({...cfg, models: existing ? cfg.models.map(m => m.id === draft.id ? draft : m) : [...cfg.models, draft]});
        this.display();
      });
    }).open();
  }

  private editAction(existing?: Action) {
    const draft: Action = existing ? {...existing} : {
      id: crypto.randomUUID(), name: "", prompt: "", clean: false, selectionOnly: true
    };
    new Form(this.app, existing ? "编辑指令" : "添加自定义指令", form => {
      form.field("指令名称", draft.name, v => draft.name = v);
      new Setting(form.contentEl).setName("System Prompt")
        .addTextArea(t => t.setValue(draft.prompt).onChange(v => draft.prompt = v));
      new Setting(form.contentEl).setName("执行前先清理多余空行").setDesc("同时移除行尾空格与制表符")
        .addToggle(t => t.setValue(draft.clean).onChange(v => draft.clean = v));
      if (!["format-clean", "translate-selection", "polish-selection"].includes(draft.id))
        new Setting(form.contentEl).setName("仅处理选区").setDesc("关闭后，无选区时处理整篇笔记")
          .addToggle(t => t.setValue(draft.selectionOnly).onChange(v => draft.selectionOnly = v));
      form.buttons("保存", () => {
        draft.name = draft.name.trim();
        draft.prompt = draft.prompt.trim();
        if (!draft.name || !draft.prompt) throw new Error("请填写指令名称和 System Prompt");
        const cfg = this.plugin.config;
        this.plugin.update({...cfg, actions: existing ? cfg.actions.map(a => a.id === draft.id ? draft : a) : [...cfg.actions, draft]});
        this.display();
      });
    }).open();
  }
}
