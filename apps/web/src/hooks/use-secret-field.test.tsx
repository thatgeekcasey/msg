import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useSecretField } from "./use-secret-field";

/** A form that keeps a secret as it's typed, which Clear clears and Put back puts back, and that a step can take away. */
function Form() {
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(true);
  return (
    <>
      {shown && <Secret typed={typed} onType={setTyped} />}
      <button type="button" onClick={() => setTyped("")}>
        Clear
      </button>
      <button type="button" onClick={() => setTyped("re_kept")}>
        Put back
      </button>
      <button type="button" onClick={() => setShown(!shown)}>
        {shown ? "Next" : "Back"}
      </button>
      <output>{typed}</output>
    </>
  );
}

function Secret({ typed, onType }: { typed: string; onType: (typed: string) => void }) {
  const field = useSecretField(typed);
  return <input aria-label="API key" ref={field} onChange={(event) => onType(event.target.value)} />;
}

const field = () => screen.getByRole("textbox", { name: "API key" });
const button = (name: string) => screen.getByRole("button", { name });

describe("A secret's field", () => {
  it("keeps what's typed out of its value attribute, where custom CSS could read it", async () => {
    render(<Form />);
    const user = userEvent.setup();
    await user.type(field(), "re_123");
    expect(field()).toHaveValue("re_123");
    expect(field()).not.toHaveAttribute("value");
    expect(screen.getByRole("status")).toHaveTextContent("re_123");
  });

  it("shows what the form has once the form clears it, puts it back, or shows it again", async () => {
    render(<Form />);
    const user = userEvent.setup();
    await user.type(field(), "re_123");
    await user.click(button("Clear"));
    expect(field()).toHaveValue("");
    await user.click(button("Put back"));
    expect(field()).toHaveValue("re_kept");

    await user.click(button("Next"));
    await user.click(button("Back"));
    expect(field()).toHaveValue("re_kept");
    expect(field()).not.toHaveAttribute("value");
  });
});
