import { App, normalizePath } from "obsidian";

export interface Revision {
  path: string;
  time: number;
  action: string;
  model: string;
  translate: boolean;
  before: string;
  start: number;
  end: number;
  output: string;
}

export function appliedText(r: Revision) {
  return r.before.slice(0, r.start) + r.output + r.before.slice(r.end);
}

export class History {
  constructor(private app: App) {}

  private folder(path: string) {
    return normalizePath(this.app.vault.configDir + "/minimal-text-ai-history/" + path);
  }

  async save(record: Revision) {
    const adapter = this.app.vault.adapter;
    const dir = this.folder(record.path);
    let prefix = "";
    for (const part of dir.split("/")) {
      prefix = prefix ? prefix + "/" + part : part;
      if (!await adapter.exists(prefix)) {
        try { await adapter.mkdir(prefix); }
        catch (error) { if (!await adapter.exists(prefix)) throw error; }
      }
    }
    const entry = dir + "/" + record.time + "-" + crypto.randomUUID() + ".json";
    const data = JSON.stringify(record);
    await adapter.write(entry, data);
    if (await adapter.read(entry) !== data) throw new Error("历史记录校验失败");
    return entry;
  }

  async entries(path: string) {
    const adapter = this.app.vault.adapter;
    const dir = this.folder(path);
    if (!await adapter.exists(dir)) return [];
    return (await adapter.list(dir)).files.filter(p => /\/\d{13}-[\da-f-]+\.json$/.test(p)).sort().reverse();
  }

  async read(entry: string, path: string): Promise<Revision> {
    const r = JSON.parse(await this.app.vault.adapter.read(entry));
    if (r?.path !== path || typeof r.before !== "string" || typeof r.output !== "string" ||
      !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 ||
      r.start > r.end || r.end > r.before.length) throw new Error("此历史记录已损坏");
    return r;
  }

  async nativeSnapshot(path: string, before: string) {
    // Native File recovery's forceAdd bypasses the normal snapshot interval.
    const app = this.app as App & { internalPlugins?: { getEnabledPluginById?(id: string):
      {forceAdd?(path: string, content: string): Promise<void>} | null } };
    const recovery = app.internalPlugins?.getEnabledPluginById?.("file-recovery");
    await recovery?.forceAdd?.(path, before);
  }
}
