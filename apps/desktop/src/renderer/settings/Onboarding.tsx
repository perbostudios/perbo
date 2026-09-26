import { useState } from "react";
import { Brand, Button, Notice, ProgressDots } from "../ui/index.js";
import { errorMessage, useAction } from "../workspace/index.js";
import type { PageProps } from "../shell/route.js";
import { PERSON_NAME_MAX_CHARS } from "../../shared/protocol.js";
import { ProviderScreen, RepositoryScreen } from "./ConnectionScreens.js";

export function Onboarding(props: PageProps) {
  const { workspace, navigate } = props;
  const [step, setStep] = useState(workspace.settings.name ? 2 : 1),
    [name, setName] = useState(workspace.settings.name);
  const action = useAction();
  if (step === 2)
    return <ProviderScreen {...props} setup onDone={() => setStep(3)} />;
  if (step === 3)
    return (
      <RepositoryScreen
        {...props}
        setup
        onDone={() => {
          void action
            .mutateAsync({
              kind: "saveSettings",
              settings: { ...workspace.settings, onboardingComplete: true },
            })
            .then(() => navigate({ page: "home" }))
            .catch(() => undefined);
        }}
      />
    );
  return (
    <form
      className="name-page"
      data-screen="s1"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim())
          void action
            .mutateAsync({
              kind: "saveSettings",
              settings: { ...workspace.settings, name: name.trim() },
            })
            .then(() => setStep(2))
            .catch(() => undefined);
      }}
    >
      <div className="name-header">
        <Brand wordmark />
        <ProgressDots setup step={1} />
      </div>
      <div className="name-entry">
        <h1>Hi,</h1>
        <input
          aria-label="Your name"
          placeholder="your name"
          maxLength={PERSON_NAME_MAX_CHARS}
          autoComplete="given-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p>
          Used on your own machine and on the tickets you admit. Nothing is sent
          anywhere yet — there is no account to create.
        </p>
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
      <div className="name-footer">
        <span className="mono muted">↵</span>
        <Button
          variant="primary"
          type="submit"
          disabled={!name.trim() || action.isPending}
        >
          Continue
        </Button>
      </div>
    </form>
  );
}
