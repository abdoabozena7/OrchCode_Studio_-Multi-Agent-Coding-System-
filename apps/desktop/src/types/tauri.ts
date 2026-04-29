export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
