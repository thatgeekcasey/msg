/** Test user `n`'s id, shaped like Ember's: 16 base-36 characters, as the Worker's `sortableId` makes them. */
export const testUserId = (n: number): string => n.toString(36).padStart(16, "0");

/** Test users by id, and a mention resolver that finds them by their sgid. */
export function testUsers(...names: string[]) {
  const users = new Map(names.map((name, i) => [testUserId(i + 1), { id: testUserId(i + 1), name }]));
  return { users, resolve: (sgid: string) => users.get(sgid) };
}
