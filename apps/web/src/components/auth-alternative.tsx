/** A button that switches the card in place, or a link to another page. */
type Action = { onClick: () => void; disabled?: boolean; href?: never } | { href: string; onClick?: never; disabled?: never };

/**
 * A muted line under a sign-in card offering the other way in. Where it switches the card rather than
 * going to another page it's a button, which waits while the card's form is signing in, so only one
 * sign-in is ever on its way. Either way its tap area grows to 44px on touch screens.
 */
export function AuthAlternative({ question, action, ...props }: { question: string; action: string } & Action) {
  const className = "relative cursor-pointer text-foreground underline underline-offset-3 touch:after:absolute touch:after:-inset-x-1 touch:after:-inset-y-3.5";
  return (
    <p className="mt-[22px] text-center text-[13px] text-muted-foreground">
      {question}{" "}
      {props.href === undefined ? (
        <button type="button" onClick={props.onClick} disabled={props.disabled} className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}>
          {action}
        </button>
      ) : (
        <a href={props.href} className={className}>
          {action}
        </a>
      )}
    </p>
  );
}
