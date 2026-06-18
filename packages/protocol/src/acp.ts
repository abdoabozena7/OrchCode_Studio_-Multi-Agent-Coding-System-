export const ACP_VERSION = 1 as const;

export const ACP_FIELD_DICTIONARY = {
  G: "goal",
  C: "context",
  E: "evidence",
  R: "rules",
  I: "input",
  O: "output",
  Q: "question",
  B: "blocker",
  S: "status",
  CHG: "changed",
  T: "test",
  CTX: "context-ref"
} as const;

export const ACP_FIELD_ORDER = [
  "G",
  "C",
  "CTX",
  "E",
  "R",
  "I",
  "O",
  "S",
  "CHG",
  "T",
  "B",
  "Q"
] as const satisfies readonly AcpFieldKey[];

export const ACP_LIMITS = {
  maxPacketCharacters: 16_384,
  maxLines: 32,
  maxFieldCharacters: 4_096
} as const;

export type AcpFieldKey = keyof typeof ACP_FIELD_DICTIONARY;
export type AcpPriority = "L" | "M" | "H" | "C";

export type AcpPacket = {
  version: typeof ACP_VERSION;
  from: string;
  to: string;
  session: string;
  type: string;
  priority: AcpPriority;
  fields: Partial<Record<AcpFieldKey, string>>;
};

export type AcpValidationResult = {
  valid: boolean;
  errors: string[];
};

export type AcpParseResult = {
  ok: boolean;
  packet?: AcpPacket;
  errors: string[];
};

export type AcpSerializeOptions = {
  compactHeader?: boolean;
};

const ACP_FIELD_KEYS = new Set<string>(Object.keys(ACP_FIELD_DICTIONARY));
const ACP_PRIORITIES = new Set<string>(["L", "M", "H", "C"]);
const ENDPOINT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function parseAcpPacket(raw: string): AcpParseResult {
  const errors: string[] = [];
  const normalized = raw.replace(/\r\n?/g, "\n").trim();

  if (!normalized) {
    return { ok: false, errors: ["ACP packet is empty."] };
  }
  if (normalized.length > ACP_LIMITS.maxPacketCharacters) {
    errors.push(`ACP packet exceeds ${ACP_LIMITS.maxPacketCharacters} characters.`);
  }

  const lines = normalized.split("\n");
  if (lines.length > ACP_LIMITS.maxLines) {
    errors.push(`ACP packet exceeds ${ACP_LIMITS.maxLines} lines.`);
  }
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) errors.push(`Line ${index + 1} must not be blank.`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const header = parseHeader(lines[0] ?? "", errors);
  const fields: Partial<Record<AcpFieldKey, string>> = {};

  for (const [index, rawLine] of lines.slice(1).entries()) {
    const lineNumber = index + 2;
    const separator = rawLine.indexOf(":");
    if (separator < 1) {
      errors.push(`Line ${lineNumber} must use KEY:value syntax.`);
      continue;
    }

    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (!ACP_FIELD_KEYS.has(key)) {
      errors.push(`Line ${lineNumber} uses unknown ACP field "${key}".`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      errors.push(`Line ${lineNumber} repeats ACP field "${key}".`);
      continue;
    }
    validateFieldValue(key, value, errors, `Line ${lineNumber}`);
    fields[key as AcpFieldKey] = value;
  }

  if (Object.keys(fields).length === 0) {
    errors.push("ACP packet must contain at least one field.");
  }
  if (!header || errors.length > 0) return { ok: false, errors };

  const packet: AcpPacket = {
    version: ACP_VERSION,
    ...header,
    fields
  };
  const validation = validateAcpPacket(packet);
  return validation.valid
    ? { ok: true, packet, errors: [] }
    : { ok: false, errors: validation.errors };
}

export function serializeAcpPacket(packet: AcpPacket, options: AcpSerializeOptions = {}): string {
  const validation = validateAcpPacket(packet);
  if (!validation.valid) {
    throw new Error(`Invalid ACP packet: ${validation.errors.join(" ")}`);
  }

  const route = `${packet.from}>${packet.to}`;
  const header = options.compactHeader
    ? `${route}|${packet.session}|${packet.type}|${packet.priority}`
    : `M|${route}|${packet.session}|${packet.type}|${packet.priority}`;
  const fields = ACP_FIELD_ORDER.flatMap((key) => {
    const value = packet.fields[key];
    return value === undefined ? [] : [`${key}:${value}`];
  });
  return [header, ...fields].join("\n");
}

export function validateAcpPacket(packet: unknown): AcpValidationResult {
  const errors: string[] = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { valid: false, errors: ["ACP packet must be an object."] };
  }

  const value = packet as Record<string, unknown>;
  if (value.version !== ACP_VERSION) errors.push(`version must be ${ACP_VERSION}.`);
  validateToken("from", value.from, ENDPOINT_PATTERN, errors);
  validateToken("to", value.to, ENDPOINT_PATTERN, errors);
  validateToken("session", value.session, SESSION_PATTERN, errors);
  validateToken("type", value.type, TYPE_PATTERN, errors);
  if (typeof value.priority !== "string" || !ACP_PRIORITIES.has(value.priority)) {
    errors.push("priority must be L, M, H, or C.");
  }

  if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) {
    errors.push("fields must be an object.");
    return { valid: false, errors };
  }
  const fieldEntries = Object.entries(value.fields);
  if (fieldEntries.length === 0) errors.push("fields must contain at least one ACP field.");
  for (const [key, value] of fieldEntries) {
    if (!ACP_FIELD_KEYS.has(key)) {
      errors.push(`fields contains unknown ACP field "${key}".`);
      continue;
    }
    validateFieldValue(key, value, errors, "fields");
  }
  const packetCharacters = estimateCanonicalPacketCharacters(value, fieldEntries);
  if (packetCharacters > ACP_LIMITS.maxPacketCharacters) {
    errors.push(`ACP packet exceeds ${ACP_LIMITS.maxPacketCharacters} characters.`);
  }

  return { valid: errors.length === 0, errors };
}

