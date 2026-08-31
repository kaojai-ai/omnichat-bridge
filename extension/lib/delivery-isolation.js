export async function deliverWithIsolation(messages, sendBatch, shouldSplit) {
  const delivered = [];
  const skipped = [];
  const failed = [];
  let blocked = null;

  async function visit(group) {
    if (!group.length || blocked) return;
    try {
      const result = await sendBatch(group);
      const skippedGroup = Array.isArray(result?.skipped) ? result.skipped : [];
      const skippedSet = new Set(skippedGroup);
      delivered.push(...group.filter((message) => !skippedSet.has(message)));
      skipped.push(...skippedGroup);
      return;
    } catch (error) {
      if (!shouldSplit(error)) {
        blocked = { messages: group, error };
        return;
      }
      if (group.length === 1) {
        failed.push({ message: group[0], error });
        return;
      }
      const middle = Math.ceil(group.length / 2);
      await visit(group.slice(0, middle));
      await visit(group.slice(middle));
    }
  }

  await visit(Array.isArray(messages) ? messages : []);
  return { delivered, skipped, failed, blocked };
}
