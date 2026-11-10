import {
  ANSWER_LENGTHS,
  ANSWER_WORDS,
  LEVEL_NAMES,
  THINKING_LEVELS,
  THINKING_TOKENS,
  type AnswerLength,
  type AnswerLevelChanges,
  type AnswerLevels,
  type ThinkingLevel,
} from "@ember/protocol/assistant";

// The two dials of @ember's answers, each a row of radio buttons: how much it thinks before it answers,
// and how long its answers are. A choice applies at once. The AI assistant tab sets the most each goes to
// for anyone's questions, and each person's profile their own levels, up to that.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What each level of thinking does, which its dial says under it. */
const THINKING_NOTES: Record<ThinkingLevel, string> = {
  off: "Answers at once, without thinking first.",
  low: `Thinks a little first, up to about ${THINKING_TOKENS.low.toLocaleString("en-US")} tokens.`,
  medium: `Thinks more first, up to about ${THINKING_TOKENS.medium.toLocaleString("en-US")} tokens.`,
  high: `Thinks the most first, up to about ${THINKING_TOKENS.high.toLocaleString("en-US")} tokens, which takes longest.`,
};

/** How long each length's answers are, which its dial says under it. */
const LENGTH_NOTES: Record<AnswerLength, string> = {
  short: `About ${ANSWER_WORDS.short} words.`,
  medium: `About ${ANSWER_WORDS.medium} words.`,
  long: `About ${ANSWER_WORDS.long.toLocaleString("en-US")} words, nearly all one message holds.`,
};

interface Props {
  /** What the dials' radio buttons are named after, unique on the page. */
  name: string;
  levels: AnswerLevels;
  /** The most each dial may go to, above which its levels can't be chosen, or none to allow every level. */
  most?: AnswerLevels;
  disabled?: boolean;
  onChange: (changes: AnswerLevelChanges) => void;
}

/** The Thinking and Answer length dials, set at `levels`. */
export function LevelDials({ name, levels, most, disabled = false, onChange }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <Dial
        name={`${name}-thinking`}
        legend="Thinking"
        order={THINKING_LEVELS}
        chosen={levels.thinking}
        highest={most?.thinking}
        note={THINKING_NOTES[levels.thinking]}
        disabled={disabled}
        onChoose={(thinking) => onChange({ thinking })}
      />
      <Dial
        name={`${name}-length`}
        legend="Answer length"
        order={ANSWER_LENGTHS}
        chosen={levels.length}
        highest={most?.length}
        note={LENGTH_NOTES[levels.length]}
        disabled={disabled}
        onChoose={(length) => onChange({ length })}
      />
    </div>
  );
}

interface DialProps<T extends ThinkingLevel | AnswerLength> {
  name: string;
  legend: string;
  order: readonly T[];
  chosen: T;
  highest: T | undefined;
  note: string;
  disabled: boolean;
  onChoose: (level: T) => void;
}

/** One dial: its levels in `order`, `chosen` checked, none above `highest`, and what the chosen one does under them. */
function Dial<T extends ThinkingLevel | AnswerLength>({ name, legend, order, chosen, highest, note, disabled, onChoose }: DialProps<T>) {
  const top = highest === undefined ? order.length - 1 : order.indexOf(highest);
  return (
    <fieldset aria-describedby={`${name}-note`} className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-semibold">{legend}</legend>
      <div className="flex w-fit max-w-full flex-wrap rounded-[8px] border bg-background p-0.5">
        {order.map((level, index) => (
          <label
            key={level}
            className="relative cursor-pointer rounded-[6px] px-3 py-1 text-sm hover:bg-hover has-checked:bg-hover has-checked:font-semibold has-disabled:cursor-default has-disabled:opacity-50 has-disabled:hover:bg-transparent has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-foreground touch:min-h-11 touch:py-2.5"
          >
            <input
              type="radio"
              name={name}
              value={level}
              checked={chosen === level}
              disabled={disabled || index > top}
              onChange={() => onChoose(level)}
              className="absolute size-px opacity-0 [clip-path:inset(50%)]"
            />
            {LEVEL_NAMES[level]}
          </label>
        ))}
      </div>
      <p id={`${name}-note`} className={NOTE}>
        {note}
      </p>
    </fieldset>
  );
}