export function serializeAcpDictionary(): string {
  return [
    `DICT ACP/${ACP_VERSION}`,
    ...ACP_FIELD_ORDER.map((key) => `${key}=${ACP_FIELD_DICTIONARY[key]}`)
  ].join("\n");
}

function parseHeader(
  rawHeader: string,
  errors: string[]
): Omit<AcpPacket, "version" | "fields"> | undefined {
  const parts = rawHeader.split("|").map((part) => part.trim());
  const full = parts.length === 5 && parts[0] === "M";
  const compact = parts.length === 4;
  if (!full && !compact) {
    errors.push("ACP header must use M|FROM>TO|SESSION|TYPE|PRIORITY or the compact form without M|.");
    return undefined;
  }

  const offset = full ? 1 : 0;
  const route = parts[offset] ?? "";
  const routeParts = route.split(">").map((part) => part.trim());
  if (routeParts.length !== 2) {
    errors.push("ACP header route must use FROM>TO.");
    return undefined;
  }

  const header = {
    from: routeParts[0] ?? "",
    to: routeParts[1] ?? "",
    session: parts[offset + 1] ?? "",
    type: parts[offset + 2] ?? "",
    priority: parts[offset + 3] as AcpPriority
  };
  validateToken("from", header.from, ENDPOINT_PATTERN, errors);
  validateToken("to", header.to, ENDPOINT_PATTERN, errors);
  validateToken("session", header.session, SESSION_PATTERN, errors);
  validateToken("type", header.type, TYPE_PATTERN, errors);
  if (!ACP_PRIORITIES.has(header.priority)) errors.push("priority must be L, M, H, or C.");
  return header;
}

function validateToken(label: string, value: unknown, pattern: RegExp, errors: string[]) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${label} contains invalid ACP token characters.`);
  }
}

function validateFieldValue(key: string, value: unknown, errors: string[], prefix: string) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${prefix} field "${key}" must have a non-empty string value.`);
    return;
  }
  if (/[\r\n]/.test(value)) errors.push(`${prefix} field "${key}" must stay on one line.`);
  if (value.length > ACP_LIMITS.maxFieldCharacters) {
    errors.push(`${prefix} field "${key}" exceeds ${ACP_LIMITS.maxFieldCharacters} characters.`);
  }
}

function estimateCanonicalPacketCharacters(
  packet: Record<string, unknown>,
  fields: Array<[string, unknown]>
) {
  const header = `M|${String(packet.from)}>${String(packet.to)}|${String(packet.session)}|${String(packet.type)}|${String(packet.priority)}`;
  return fields.reduce((length, [key, value]) => (
    length + 1 + key.length + 1 + (typeof value === "string" ? value.length : 0)
  ), header.length);
}
