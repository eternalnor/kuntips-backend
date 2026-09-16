import { Filter } from "bad-words";

const filter = new Filter();

// Norwegian supplement — bad-words covers English only
const NORWEGIAN_BLOCKED: string[] = [
  "faen", "faens", "faan",
  "jævla", "jævlan", "jævlig",
  "helvete", "helvede",
  "kuk", "kuken",
  "fitte", "fitta",
  "ræv", "reva",
  "drittunge", "dritt",
  "hestkuk", "kuksuger",
  "neger", "negern",
  "ludder", "hore",
  "idiot", "tulling", "dust",
  "føkk", "føkking",
  "fy faen",
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsNorwegianBlocked(text: string): boolean {
  const norm = normalise(text);
  return NORWEGIAN_BLOCKED.some((term) => {
    const pattern = "\\b" + normalise(term).replace(/\s+/g, "\\s+") + "\\b";
    return new RegExp(pattern, "i").test(norm);
  });
}

/**
 * Returns true if the text contains profanity or blocked content.
 * Uses bad-words (English) + a Norwegian supplement.
 */
export function containsBlockedContent(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  try {
    return filter.isProfane(text) || containsNorwegianBlocked(text);
  } catch {
    return containsNorwegianBlocked(text);
  }
}
