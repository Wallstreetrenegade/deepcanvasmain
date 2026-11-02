import { useEffect, useState } from 'react';

const IDENTITY_PATH = 'agent/jiuwenclaw_workspace/IDENTITY.md';

function parseAssistantName(content: string): string | null {
  const match = content.match(/-\s*\*\*Name:\*\*\s*(.+)/i);
  return match?.[1]?.trim() || null;
}

export function useAssistantName(fallback = 'Assistant'): string {
  const [assistantName, setAssistantName] = useState(fallback);

  useEffect(() => {
    let cancelled = false;

    async function loadAssistantName() {
      try {
        const response = await fetch(
          `/file-api/file-content?path=${encodeURIComponent(IDENTITY_PATH)}`,
          { cache: 'no-store' }
        );
        if (!response.ok) return;
        const content = await response.text();
        if (cancelled) return;
        const parsed = parseAssistantName(content);
        if (parsed) {
          setAssistantName(parsed);
        }
      } catch {
        // Keep fallback when identity is unavailable.
      }
    }

    void loadAssistantName();
    return () => {
      cancelled = true;
    };
  }, []);

  return assistantName;
}
