export type { AgentAdapter, InvokeOptions } from './types';

import { AgentAdapter } from './types';
import { claudeAdapter } from './claude';
import { claudeSdkAdapter } from './claude-sdk';
import { codexAdapter } from './codex';
import { opencodeAdapter } from './opencode';

// Re-export the SDK adapter's test injection hook so consumers can stub
// the client in their own tests without reaching into adapter internals.
export { setClaudeSdkClientFactory, DEFAULT_CLAUDE_SDK_MAX_TOKENS } from './claude-sdk';
export type { ClaudeSdkClient, ClaudeSdkClientFactory } from './claude-sdk';

/** Provider → adapter registry, built automatically from adapter declarations. */
const registry = new Map<string, AgentAdapter>();

function register(adapter: AgentAdapter) {
    for (const provider of adapter.providers) {
        registry.set(provider, adapter);
    }
}

// Auto-register built-in adapters
register(claudeAdapter);
register(claudeSdkAdapter);
register(codexAdapter);
register(opencodeAdapter);

export function getAdapter(provider: string): AgentAdapter | undefined {
    return registry.get(provider);
}

export function registerAdapter(adapter: AgentAdapter): void {
    register(adapter);
}
