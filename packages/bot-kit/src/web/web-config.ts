/** Narrow config surface web tools consume. Jeb `Config` is a structural superset. */
export type WebProvider = "moonshot" | "brave" | "off";

export type WebBudgetConfig = {
  webPerMentionCap: number;
  webDailyCeiling: number;
};

export type WebBraveConfig = {
  braveApiKey?: string;
  webTimeoutMs: number;
};

export type WebMoonshotConfig = {
  model: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  webTimeoutMs: number;
  modelTemperature?: number;
};

export type WebToolsConfig = WebBudgetConfig &
  WebBraveConfig &
  WebMoonshotConfig & {
    webProvider: WebProvider;
  };
