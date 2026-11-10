import { INVITATION_GONE, type Me } from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AuthCard, AuthHeading, AuthPage, type SignedOutWorkspace } from "@/components/auth-page";
import { JoinPage } from "@/components/join-page";
import { useEmailLink, useLinksOpened } from "@/hooks/use-email-link";
import { useTitle } from "@/hooks/use-title";

// The page for an invitation's link, which holds its secret in the fragment: it looks the link up, as
// `useEmailLink` does, and shows the join form with the address it's for, or says the link doesn't work.

interface Props {
  workspace: SignedOutWorkspace;
  onJoined: (me: Me) => void;
}

/** The join page for the invitation whose link opened it, once it's looked up. */
export function InvitationPage(props: Props) {
  return <InvitationLookup key={useLinksOpened()} {...props} />;
}

/** Looks up the invitation whose secret is in the address's fragment, then shows its join form, or says it doesn't work. */
function InvitationLookup({ workspace, onJoined }: Props) {
  const [invitation, gone] = useEmailLink("invitation");
  if (invitation === "looking") return <main aria-busy="true" className="min-h-dvh bg-surface" />;
  if (invitation === "none" || invitation === "gone") return <InvitationGone workspace={workspace} />;
  return <JoinPage workspace={workspace} joinCode={null} emailLink={invitation} onGone={gone} onJoined={onJoined} />;
}

/** What an invitation's link that doesn't work opens: why, and sign-in, for someone with an account. */
function InvitationGone({ workspace }: { workspace: SignedOutWorkspace }) {
  useTitle("Sign up");
  return (
    <AuthPage workspace={workspace}>
      <AuthCard>
        <AuthHeading title={`Join ${workspace.account.name}`} logo={workspace.account.logo}>
          {INVITATION_GONE}
        </AuthHeading>
        <AuthAlternative question="Already have an account?" action="Sign in" href="/session/new" />
      </AuthCard>
    </AuthPage>
  );
}
