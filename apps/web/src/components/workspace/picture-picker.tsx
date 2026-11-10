import type { ChangeEvent } from "react";
import { Camera } from "@/components/icons/iconoir";
import { cn } from "@/lib/utils";

/** Remove: Campfire's `.btn.txt-small`, in muted text, 44px tall for fingers. */
const REMOVE_BUTTON =
  "inline-flex cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-3 py-[0.5em] text-[0.8rem] font-medium text-muted-foreground disabled:cursor-default disabled:opacity-50 touch:min-h-11";

/** How big a picture field's circle is, and its camera. */
const SIZES = {
  /** 96px, as your avatar and the workspace's logo show. */
  large: { circle: "size-24", pixels: 96, camera: "size-9", icon: "size-[18px]" },
  /** 64px, beside what it's for, as @ember's avatar shows on its page. */
  small: { circle: "size-16", pixels: 64, camera: "size-7", icon: "size-4" },
};

interface FieldProps {
  /** The file field's id. */
  id: string;
  /** The picture to show: the one saved, or the one picked while it saves. */
  src: string;
  /** What the picture is. */
  alt: string;
  /** What the field is called, for screen readers. */
  label: string;
  /** Called with the file picked. */
  onChoose: (file: File) => void;
  /** Whether nothing can be picked, as while the page loads or saves. */
  disabled: boolean;
  size?: keyof typeof SIZES;
}

/**
 * A picture in a circle with a camera on its corner, which picks a picture to save at once, described by
 * what has the id `<id>-description`. The camera is white in dark mode, as the logo's is.
 */
export function PictureField({ id, src, alt, label, onChoose, disabled, size = "large" }: FieldProps) {
  const { circle, pixels, camera, icon } = SIZES[size];
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The field forgets it, so picking the same file again picks it again.
    event.target.value = "";
    if (file) onChoose(file);
  };
  return (
    <label
      htmlFor={id}
      className={cn(
        "group relative block flex-none cursor-pointer rounded-full has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-4 has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-foreground",
        circle,
      )}
    >
      <img src={src} alt={alt} width={pixels} height={pixels} className="size-full rounded-[inherit] border bg-surface object-cover" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute -end-0.5 -bottom-0.5 flex items-center justify-center rounded-full border bg-background shadow-[0_1px_3px_#0002] group-hover:bg-hover",
          camera,
        )}
      >
        <Camera className={icon} />
      </span>
      <input
        id={id}
        type="file"
        accept="image/*"
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onChange={choose}
        className="absolute inset-0 size-full cursor-pointer rounded-[inherit] opacity-0 disabled:cursor-default"
      />
      <span className="sr-only">{label}</span>
    </label>
  );
}

interface Props extends Omit<FieldProps, "size"> {
  /** What's said under the picture. */
  description: string;
  /** What Remove is called, where there's a picture to remove, and what it does. */
  remove: { label: string; onRemove: () => void } | null;
}

/**
 * The picture picker, which changes your avatar on your profile, and the workspace's logo in its
 * settings: the picture in a 96px circle with a camera on its corner (`PictureField`), a line saying what
 * to choose, and a button that removes the picture, where there's one to remove.
 */
export function PicturePicker({ description, remove, ...field }: Props) {
  return (
    <div className="mt-2 mb-4 grid justify-items-center gap-3">
      <PictureField {...field} />
      <p id={`${field.id}-description`} className="text-[0.8rem] text-muted-foreground">
        {description}
      </p>
      {remove && (
        <button type="button" disabled={field.disabled} onClick={remove.onRemove} className={REMOVE_BUTTON}>
          {remove.label}
        </button>
      )}
    </div>
  );
}
