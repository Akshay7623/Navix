import type { Settings } from "../shared/types";
import { getPermissions, getSettings, setDomainPermission } from "../shared/storage";

export interface ApprovalRequest {
  origin: string;
  toolName: string;
  summary: string;
}

type Resolver = (decision: "allow" | "deny") => void;

const pending = new Map<string, Resolver>();

function keyOf(origin: string): string {
  return origin || "unknown";
}

/**
 * Decide whether a tool may run against `origin`.
 *
 * - `auto` mode allows everything.
 * - `ask` mode consults remembered per-domain choices, then prompts.
 *
 * Returns true when the call may proceed.
 */
export async function authorize(
  origin: string,
  toolName: string,
  summary: string,
  settings: Settings,
  onPrompt: (req: ApprovalRequest) => void,
): Promise<boolean> {
  if (settings.approvalMode === "auto") return true;

  const key = keyOf(origin);

  // Register the resolver before the first await so a cancelAll() issued while
  // storage is being read cannot miss this request and leave it hanging.
  let settle!: Resolver;
  const decision = new Promise<boolean>((resolve) => {
    settle = (d) => resolve(d === "allow");
  });
  pending.get(key)?.("deny");
  pending.set(key, settle);

  const store = await getPermissions();
  if (!pending.has(key)) return decision;

  const remembered = store.domains[origin];
  if (remembered) {
    pending.delete(key);
    return remembered.state === "allow";
  }

  onPrompt({ origin, toolName, summary });
  return decision;
}

export async function resolveApproval(
  origin: string,
  decision: "allow" | "deny",
  remember: boolean,
): Promise<void> {
  const resolver = pending.get(keyOf(origin));
  pending.delete(keyOf(origin));
  if (remember) await setDomainPermission(origin, decision);
  resolver?.(decision);
}

export function cancelAll(): void {
  for (const resolver of pending.values()) resolver("deny");
  pending.clear();
}

export function hasPending(): boolean {
  return pending.size > 0;
}

export async function currentMode(): Promise<Settings["approvalMode"]> {
  return (await getSettings()).approvalMode;
}
