/** Narrow config surface web tools consume. Jeb `Config` is a structural superset. */
export type WebProvider = "kimi" | "brave" | "off";

export type KimiAuthority = "S" | "A" | "B" | "C";

export type WebBudgetConfig = {
  webPerMentionCap: number;
  webDailyCeiling: number;
  webPriceBasicUsd: number;
  webPriceProUsd: number;
  webPriceFetchUsd: number;
};

export type WebBraveConfig = {
  braveApiKey?: string;
  webTimeoutMs: number;
};

export type WebKimiConfig = {
  modelBaseUrl?: string;
  modelApiKey?: string;
  webTimeoutMs: number;
  webAllowedAuthorities: ReadonlySet<KimiAuthority>;
  webFetchMaxChars: number;
};

/** Legacy built-in adapter compatibility; new code uses WebKimiConfig. */
export type WebMoonshotConfig = {
  model: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  webTimeoutMs: number;
  modelTemperature?: number;
};

export type WebToolsConfig = WebBudgetConfig &
  WebBraveConfig &
  WebKimiConfig & {
    webProvider: WebProvider;
  };
