export interface SearchableChannel {
  name: string;
  type: string;
  otherUser?: {
    username?: string;
  };
}

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

const IN_MODIFIER_REGEX = /(^|\s)in:\S+/i;
const MODIFIER_TOKEN_REGEX = /(?:in|from|before|after|on|channel):\S+/gi;
const QUOTED_OR_WORD_REGEX = /"([^"]+)"|(\S+)/g;

export const hasExplicitInModifier = (query: string): boolean => IN_MODIFIER_REGEX.test(query);

export const buildChannelSearchTerms = (query: string, channel?: SearchableChannel): string => {
  const trimmed = query.trim();
  if (!trimmed) return '';
  if (!channel || hasExplicitInModifier(trimmed)) {
    return trimmed;
  }

  if (channel.type === 'D') {
    const username = channel.otherUser?.username?.replace(/^@/, '').trim();
    const scope = username ? `@${username}` : channel.name;
    return `in:${scope} ${trimmed}`;
  }

  return channel.name ? `in:${channel.name} ${trimmed}` : trimmed;
};

export const extractHighlightTerms = (query: string, serverMatches?: string[]): string[] => {
  const terms = new Set<string>();

  if (serverMatches) {
    for (const match of serverMatches) {
      const cleaned = match.trim();
      if (cleaned) terms.add(cleaned);
    }
  }

  const withoutModifiers = query.replace(MODIFIER_TOKEN_REGEX, ' ').trim();
  let match: RegExpExecArray | null = QUOTED_OR_WORD_REGEX.exec(withoutModifiers);
  while (match !== null) {
    const token = (match[1] ?? match[2] ?? '').replace(/^\*+|\*+$/g, '').trim();
    if (token.length >= 1) {
      terms.add(token);
    }
    match = QUOTED_OR_WORD_REGEX.exec(withoutModifiers);
  }
  QUOTED_OR_WORD_REGEX.lastIndex = 0;

  return [...terms].sort((a, b) => b.length - a.length);
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const splitHighlightedText = (text: string, terms: string[]): HighlightSegment[] => {
  if (!text) return [];
  const validTerms = terms.filter((t) => t.trim().length > 0);
  if (validTerms.length === 0) {
    return [{ text, highlighted: false }];
  }

  const pattern = new RegExp(`(${validTerms.map(escapeRegex).join('|')})`, 'gi');
  const parts = text.split(pattern);
  const lowerTerms = new Set(validTerms.map((t) => t.toLowerCase()));

  return parts
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      highlighted: lowerTerms.has(part.toLowerCase()),
    }));
};
