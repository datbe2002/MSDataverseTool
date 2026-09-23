// Turns a raw backend/ODBC error into the human-readable message only.
//
// Dataverse TDS errors look like:
//   [Microsoft][ODBC Driver 17 for SQL Server][SQL Server]{"Message":"Unexpected end of file occurred. Line:6, Position:29"}
//   RequestId: TDS;...
//   Time: 2026-...
// Web API errors look like {"error":{"message":"..."}}. We want just the
// sentence a user can act on.

export function friendlyError(raw: string): string {
  if (!raw) return "Something went wrong.";
  const message = extractMessage(raw.trim());

  // TDS timeouts: say what to do about them.
  if (/timeout period elapsed|TDS query timed out/i.test(message)) {
    return `${message} Try TOP / WHERE or fewer columns, or turn off "Use TDS endpoint" in Settings.`;
  }
  return message;
}

function extractMessage(s: string): string {
  // 1. A JSON payload with a Message / message / error.message field.
  const brace = s.indexOf("{");
  if (brace >= 0) {
    const candidate = s.slice(brace, s.lastIndexOf("}") + 1);
    try {
      const obj = JSON.parse(candidate);
      const msg = obj?.Message ?? obj?.message ?? obj?.error?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {
      /* not valid JSON — try the regex below */
    }
  }

  // 2. Pull "Message":"..." even when the surrounding text isn't valid JSON.
  const m = s.match(/"Message"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`).trim();
    } catch {
      return m[1].trim();
    }
  }

  // 3. Plain driver error: drop [bracketed] tags and the RequestId/Time trailer.
  const cleaned = s
    .split("\n")
    .filter((line) => !/^\s*(RequestId|Time)\s*:/i.test(line))
    .join(" ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || s;
}
