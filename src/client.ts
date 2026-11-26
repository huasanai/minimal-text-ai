import { requestUrl } from "obsidian";
import { endpoint, type Action, type Model, preprocess } from "./config";

export async function complete(model: Model, action: Action, input: string): Promise<string> {
  const target = endpoint(model.baseUrl);
  const key = model.apiKey.trim();
  if (!key && !target.local) throw new Error("请先在插件设置中填写此模型的 API Key");
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = "Bearer " + key;
  let timer: number | undefined;
  try {
    const response = await Promise.race([
      requestUrl({
        url: target.url, method: "POST", contentType: "application/json", headers, throw: false,
        body: JSON.stringify({
          model: model.model, stream: false,
          messages: [
            {role: "system", content: action.prompt},
            {role: "user", content: action.clean ? preprocess(input) : input}
          ]
        })
      }).catch(() => { throw new Error("无法连接模型，请检查接口地址、网络或本地服务"); }),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("等待模型超过 120 秒，请稍后重试")), 120000);
      })
    ]);
    if (response.status < 200 || response.status >= 300) {
      const reasons: Record<number, string> = {
        400: "请求参数无效，请检查模型或文本长度", 401: "API Key 无效",
        402: "账户余额不足", 403: "接口拒绝访问", 404: "接口或模型不存在",
        408: "接口响应超时", 429: "请求过于频繁或额度已用尽", 504: "模型网关超时"
      };
      throw new Error("HTTP " + response.status + " · " + (reasons[response.status] ?? "模型服务异常"));
    }
    let data;
    try { data = response.json; } catch { throw new Error("接口返回了无效的 JSON"); }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== "stop")
      throw new Error("模型未完整输出，已保留原文");
    const output = choice?.message?.content;
    if (typeof output !== "string" || !output.trim()) throw new Error("模型返回空内容，已保留原文");
    return output;
  } finally {
    window.clearTimeout(timer);
  }
}
