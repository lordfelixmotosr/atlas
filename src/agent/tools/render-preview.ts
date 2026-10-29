import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import path from 'node:path';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getWorkspacePaths } from '../workspace.js';
import { renderPreviewCandidate } from '../assets/preview-protection.js';
import {
  renderPreview,
  type PreviewParams,
} from './lib/preview-template-renderer.js';

const Params = Type.Object({
  template: Type.Union(
    [
      Type.Literal('classic'),
      Type.Literal('icon-left'),
      Type.Literal('banner'),
    ],
    {
      description:
        "Layout template. 'classic' = sprite + title + optional subtitle stacked centered (the default for most mods). 'icon-left' = sprite on the left, title and subtitle right (good when the sprite is iconic and you want title beside it). 'banner' = full-bleed sprite with the title in a footer band over a dark scrim (use for hero art / total-conversion vibes).",
    },
  ),
  title: Type.String({
    description:
      'The mod title. Required. Auto-fits to span the available width — short titles scale up huge, long titles wrap and shrink. Do not pre-truncate.',
  }),
  subtitle: Type.Optional(
    Type.String({
      description:
        'Optional small uppercase subtitle. Use sparingly: only when it adds genuine info ("Compatible with 1.5", "32 species", "Iron-age tech tweaks"). Omit otherwise. Never use it for "by Author".',
    }),
  ),
  outPath: Type.String({
    description:
      "Intended preview path, normally 'About/Preview.png'. Atlas always stages the rendered image privately as a proposal; this parameter cannot authorize overwriting the existing preview.",
  }),
  spritePath: Type.Optional(
    Type.String({
      description:
        "Path to a sprite/icon image (PNG/JPG/etc.). Relative paths resolve against the mod folder; absolute paths are also accepted. Must be inside the workspace. Omit for title-only on a gradient (e.g. an XML-only mod with no art).",
    }),
  ),
  background: Type.Optional(
    Type.String({
      description:
        "CSS background — either a color (`#1c2030`) or a gradient (`linear-gradient(160deg,#3a1d10 0%,#0d0d10 100%)`, `radial-gradient(circle at 30% 20%, #ff7a1a 0%, #7a1f00 55%, #0d0d10 100%)`). Pick a hue that fits the mod's tone. Defaults to a dark neutral. Ignored if `backgroundImagePath` is set.",
    }),
  ),
  backgroundImagePath: Type.Optional(
    Type.String({
      description:
        "Path to a full-bleed background image (typically a game screenshot the user supplied). Relative paths resolve against the mod folder; absolute paths are also accepted. Must be inside the workspace. When set, the image is rendered as `cover` behind the composition and the `background` color/gradient is ignored. A legibility scrim is added automatically so the title stays readable. Use this whenever the user has provided a background image — pick a `titleEffect` like `outline` or `shadow` to keep the title legible over the image.",
    }),
  ),
  titleColor: Type.Optional(
    Type.String({
      description:
        "CSS color for the title. Default white. Pair with `background`: warm titles (#fff2c2, #ffd6a0) on warm/dark backgrounds; cool (#dde7ff, #cfeaff) on cool. High contrast against background is non-negotiable.",
    }),
  ),
  subtitleColor: Type.Optional(
    Type.String({
      description: 'CSS color for the subtitle. Defaults to ~85% white.',
    }),
  ),
  titleFont: Type.Optional(
    Type.Union([Type.Literal('inter'), Type.Literal('rimworld')], {
      description:
        "Title font. 'rimworld' is the game-flavored display face — use it whenever the mod has a RimWorld feel (the default choice for most mods). 'inter' is a clean sans — use it for sci-fi, minimal, or modern-tech mods.",
    }),
  ),
  titleEffect: Type.Optional(
    Type.Union(
      [
        Type.Literal('none'),
        Type.Literal('shadow'),
        Type.Literal('outline'),
        Type.Literal('glow'),
      ],
      {
        description:
          "Title legibility treatment. 'outline' (dark stroke) is the most readable over busy/light backgrounds and pairs very well with the rimworld font. 'shadow' is a soft drop shadow — the safe default. 'glow' uses `accentColor` for a colored halo (good for sci-fi/sparks-flying vibes). 'none' only when the background is uniform and contrast is already strong.",
      },
    ),
  ),
  accentColor: Type.Optional(
    Type.String({
      description:
        "Accent color used by the `glow` effect. Pick a saturated color that complements the background (e.g. an orange glow on a dark scene).",
    }),
  ),
});

export interface RenderPreviewDetails {
  outPath: string;
  bytes: number;
  width: number;
  height: number;
  template: PreviewParams['template'];
  candidateId: string;
  pendingApproval: true;
}

/**
 * `cwd` is the active mod folder (the session's working directory); relative
 * `outPath` / `spritePath` / `backgroundImagePath` resolve against it. The
 * workspace dir is still handed to the renderer separately for bundled asset
 * lookup (fonts, templates), not for path resolution.
 */
export function createRenderPreviewTool(
  cwd: string,
): AgentTool<typeof Params, RenderPreviewDetails> {
  return {
  name: 'render_preview',
  label: 'Render preview image',
  description:
    "Prepare a proposed Steam Workshop preview image (1280×720) only when the user requests a preview change. Existing previews are preserved: Atlas stores the proposal privately and the user chooses Use this preview in Publish to apply it. Never use another file or shell tool to bypass this review. Pick 'classic', 'icon-left', or 'banner'; supply the title, optional sprite/background and effects. Bundled fonts: Inter and RimWorld. This tool does not authorize preview changes during unrelated coding, testing or publishing work.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<RenderPreviewDetails>> {
    const { workspaceDir } = getWorkspacePaths();

    const absOutPath = path.isAbsolute(params.outPath)
      ? params.outPath
      : path.resolve(cwd, params.outPath);
    assertPathAllowed(absOutPath, getPathPolicyRoots(), 'outPath');

    let absSpritePath: string | undefined;
    if (params.spritePath) {
      absSpritePath = path.isAbsolute(params.spritePath)
        ? params.spritePath
        : path.resolve(cwd, params.spritePath);
      assertPathAllowed(absSpritePath, getPathPolicyRoots(), 'spritePath');
    }

    let absBackgroundImagePath: string | undefined;
    if (params.backgroundImagePath) {
      absBackgroundImagePath = path.isAbsolute(params.backgroundImagePath)
        ? params.backgroundImagePath
        : path.resolve(cwd, params.backgroundImagePath);
      assertPathAllowed(
        absBackgroundImagePath,
        getPathPolicyRoots(),
        'backgroundImagePath',
      );
    }

    const proposal = await renderPreviewCandidate(cwd, outputPath => renderPreview(
      {
        template: params.template,
        title: params.title,
        subtitle: params.subtitle,
        spritePath: absSpritePath,
        background: params.background,
        backgroundImagePath: absBackgroundImagePath,
        titleColor: params.titleColor,
        subtitleColor: params.subtitleColor,
        titleFont: params.titleFont,
        titleEffect: params.titleEffect,
        accentColor: params.accentColor,
      },
      outputPath,
      { workspaceDir },
    ));
    const { width, height, bytes } = proposal.result;

    return {
      content: [
        {
          type: 'text',
          text: `Prepared a preview proposal at ${proposal.outPath} (${width}×${height} PNG, template=${params.template}). The existing preview is unchanged. Ask the user to review it in Publish → Preview image and choose Use this preview.`,
        },
      ],
      details: {
        outPath: proposal.outPath,
        bytes,
        width,
        height,
        template: params.template,
        candidateId: proposal.candidateId,
        pendingApproval: true,
      },
    };
  },
  };
}
