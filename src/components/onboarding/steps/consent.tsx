import { useState } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import type { Consent } from '@/agent/settings';
import { OnboardingStep } from '../onboarding-shell';

export function ConsentStep({
  stepIndex,
  total,
  accepted,
  onAccepted,
}: {
  stepIndex: number;
  total: number;
  accepted: Consent | null;
  onAccepted: (c: Consent) => void;
}) {
  const [analyticsChecked, setAnalyticsChecked] = useState(false);
  const accept = useAsyncAction(async (analyticsOptIn: boolean) => {
    const next = await window.modmixer.acceptConsent({ analyticsOptIn });
    if (next.consent) onAccepted(next.consent);
  });

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Welcome"
      title="Welcome to Atlas"
      subtitle="Your portable workbench for building and improving RimWorld mods."
      canContinue={!accept.busy}
      continueLabel={
        accept.busy ? 'Accepting…' : accepted ? 'Continue' : 'Accept & continue'
      }
      onContinue={() => void accept.run(analyticsChecked)}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">Your projects, chats, and custom skills stay in this Atlas folder. Connect an AI provider to send it your instructions and selected project context. Atlas update checks use signed releases from your local update folder.</p>
        {accept.error && <p className="text-sm text-failed">{accept.error}</p>}
      </div>
    </OnboardingStep>
  );
}
