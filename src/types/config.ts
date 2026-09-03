import { z } from 'zod';

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string(),
    port: z.number().min(1).max(65535),
    cors: z.object({
      origin: z.union([z.string(), z.array(z.string())]),
      credentials: z.boolean()
    })
  }),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info')
  }),
  redis: z.object({
    url: z.string().min(1)
  }),
  postgresql: z.object({
    url: z.string(),
    poolSize: z.number().min(1).max(100),
    ssl: z.boolean()
  }),
  pubky: z.object({
    network: z.enum(['mainnet', 'testnet']).default('testnet'),
    homeserverUrl: z.string().min(1),
    botMnemonic: z.string().optional().default(''),
    secretKeyHex: z.string().optional().default(''),
    nexusApiUrl: z.string().optional(),
    signupToken: z.string().optional().default(''),
    mentionPolling: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().min(1).max(300),
      batchSize: z.number().min(1).max(100)
    }),
    retry: z.object({
      cooldownSeconds: z.number().min(1).max(86400).default(600),
      maxAttempts: z.number().min(1).max(20).default(3)
    }).default({ cooldownSeconds: 600, maxAttempts: 3 }),
    maxRepliesPerThread: z.number().min(1).max(100).default(1),
    cannedReply: z.string().optional().default(''),
    modelDelayMs: z.number().min(0).max(120000).default(0)
  }).superRefine((val, ctx) => {
    if ((!val.botMnemonic || val.botMnemonic.length < 1) && (!val.secretKeyHex || val.secretKeyHex.length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either pubky.botMnemonic or pubky.secretKeyHex is required',
        path: ['botMnemonic']
      });
    }
  }),
  ai: z.object({
    primaryProvider: z.enum(['openai', 'anthropic', 'groq', 'openrouter']),
    fallbackProviders: z.array(z.enum(['openai', 'anthropic', 'groq', 'openrouter'])).optional(),
    apiKeys: z.object({
      openai: z.string().optional(),
      anthropic: z.string().optional(),
      groq: z.string().optional(),
      openrouter: z.string().optional()
    }),
    models: z.object({
      summary: z.string(),
      factcheck: z.string(),
      classifier: z.string()
    }),
    maxTokens: z.object({
      summary: z.number().min(100).max(10000).default(1500),
      factcheck: z.number().min(100).max(10000).default(1500),
      classifier: z.number().min(50).max(2000).default(500)
    }),
    classifier: z.object({
      temperature: z.number().min(0).max(2).default(0.1)
    })
  }),
  features: z.object({
    summary: z.boolean(),
    factcheck: z.boolean(),
    translate: z.boolean(),
    image: z.boolean()
  }),
  limits: z.object({
    maxConcurrentActions: z.number().min(1).max(20),
    defaultTimeoutMs: z.number().min(1000).max(120000),
    classifierTimeoutMs: z.number().min(1000).max(60000).optional().default(12000),
    factcheckTimeoutMs: z.number().min(1000).max(300000).optional().default(180000),
    thread: z.object({
      maxDepth: z.number().min(10).max(500).default(100),
      maxPosts: z.number().min(50).max(5000).default(1500),
      maxTokensForAI: z.number().min(1000).max(50000).default(15000),
      tokenWarningThreshold: z.number().min(1000).max(30000).default(10000)
    })
  }),
  safety: z.object({
    wordlist: z.array(z.string()),
    blockOnMatch: z.boolean()
  }),
  rateLimit: z.object({
    maxRequests: z.number().min(1).max(100000).default(10),
    windowMinutes: z.number().min(1).max(1440).default(120)
  }),
  blacklist: z.object({
    publicKeys: z.preprocess(
      (val) => {
        if (!val || val === '') return [];
        if (typeof val === 'string') {
          return val.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
        return val;
      },
      z.array(z.string())
    )
  }),
  budget: z.object({
    enabled: z.boolean().default(false),
    defaultDailyTokens: z.number().min(1000).max(5000000).default(200000)
  }).default({ enabled: false, defaultDailyTokens: 200000 }),
  eventBus: z.object({
    maxAttempts: z.number().min(1).max(20).default(3),
    pendingIdleSeconds: z.number().min(1).max(3600).default(30)
  }).default({ maxAttempts: 3, pendingIdleSeconds: 30 })
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Services {
  // Will be defined as we create services
}
