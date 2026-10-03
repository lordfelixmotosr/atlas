import {
  baseLoreDir,
  communityLoreDir,
  deleteUserEntries,
  isLoreTopicForGame,
  readAllUserEntries,
  seedAllCommunityLoreFromShipped,
  writeCommunityLore,
  type LoreTopic,
} from './lore.js';
import { loadSettings, saveSettings } from './settings.js';
import type { GameId } from './games/types.js';
import { isGameId } from './games/registry.js';

// Publishable Supabase credentials — designed to ship in clients. Rotation
// is independent of any user-level secret. Keep these in sync with the
// Supabase project that owns the lore_submissions / community_lore tables.
const SUPABASE_URL = 'https://hietsknsycjlcrvfgqaz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_hNFzBbls5cjR-Huc80KJdA_4OIocei5';

interface CommunityLoreRow {
  topic: string;
  hook: string;
  markdown: string;
}

function authHeaders(): Record<string, string> {
  // Only the apikey header — the publishable key is not a JWT, and
  // putting it in Authorization: Bearer makes Supabase try (and fail) to
  // decode it as a user token, which drops the request onto a role with
  // no RLS policies attached.
  return {
    apikey: SUPABASE_ANON_KEY,
  };
}

async function pushUserLore(deviceId: string, game: GameId): Promise<number> {
  const entries = await readAllUserEntries(game);
  if (entries.length === 0) return 0;
  const rows = entries.map((e) => ({
    device_id: deviceId,
    // RimWorld and Minecraft share topic names (recipes, build, test-loop, …),
    // so `game` is part of the row identity (it's in the PK), not just a label.
    game,
    topic: e.topic,
    hook: e.hook,
    markdown: e.markdown,
    // Per-entry authoring attribution, parsed from the `<sub>` footer
    // `saveEntry` writes. Null for entries authored before the stamp
    // existed — those have to be re-verified from scratch by the
    // lore-review skill.
    client_model: e.clientModel ?? null,
  }));
  const res = await fetch(
    // Target the primary key explicitly: (game, device_id, topic, hook).
    `${SUPABASE_URL}/rest/v1/lore_submissions?on_conflict=game,device_id,topic,hook`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        // UPSERT semantics — replace the existing row for the same key.
        // `return=minimal` skips the response body.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    throw new Error(
      `push failed (${game}): ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  return rows.length;
}

async function pullCommunityLore(
  game: GameId,
): Promise<Array<{ topic: LoreTopic; hook: string; markdown: string }>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/community_lore?game=eq.${game}&select=topic,hook,markdown`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `pull failed (${game}): ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const rows = (await res.json()) as CommunityLoreRow[];
  return rows
    .filter((r) => isLoreTopicForGame(r.topic, game))
    .map((r) => ({
      topic: r.topic as LoreTopic,
      hook: r.hook,
      markdown: r.markdown,
    }));
}

/**
 * Ask the server which of this device's submissions have reached a
 * terminal review state — meaning the local user-tier copy can be
 * pruned. The RPC filters to `verified, dup, rejected, meta, auto_filter`
 * (verified/dup are now served from community_lore and arrive via the
 * pull; the rest were judged not-to-be-kept); `pending` and `needs_edit`
 * are still in flight and are deliberately excluded.
 *
 * Returns each hook's `game` so the prune deletes the right game's local
 * copy — topic+hook alone is ambiguous now that the taxonomies overlap.
 *
 * It's a SECURITY DEFINER RPC so the anon role can read its own rows'
 * status without a table-wide SELECT policy exposing every submission's
 * markdown/review_notes (see the migration that defines it).
 */
async function fetchReviewedHooks(
  deviceId: string,
): Promise<
  Array<{ game: GameId; topic: LoreTopic; hook: string; reviewedAt?: string }>
> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reviewed_lore_hooks`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_device_id: deviceId }),
  });
  if (!res.ok) {
    throw new Error(
      `reviewed-hooks fetch failed: ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const rows = (await res.json()) as Array<{
    game: string;
    topic: string;
    hook: string;
    reviewed_at: string | null;
  }>;
  return rows
    .filter((r) => isGameId(r.game) && isLoreTopicForGame(r.topic, r.game))
    .map((r) => ({
      game: r.game as GameId,
      topic: r.topic as LoreTopic,
      hook: r.hook,
      reviewedAt: r.reviewed_at ?? undefined,
    }));
}

/**
 * Push the user's local lore, then pull the curated community lore and
 * write it into the local cache — once per game. Each game and each half
 * (push / pull) is independent, so one game's or one half's failure never
 * blocks the rest. The toggle gate is checked here so callers can fire this
 * unconditionally on startup.
 */
export async function syncCommunityLore(): Promise<void> { return; /* Atlas uses signed local reference packs. */ }
