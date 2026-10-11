#!/usr/bin/env node
// SubagentStop quality gate for Expunge named teammates.
//
// Reads the hook payload on stdin. For general-purpose teammates it requires the
// final message to carry a structured evidence footer so that "done" always comes
// with the effective model, owned paths, actual check commands with exit codes and
// an explicit status (COMPLETE | BLOCKED | PARTIAL). Honest BLOCKED or PARTIAL
// reports pass; only reports missing the evidence fields are rejected.
//
// Exit 2 with a reason on stderr blocks the stop once; stop_hook_active prevents loops.
// Any unexpected error exits 0 so a broken hook can never wedge the session.
import { readFileSync } from 'node:fs';

const EXEMPT_AGENT_TYPES = new Set(['claude-code-guide', 'Explore', 'Plan', 'statusline-setup']);
const REQUIRED = [
  { key: 'EFFECTIVE_MODEL', pattern: /EFFECTIVE_MODEL\s*:\s*\S+/i },
  { key: 'OWNED_PATHS', pattern: /OWNED_PATHS\s*:/i },
  { key: 'CHECKS', pattern: /CHECKS\s*:/i },
  { key: 'exit code', pattern: /exit(?:\s+code)?\s*[:=]?\s*\d+/i },
  { key: 'STATUS', pattern: /STATUS\s*:\s*(COMPLETE|BLOCKED|PARTIAL)/i },
];

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return 0;
  }
  if (payload.stop_hook_active) return 0;
  const agentType = String(payload.agent_type ?? '');
  if (EXEMPT_AGENT_TYPES.has(agentType)) return 0;
  const message = String(payload.last_assistant_message ?? '');
  // Short conversational turns (questions back to the lead) are allowed to stop.
  if (message.length < 400 && /\?\s*$/.test(message.trim())) return 0;
  const missing = REQUIRED.filter((r) => !r.pattern.test(message)).map((r) => r.key);
  if (missing.length === 0) return 0;
  process.stderr.write(
    `Expunge report gate: final report is missing ${missing.join(', ')}. ` +
      'End your report with a footer containing EFFECTIVE_MODEL: <id>, OWNED_PATHS: <list>, ' +
      'CHECKS: <command -> exit code N, counts>, STATUS: COMPLETE|BLOCKED|PARTIAL with reason. ' +
      'An honest BLOCKED or PARTIAL status is acceptable; missing evidence is not.\n',
  );
  return 2;
}

process.exit(main());
