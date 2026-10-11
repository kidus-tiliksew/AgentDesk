// The inbox's topic chips: every distinct topic of the listed decisions and
// agents, and each of its parent prefixes, sorted. For `acme/billing/invoices`
// the chips are `acme`, `acme/billing`, and `acme/billing/invoices`. A chip
// filters with the contract's `topicMatches`, the rule notification rules use
// (req-mobile-app AC-2.4).
export function topicChips(topics: Iterable<string>): string[] {
  const chips = new Set<string>();
  for (const topic of topics) {
    const parts = topic.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/");
      if (prefix !== "") {
        chips.add(prefix);
      }
    }
  }
  return [...chips].sort();
}
