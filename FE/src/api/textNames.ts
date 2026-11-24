export type RosterName = { child_id: string; name: string };

const token = /⟦C:([0-9a-f-]{36})⟧/g;
export function hasNameToken(text: string) {
  return text.includes('⟦C:');
}

const marker = (childId: string) => '⟦C:' + childId + '⟧';
const escapeRegex = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function textNames(roster: RosterName[]) {
  const names = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const child of roster) {
    const name = child.name.normalize('NFC').trim();
    if (!name) continue;
    names.set(child.child_id, name);
    const variants = /^[가-힣]{3}$/.test(name) ? [name, name.slice(1)] : [name];
    for (const variant of variants) {
      children.set(variant, [...(children.get(variant) ?? []), child.child_id]);
    }
  }
  const alternatives = [...children.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  const people = new RegExp(token.source + (alternatives.length ? '|' + alternatives.join('|') : ''), 'g');
  return {
    encode(text: string, owner?: string | null): string {
      return text.normalize('NFC').replace(people, (matched, existing: string | undefined) => {
        if (existing) return names.has(existing) ? matched : '아동';
        const ids = children.get(matched) ?? [];
        const id = ids.length === 1 ? ids[0] : owner && ids.includes(owner) ? owner : null;
        return id ? marker(id) : '아동';
      });
    },
    restore(text: string, formatName: (name: string) => string = name => name): string {
      return text.replace(token, (_token, id: string) => formatName(names.get(id) ?? '아동'));
    },
  };
}
