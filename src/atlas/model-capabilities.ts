// Verified against OpenAI's model documentation. A catalogue may confuse the
// 272k long-context pricing threshold with the model's context window.
export function atlasModelCapabilities<T extends {id:string;provider:string;contextWindow:number;baseUrl?:string}>(model:T):T {
  if (!['openai','openai-codex'].includes(model.provider) || !/^(?:gpt-6-(?:sol|astra)|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id)) return model;
  if (model.baseUrl && !/^https:\/\/(api\.openai\.com|chatgpt\.com)(\/|$)/.test(model.baseUrl)) return model;
  return model.contextWindow===1_050_000?model:{...model,contextWindow:1_050_000};
}
