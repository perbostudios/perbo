import { PageHeader } from "../ui/index.js";
import { ProviderScreen, RepositoryScreen } from "./ConnectionScreens.js";
import { ConnectionsPage } from "./ConnectionsPage.js";
import { GeneralPage } from "./GeneralPage.js";
import { UsagePage } from "./UsagePage.js";
import { ShortcutsPage } from "./ShortcutsPage.js";
import { AboutPage } from "./AboutPage.js";
import type { PageProps, SettingsSection } from "../shell/App.js";

/** Settings (S6): three tabs in the rail's pill — General, Usage, Connections — and the pages one level down from them. */
export function SettingsPage({
  workspace,
  navigate,
  section,
}: PageProps & { section: SettingsSection }) {
  const props = { workspace, navigate };
  if (section === "providers" || section === "repositories")
    return (
      <section className="screen">
        <PageHeader
          crumbs={[
            "Settings",
            "Connections",
            section === "providers" ? "Add a provider" : "Add a repository",
          ]}
          subtitle={
            section === "providers"
              ? "checked against the provider the moment you connect"
              : undefined
          }
        />
        {section === "providers" ? (
          <ProviderScreen {...props} onDone={() => navigate({ page: "connections" })} />
        ) : (
          <RepositoryScreen {...props} onDone={() => navigate({ page: "connections" })} />
        )}
      </section>
    );
  if (section === "usage") return <UsagePage {...props} />;
  if (section === "connections") return <ConnectionsPage {...props} />;
  if (section === "shortcuts") return <ShortcutsPage {...props} />;
  if (section === "about") return <AboutPage {...props} />;
  return <GeneralPage {...props} />;
}
