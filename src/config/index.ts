import * as fs from 'fs';
import * as path from 'path';
import { ConfigSchema, type Config } from '@/types/config';

/**
 * Custom error class for configuration errors
 * Used to distinguish configuration issues from code bugs
 */
class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with process.env.VAR_NAME or fallback values
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value !== undefined) {
        return value;
      }

      // Provide fallback values for development
      const fallbacks: Record<string, string> = {
        'PORT': '3000',
        'DATABASE_URL': 'postgres://user:pass@localhost:5432/pubkybot',
        'REDIS_URL': 'redis://localhost:6379/0',
        'PUBKY_NETWORK': 'testnet',
        'PUBKY_HOMESERVER_URL': 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy',
        'PUBKY_BOT_MNEMONIC': '',
        'PUBKY_BOT_SECRET_KEY_HEX': '',
        'PUBKY_NEXUS_API_URL': 'https://testnet.pubky.org',
        'PUBKY_SIGNUP_TOKEN': '',
        'CANNED_REPLY': '',
        'POLL_INTERVAL_SECONDS': '10',
        'MODEL_DELAY_MS': '0',
        'MAX_REPLIES_PER_THREAD': '1',
        'MENTION_RETRY_COOLDOWN_SECONDS': '600',
        'MENTION_RETRY_MAX_ATTEMPTS': '3',
        'THREAD_MAX_DEPTH': '100',
        'THREAD_MAX_POSTS': '1500',
        'THREAD_MAX_TOKENS_FOR_AI': '15000',
        'THREAD_TOKEN_WARNING_THRESHOLD': '10000',
        'AI_MAX_TOKENS_SUMMARY': '1500',
        'AI_MAX_TOKENS_FACTCHECK': '1500',
        'AI_MAX_TOKENS_CLASSIFIER': '500',
        'AI_CLASSIFIER_TEMPERATURE': '0.1',
        'RATE_LIMIT_MAX_REQUESTS': '10',
        'RATE_LIMIT_WINDOW_MINUTES': '120',
        'BLACKLIST_PUBLIC_KEYS': ''
      };

      return fallbacks[varName] || match;
    });
  } else if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  } else if (typeof obj === 'object' && obj !== null) {
    const resolved: any = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function loadConfig(): any {
  const env = process.env.NODE_ENV || 'development';
  const configDir = path.resolve(__dirname, '..', '..', 'config');

  // Load default config
  const defaultConfigPath = path.join(configDir, 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

  // Load environment-specific config if it exists
  const envConfigPath = path.join(configDir, `${env}.json`);
  let envConfig = {};
  if (fs.existsSync(envConfigPath)) {
    envConfig = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
  }

  // Deep merge configs (env config overrides default)
  return deepMerge(defaultConfig, envConfig);
}

function processSpecialValues(obj: any): any {
  if (typeof obj === 'string') {
    // Handle unresolved environment variables (optional fields)
    if (obj.startsWith('${') && obj.endsWith('}')) {
      // For AI fallback providers, return undefined if not set
      if (obj === '${AI_FALLBACK_PROVIDERS}') {
        return undefined;
      }
      // For LOG_LEVEL, return a default based on NODE_ENV if not set
      if (obj === '${LOG_LEVEL}') {
        return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
      }
      // For required configuration that must be set, throw error with helpful message
      const requiredVars = [
        'AI_PRIMARY_PROVIDER',
        'AI_MODEL_SUMMARY',
        'AI_MODEL_FACTCHECK',
        'AI_MODEL_CLASSIFIER'
      ];

      const varName = obj.slice(2, -1); // Remove ${ and }
      if (requiredVars.includes(varName)) {
        throw new ConfigurationError(
          `\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `  ERROR: Missing Required Configuration: ${varName}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `\n` +
          `  Please set ${varName} in your .env file.\n` +
          `  See .env.example for reference.\n` +
          `\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
        );
      }

      // For API keys, return undefined (optional)
      if (varName.endsWith('_API_KEY')) {
        return undefined;
      }

      return obj;
    }
    // Handle empty strings (especially for AI_FALLBACK_PROVIDERS)
    if (obj === '') {
      return undefined;
    }
    // Handle comma-separated arrays
    if (obj.includes(',')) {
      return obj.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    // Handle numeric strings
    if (/^\d+$/.test(obj)) {
      return parseInt(obj, 10);
    }
    // Handle float strings
    if (/^\d*\.\d+$/.test(obj)) {
      return parseFloat(obj);
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map(processSpecialValues);
  } else if (typeof obj === 'object' && obj !== null) {
    const processed: any = {};
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = processSpecialValues(value);
    }
    return processed;
  }
  return obj;
}

function validateConfig(): Config {
  try {
    const rawConfig = loadConfig();
    const resolvedConfig = resolveEnvVars(rawConfig);
    const processedConfig = processSpecialValues(resolvedConfig);
    const validated = ConfigSchema.parse(processedConfig);

    // Don't use logger here to avoid circular dependency
    if (process.env.NODE_ENV !== 'production') {
      console.log('Configuration loaded and validated successfully');
    }
    return validated;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
      throw error;
    }

    // For other errors (Zod validation, etc), log with full context
    console.error('Configuration validation failed:', error);

    // Provide helpful message for Zod validation errors
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as any).issues;
      console.error('\nERROR: Configuration validation failed:\n');
      issues.forEach((issue: any) => {
        console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
      });
      console.error('\nPlease check your .env file and config/default.json\n');
    }

    throw error;
  }
}

export const appConfig = validateConfig();
export default appConfig;
