/** Steam stores version filters separately from the uploaded About.xml. */
const VERSION_TAG = /^(\d+)\.(\d+)(?:\.\d+){0,2}$/;

export function workshopTags(
  supportedVersions: readonly string[],
  existingTags: readonly string[] = [],
): string[] {
  const versions = supportedVersions.map((version) => {
    const match = version.trim().match(VERSION_TAG);
    if (!match) throw new Error(`Invalid RimWorld supported version: ${version}`);
    return `${Number(match[1])}.${Number(match[2])}`;
  });
  if (!versions.length) {
    throw new Error('Add at least one supported RimWorld version to About.xml before publishing.');
  }
  // Replace only version tags; retain categories the modder set on Steam.
  const tags = ['Mod', ...existingTags.filter((tag) => !VERSION_TAG.test(tag.trim())), ...versions];
  const seen = new Set<string>();
  return tags.map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface WorkshopTagReader {
  getItem(itemId: bigint, config: { cachedResponseMaxAge: number }): Promise<{
    tags: string[];
    tagsTruncated: boolean;
  } | null>;
}

export async function readWorkshopTags(
  workshop: WorkshopTagReader,
  itemId: bigint,
  timeoutMs = 20_000,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const item = await Promise.race([
      workshop.getItem(itemId, { cachedResponseMaxAge: 0 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Steam tag lookup timed out.')), timeoutMs);
      }),
    ]);
    if (!item || item.tagsTruncated !== false || !Array.isArray(item.tags) ||
        !item.tags.every((tag) => typeof tag === 'string')) {
      throw new Error('Steam did not return the complete Workshop tag list.');
    }
    return item.tags;
  } catch (error) {
    throw new Error(
      'Could not read the existing Workshop tags. Retry publishing when Steam is available. ' +
      'Atlas stopped before uploading to preserve your page tags.',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
