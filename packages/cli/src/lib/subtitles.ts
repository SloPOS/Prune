export function normalizeSubtitleTokens(raw: unknown): Array<{ id: string; text: string; startSec: number; endSec: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const token = item as Record<string, unknown>;
      const text = String(token.text ?? "").trim();
      const startSec = Number(token.startSec);
      const endSec = Number(token.endSec);
      if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
      return { id: String(token.id ?? `tok-${index}`), text, startSec, endSec };
    })
    .filter((v): v is { id: string; text: string; startSec: number; endSec: number } => Boolean(v))
    .sort((a, b) => a.startSec - b.startSec);
}

export function joinCaptionTokens(tokens: Array<{ text: string }>): string {
  const punctNoLeadSpace = /^[,.;:!?)]$/;
  const openersNoTrailSpace = /^[(]$/;
  let out = "";
  for (const token of tokens) {
    const text = token.text.trim();
    if (!text) continue;
    if (!out) out = text;
    else if (punctNoLeadSpace.test(text)) out += text;
    else if (openersNoTrailSpace.test(out.slice(-1))) out += text;
    else out += ` ${text}`;
  }
  return out.trim();
}

export function buildCaptionChunks(tokens: Array<{ text: string; startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number; text: string }> {
  if (tokens.length === 0) return [];

  const maxGapSec = 0.9;
  const maxDurationSec = 4.8;
  const maxChars = 42;
  const chunks: Array<{ startSec: number; endSec: number; text: string }> = [];
  let current: typeof tokens = [];

  const pushCurrent = () => {
    if (current.length === 0) return;
    const text = joinCaptionTokens(current);
    if (!text) {
      current = [];
      return;
    }
    chunks.push({
      startSec: current[0]!.startSec,
      endSec: Math.max(current[current.length - 1]!.endSec, current[0]!.startSec + 0.05),
      text,
    });
    current = [];
  };

  for (const token of tokens) {
    if (current.length === 0) {
      current.push(token);
      continue;
    }

    const prev = current[current.length - 1]!;
    const withToken = [...current, token];
    const nextText = joinCaptionTokens(withToken);
    const gapSec = token.startSec - prev.endSec;
    const durationSec = token.endSec - current[0]!.startSec;
    const endsSentence = /[.!?]["')\\]]?$/.test(joinCaptionTokens(current));
    const shouldSplit =
      gapSec > maxGapSec ||
      durationSec > maxDurationSec ||
      (nextText.length > maxChars && current.length >= 3) ||
      (endsSentence && durationSec >= 1.2);

    if (shouldSplit) pushCurrent();
    current.push(token);
  }
  pushCurrent();
  return chunks;
}

export function formatTime(sec: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${separator}${pad3(ms)}`;
}

export function buildSrt(chunks: Array<{ startSec: number; endSec: number; text: string }>): string {
  return chunks
    .map((c, i) => `${i + 1}\n${formatTime(c.startSec, ",")} --> ${formatTime(Math.max(c.endSec, c.startSec + 0.05), ",")}\n${c.text}\n`)
    .join("\n");
}

export function buildVtt(chunks: Array<{ startSec: number; endSec: number; text: string }>): string {
  const body = chunks
    .map((c) => `${formatTime(c.startSec, ".")} --> ${formatTime(Math.max(c.endSec, c.startSec + 0.05), ".")}\n${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
