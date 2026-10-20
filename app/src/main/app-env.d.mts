export const isolatedEnvKey: 'AR_ISOLATED_ENV';
export function appEnvironment(base?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export function isolationOverrides(base: NodeJS.ProcessEnv, isolated: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Record<string, string | null>;
