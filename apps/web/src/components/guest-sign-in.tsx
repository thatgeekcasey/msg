import { useState } from "react";
import type { Me } from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AuthLogo } from "@/components/auth-page";
import { ArrowRight, User as UserIcon } from "@/components/icons/iconoir";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInAsGuest } from "@/lib/api";

/**
 * Signing in with just a name, as someone new, which the sign-in card offers when EMBER_GUEST_SIGN_IN
 * allows it.
 */
export function GuestSignIn({ logo, onSignedIn, onUsePassword }: { logo: string | null; onSignedIn: (me: Me) => void; onUsePassword: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <div className="mb-7 text-center">
        <AuthLogo logo={logo} />
        <h1 className="mb-2 text-2xl leading-tight font-[650]">Welcome to Ember</h1>
        <p className="text-muted-foreground">Pick the name people will see next to your messages.</p>
      </div>
      <form
        className="flex flex-col gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onSignedIn(await signInAsGuest(name));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't sign in");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-[7px]">
          <label htmlFor="name" className="text-[13px] font-[550]">
            Your name
          </label>
          <div className="relative">
            <UserIcon className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground" />
            <Input
              id="name"
              autoFocus
              required
              maxLength={48}
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "name-error" : undefined}
              className="h-[42px] rounded-[9px] bg-background pl-9 text-sm shadow-none touch:h-11 touch:text-base"
            />
          </div>
          {error && (
            <p id="name-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy || !name.trim()} className="h-[42px] w-full rounded-[9px] font-[550] touch:h-11">
          Join <ArrowRight className="size-[18px]" />
        </Button>
      </form>
      <AuthAlternative question="Have an account?" action="Sign in" onClick={onUsePassword} disabled={busy} />
    </>
  );
}
